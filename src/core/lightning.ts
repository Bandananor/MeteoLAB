import { ElectricSolver, EPSILON0 } from './electric'
import type { Grid } from './grid'
import { mulberry32 } from './math'

// Lightning, 2.3 step 3: the branched bidirectional discharge of Mansell et al. (2002), in the form of Mansell et al.
// (2010): a flash starts where the field exceeds the runaway breakdown threshold, its channel grows node by node through
// the grid while the field between the channel and the air ahead exceeds a fraction of that threshold, the channel is a
// conductor at one potential that keeps it neutral, and at the end it deposits charge that neutralizes the storm's charge
// along it. A channel that reaches the ground is a cloud-to-ground flash: its potential drops to zero and the ground
// supplies the difference.

/** Runaway breakdown field at sea-level density (Dwyer 2003), V/m; scaled with the air density. */
export const E_INIT = 2.84e5
/** Air density of the standard atmosphere at sea level, kg/m³. */
export const RHO_STANDARD = 1.225
/** Channel propagation threshold as a share of the initiation field (Mansell et al. 2010: 0.43). */
export const F_CRIT = .43
/** Charge density below which the air counts as clear, C/m³: the channel grows only down through it (to the ground). */
export const RHO_MIN = 1e-10
/** Radius of the lightning channel, m (only its logarithm matters: the capacitance per node). */
export const CHANNEL_RADIUS = 1
/**
 * Share of a lone segment's capacitance a channel node keeps: the nodes of a channel shield one another (a branched
 * conductor's capacitance grows with its size, not with the length of its branches; Mansell et al. solve for it with
 * the channel in the Poisson equation, too slow here). Calibrated on the classic supercell: IC flashes then neutralize
 * 5-15 C of each sign, as in Mansell et al. (2010, Table 1: 6.6-15.5 C), at 10-20 flashes a minute (with 1: 20-60 C,
 * 2-3 a minute).
 */
export const SHIELDING = .25
/** Most nodes a channel may have. */
export const MAX_CHANNEL = 3000
/** Most flashes per model step: each re-solves the field; the storm keeps discharging on the next steps if needed. */
export const MAX_FLASHES = 10

export interface Flash {
  /** Model time, s. */
  time: number
  /** IC: inside the cloud (and to the clear air); CG: the channel reached the ground. */
  kind: 'IC' | 'CG'
  /** Grid node where the breakdown started, and the channel's nodes in growth order (the first is the initiation node). */
  start: number
  nodes: Int32Array
  /** For each channel node, the index in `nodes` of the node it grew from (-1 for the first). */
  parent: Int32Array
  /** For each node, the leader polarity: +1 positive (it went into negative charge), -1 negative, 0 none (potential equal). */
  polarity: Int8Array
  /** Channel potential when it stopped growing (CG: before it touched the ground), V. */
  potential: number
  /**
   * IC: charge of each sign neutralized, C (positive). CG: charge lowered to the ground, C, with its sign (a usual
   * negative CG brings negative charge down: < 0).
   */
  charge: number
  /** CG: the node where the channel touched the ground; -1 for IC. */
  ground: number
}

/**
 * Where to draw a flash's channel, m from the domain corner (x, y, z per node, in the order of `nodes`): each node
 * shifted at random by up to a third of its cell, the same shifts every time for the same flash, so the 3D view and
 * the detector's map draw one channel that does not follow the grid.
 */
export function channelShape(grid: Grid, flash: Flash) {
  const { nx, layer, dx, dy, zs, dzs } = grid, rng = mulberry32(Math.round(flash.time * 10) + flash.start), shape = new Float64Array(flash.nodes.length * 3)
  flash.nodes.forEach((i, c) => {
    const z = Math.floor(i / layer), y = Math.floor((i - z * layer) / nx), x = i - z * layer - y * nx, h = dzs[Math.min(z, dzs.length - 1)]
    shape[c * 3] = (x + (rng() - .5) * .7) * dx; shape[c * 3 + 1] = (y + (rng() - .5) * .7) * dy; shape[c * 3 + 2] = z === 0 ? 0 : zs[z] + (rng() - .5) * .7 * h
  })
  return shape
}

/**
 * Electric field and discharges of the storm charge. The charge carriers are the model's four fields (C/kg); flashes
 * change them in place, exactly conserving the charge (with what the CG flashes take from the ground: `fromGround`).
 */
export class Lightning {
  readonly grid: Grid
  readonly solver: ElectricSolver
  /** Net charge density at the nodes, C/m³, and its potential, V (the last solve). */
  readonly rho: Float64Array; readonly phi: Float64Array
  /** Charge the flashes have taken from the ground since the start, C (a negative CG takes positive charge up: > 0). */
  fromGround = 0
  private readonly air: ArrayLike<number>
  /** Initiation field of each level, V/m, and the capacitance of a node of each level, F. */
  private readonly eInit: Float64Array; private readonly capacitance: Float64Array
  private readonly mark: Int32Array; private readonly failed: Int32Array; private flashId = 0
  /** Random numbers of the channel growth: started afresh at every discharge from the seed and the model time, so a run continued from a saved state flashes exactly as the original. */
  private rng: () => number; private readonly seed: number
  /**
   * Growth front of the flash: the nodes beside the channel it may grow into, with the shortest link to each (its
   * length times the propagation threshold, V) and the channel node it comes from.
   */
  private readonly frontier: Int32Array; private readonly weight: Float64Array; private size = 0
  private readonly seen: Int32Array; private readonly scale: Float64Array; private readonly link: Int32Array

  /** `air`: the air density of each level, kg/m³. */
  constructor(grid: Grid, air: ArrayLike<number>, seed = 1) {
    this.grid = grid; this.air = air
    this.solver = new ElectricSolver(grid)
    this.rho = new Float64Array(grid.n); this.phi = new Float64Array(grid.n)
    this.eInit = Float64Array.from({ length: grid.nz }, (_, z) => E_INIT * air[z] / RHO_STANDARD)
    // A node's channel is a thin conductor as long as the cell (L, the cube root of its volume): 2π ε0 L / ln(L / r),
    // lowered by the shielding of the channel's other nodes.
    this.capacitance = Float64Array.from(grid.hz, h => { const L = Math.cbrt(grid.dx * grid.dy * h); return SHIELDING * 2 * Math.PI * EPSILON0 * L / Math.log(L / CHANNEL_RADIUS) })
    this.mark = new Int32Array(grid.n); this.failed = new Int32Array(grid.n)
    this.seed = seed; this.rng = mulberry32(seed)
    this.frontier = new Int32Array(grid.n); this.weight = new Float64Array(grid.n)
    this.seen = new Int32Array(grid.n); this.scale = new Float64Array(grid.n); this.link = new Int32Array(grid.n)
  }

  /** Fills `rho` from the carriers (C/kg) and solves for `phi`. */
  solve(carriers: readonly ArrayLike<number>[]) {
    const { nz, layer } = this.grid
    for (let z = 0, i = 0; z < nz; z++) for (let e = i + layer; i < e; i++) { let s = 0; for (const c of carriers) s += c[i]; this.rho[i] = s * this.air[z] }
    this.solver.solve(this.rho, this.phi)
  }

  /** The node (interior levels, not those that failed this step) where |E| / Einit is largest, and that ratio (from the last solve). */
  strongest(stamp = -1): [number, number] {
    const { nx, ny, nz, layer, dx, dy, zs, xp, xm, yp, ym } = this.grid, phi = this.phi
    let best = -1, ratio = 0
    for (let z = 1; z < nz - 1; z++) {
      const dz = zs[z + 1] - zs[z - 1], limit2 = this.eInit[z] ** 2
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const i = x + y * nx + z * layer, row = y * nx + z * layer
        const ex = (phi[xp[x] + row] - phi[xm[x] + row]) / (2 * dx), ey = (phi[x + yp[y] + z * layer] - phi[x + ym[y] + z * layer]) / (2 * dy), ez = (phi[i + layer] - phi[i - layer]) / dz
        const r = (ex * ex + ey * ey + ez * ez) / limit2
        if (r > ratio && this.failed[i] !== stamp) { ratio = r; best = i }
      }
    }
    return [best, Math.sqrt(ratio)]
  }

  /**
   * Discharges the storm: while the field somewhere exceeds the initiation threshold (and at most MAX_FLASHES times),
   * one flash there. `carriers` are the charge fields, C/kg (changed in place); returns the flashes.
   */
  discharge(carriers: readonly Float32Array[], time: number): Flash[] {
    const flashes: Flash[] = [], stamp = ++this.flashId
    this.rng = mulberry32(this.seed ^ Math.imul(Math.round(time * 10), 0x9E3779B1))
    for (let k = 0; k < MAX_FLASHES; k++) {
      this.solve(carriers)
      const [start, ratio] = this.strongest(stamp)
      if (ratio <= 1) break
      const flash = this.flash(start, carriers, time)
      // A breakdown that could not grow into charge to neutralize (a strong field over clear air) is not a flash; that
      // node is left out for the rest of this step.
      if (flash.charge === 0) { this.failed[start] = stamp; continue }
      flashes.push(flash)
    }
    return flashes
  }

  /** One flash from node `start`: grows the channel, deposits its charge; uses the potential of the last solve. */
  flash(start: number, carriers: readonly Float32Array[], time: number): Flash {
    const { layer, dx, dy } = this.grid, phi = this.phi, id = ++this.flashId, { frontier, weight, scale, link } = this
    const nodes: number[] = [], parent: number[] = []
    let sum = 0, potential = 0, ground = -1, before = 0
    this.size = 0
    const add = (j: number, from: number) => {
      this.mark[j] = id; nodes.push(j); parent.push(from)
      if (j < layer) {
        // The ground: a CG. The channel takes the ground's potential and the breakdown goes on until it quenches itself.
        ground = j; before = potential; potential = 0
        return
      }
      // Until then the channel is neutral: its potential is the mean of the potentials around it (equal capacitance per node).
      if (ground < 0) { sum += phi[j]; potential = sum / nodes.length }
      this.extend(j, nodes.length - 1, id)
    }
    add(start, -1)
    while (nodes.length < MAX_CHANNEL) {
      // Every link from the channel to a node beside it where the field, channel to air, exceeds the propagation
      // threshold; one is chosen with probability in proportion to how far it exceeds it. In clear air only the leader
      // heading for the ground's potential goes on (Mansell et al. 2010: the tip must keep the sign that connects to
      // the ground), and there is one ground contact per flash. Once the channel has touched the ground (its potential
      // 0) it grows only into the charge of the region its leader came from (the potential of the sign it had before):
      // the return strokes and what follows drain that region; growing into both signs, a CG took 60-90% of its nodes
      // after the contact, 40-130 C and sometimes the opposite polarity (the meteorologist's review 14.10.2026).
      let total = 0
      for (let f = 0; f < this.size; f++) {
        const j = frontier[f], clear = Math.abs(this.rho[j]) < RHO_MIN
        const w = (ground >= 0 && (j < layer || phi[j] * before <= 0)) || (clear && (phi[j] - potential) * potential >= 0) ? 0 : Math.abs(potential - phi[j]) / scale[j] - 1
        weight[f] = w > 0 ? w : 0; total += weight[f]
      }
      if (total === 0) break
      let pick = this.rng() * total, n = 0
      while (n < this.size - 1 && (pick -= weight[n]) > 0) n++
      const j = frontier[n], from = link[j]
      frontier[n] = frontier[--this.size]
      // Through clear air a leader does not branch: the other links from the same clear-air node leave the front.
      if (Math.abs(this.rho[nodes[from]]) < RHO_MIN) for (let f = this.size - 1; f >= 0; f--) if (link[frontier[f]] === from) frontier[f] = frontier[--this.size]
      add(j, from)
    }
    // Charge on each node: its capacitance times the potential difference, limited to neutralizing the charge there.
    const deposit = new Float64Array(nodes.length), polarity = new Int8Array(nodes.length)
    let positive = 0, negative = 0
    for (let c = 0; c < nodes.length; c++) {
      const i = nodes[c], z = Math.floor(i / layer)
      if (z === 0) continue
      const q = this.capacitance[z] * (potential - phi[i]), here = this.rho[i] * dx * dy * this.grid.hz[z]
      polarity[c] = q > 0 ? 1 : q < 0 ? -1 : 0
      if (q * here >= 0) continue
      const d = Math.sign(q) * Math.min(Math.abs(q), Math.abs(here))
      deposit[c] = d
      if (d > 0) positive += d; else negative -= d
    }
    // An IC flash stays neutral: both signs scaled to the smaller. A CG takes the difference from the ground.
    let charge: number
    if (ground < 0) {
      const both = Math.min(positive, negative)
      for (let c = 0; c < nodes.length; c++) deposit[c] *= deposit[c] > 0 ? (positive > 0 ? both / positive : 0) : (negative > 0 ? both / negative : 0)
      charge = both
    } else {
      // Deposited in the cloud from the ground: the charge lowered to the ground is its opposite.
      charge = negative - positive
      this.fromGround -= charge
    }
    for (let c = 0; c < nodes.length; c++) if (deposit[c] !== 0) this.neutralize(carriers, nodes[c], deposit[c])
    return { time, kind: ground >= 0 ? 'CG' : 'IC', start, nodes: Int32Array.from(nodes), parent: Int32Array.from(parent), polarity, potential: ground >= 0 ? before : potential, charge, ground }
  }

  /**
   * Puts the nodes beside channel node i (index c in the channel) on the growth front of flash `id`. The channel grows
   * through charged cloud (|ρ| at least RHO_MIN) and down through clear air (to the ground); not to the top level (the
   * conducting upper atmosphere, outside the storm), and not across the domain's sides: the model is periodic there,
   * but a channel through the edge into the storm's own copy is not a real one (it made CG 48 km wide).
   */
  private extend(i: number, c: number, id: number) {
    const { nx, ny, nz, layer, dx, dy, zs } = this.grid, z = Math.floor(i / layer), y = Math.floor((i - z * layer) / nx), x = i - z * layer - y * nx
    for (let k = Math.max(0, z - 1); k <= Math.min(nz - 2, z + 1); k++) {
      const hz = zs[k] - zs[z], threshold = F_CRIT * .5 * (this.eInit[z] + this.eInit[k])
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (x + di < 0 || x + di >= nx || y + dj < 0 || y + dj >= ny) continue
        const j = x + di + (y + dj) * nx + k * layer
        if (this.mark[j] === id || (k >= z && Math.abs(this.rho[j]) < RHO_MIN)) continue
        const s = Math.sqrt((di * dx) ** 2 + (dj * dy) ** 2 + hz * hz) * threshold
        if (this.seen[j] !== id) { this.seen[j] = id; this.frontier[this.size++] = j }
        else if (s >= this.scale[j]) continue
        this.scale[j] = s; this.link[j] = c
      }
    }
  }

  /**
   * Adds charge q (C) at node i, taken from the carriers holding charge of the opposite sign, in proportion to their
   * charge: the channel's charge neutralizes the charge already there (none changes sign, as |q| ≤ the net charge there).
   */
  private neutralize(carriers: readonly Float32Array[], i: number, q: number) {
    const z = Math.floor(i / this.grid.layer), perKg = q / (this.air[z] * this.grid.dx * this.grid.dy * this.grid.hz[z])
    let opposite = 0
    for (const c of carriers) if (c[i] * q < 0) opposite -= c[i] * Math.sign(q)
    if (opposite <= 0) return
    for (const c of carriers) if (c[i] * q < 0) c[i] += perKg * Math.abs(c[i]) / opposite
  }
}
