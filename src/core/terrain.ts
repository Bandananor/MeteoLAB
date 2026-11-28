import type { Grid } from './grid'
import type { PressureSolver } from './pressure'
import { type Memory, type Phase, PRIVATE_MEMORY } from './threads'

/** The masked projection's runner phases (threads.ts PHASES). */
export type MaskedPhase = Extract<Phase, `masked${string}`>

// Terrain (3.0 block Д, step 1; the author's choice of 22.11.2026: an immersed boundary, not terrain-following
// coordinates — the spectral pressure solver and the GPU kernels stay). The ground rises into the grid as a staircase:
// a node below the terrain height of its column is solid (its velocity is zero); the projection then makes the mass
// flux divergence-free over the fluid nodes alone (MaskedProjection), so the air goes over and around the terrain.
// Literature: .codex/research/terrain-ibm.md (PALM and MicroHH keep their FFT solvers and accept a residual at
// the walls; here the masked operator is solved by conjugate gradients with the flat FFT solve as preconditioner).

/** A terrain form (SimConfig.terrain): heights and widths in km, the centre in km from the domain's south-west corner. */
export interface TerrainConfig {
  /**
   * 'hill' — a round hill (3D Witch of Agnesi); 'ridge' — a long ridge (2D Witch of Agnesi) across `heading`; 'plateau' —
   * a flat-topped rise with smooth sides; 'schar' — the long ridge of Schär et al. (2002) mountain-wave test,
   * exp(-x²/a²) cos²(π x / λ): a Gaussian envelope (a = `width`) on short ridges `wavelength` apart.
   */
  kind: 'hill' | 'ridge' | 'plateau' | 'schar'
  /** Top height above the plain, km. */ height: number
  /** Half-width (the Agnesi a; the plateau's half side), km; at least two grid spacings after smoothing. */ width: number
  /** Centre, km from the domain's south-west corner (absent: the middle). */ x?: number; y?: number
  /** The ridge's axis, degrees clockwise from north (absent: north-south, across a westerly flow). */ heading?: number
  /** 'schar': the short ridges' wavelength λ, km (absent: 4, Schär et al. 2002). */ wavelength?: number
}

/**
 * Ground height of every column, m (x + nx y), from the form; periodic distances; smoothed by two 1-2-1 passes; the
 * lowest column at 0 (the Agnesi tails never reach zero: without it level 0 would be solid everywhere — numerics review
 * 23.11.2026).
 */
export function terrainHeights(t: TerrainConfig, grid: Pick<Grid, 'nx' | 'ny' | 'dx' | 'dy' | 'width' | 'depth'>): Float32Array {
  const { nx, ny, dx, dy, width, depth } = grid, h = new Float32Array(nx * ny)
  const cx = (t.x ?? width / 2000) * 1000, cy = (t.y ?? depth / 2000) * 1000, a = Math.max(t.width * 1000, 2 * Math.max(dx, dy)), top = t.height * 1000
  const axis = (t.heading ?? 0) * Math.PI / 180, ax = Math.sin(axis), ay = Math.cos(axis)
  const wrap = (d: number, size: number) => d - size * Math.round(d / size)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const ex = wrap((i + .5) * dx - cx, width), ey = wrap((j + .5) * dy - cy, depth)
    let v: number
    if (t.kind === 'hill') v = top / (1 + (ex * ex + ey * ey) / (a * a)) ** 1.5
    else if (t.kind === 'ridge') { const across = ex * ay - ey * ax; v = top / (1 + across * across / (a * a)) }
    else if (t.kind === 'schar') { const across = ex * ay - ey * ax; v = top * Math.exp(-across * across / (a * a)) * Math.cos(Math.PI * across / ((t.wavelength ?? 4) * 1000)) ** 2 }
    else { const r = Math.max(Math.abs(ex), Math.abs(ey)); v = top / (1 + Math.exp((r - a) / (.25 * a))) }
    h[i + nx * j] = v
  }
  // Two passes of a 1-2-1 filter in x and y: no single-column steps (the form is already smooth on wide hills).
  const tmp = new Float32Array(nx * ny)
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) tmp[i + nx * j] = (h[(i + nx - 1) % nx + nx * j] + 2 * h[i + nx * j] + h[(i + 1) % nx + nx * j]) / 4
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) h[i + nx * j] = (tmp[i + nx * ((j + ny - 1) % ny)] + 2 * tmp[i + nx * j] + tmp[i + nx * ((j + 1) % ny)]) / 4
  }
  let low = Infinity
  for (const v of h) low = Math.min(low, v)
  for (let c = 0; c < h.length; c++) h[c] -= low
  return h
}

/**
 * A cut cell's least share of its level's control volume (MITgcm's hFacMin): where the ground leaves less of a node's
 * volume above it, that sliver goes to the node above, which then reaches down to the ground (the small-cell limit).
 */
export const LEAST_SHARE = .2

/** The top of node k's control volume, m (the middle between it and the next level; the lid's own height). */
export function volumeTop(grid: Pick<Grid, 'nz' | 'zs' | 'dzs'>, k: number) { return k < grid.nz - 1 ? grid.zs[k] + grid.dzs[k] / 2 : grid.zs[k] }

/**
 * The solid nodes (1) of a grid under ground heights h (m), cut cells (roadmap Д1, the author's choice of 24.11.2026):
 * a node is solid when the ground leaves less than LEAST_SHARE of its control volume above it; the first node that is
 * not — the column's ground node — owns the part of its volume above the ground (nodeHeights). Flat ground (h = 0)
 * has none. The top two levels always stay fluid (the sponge and the rigid lid).
 */
export function solidMask(grid: Pick<Grid, 'nx' | 'ny' | 'nz' | 'zs' | 'dzs' | 'hz'>, h: ArrayLike<number>) {
  const { nx, ny, nz, hz } = grid, layer = nx * ny, solid = new Uint8Array(layer * nz)
  for (let c = 0; c < layer; c++) for (let z = 0; z < nz - 2 && volumeTop(grid, z) - h[c] < LEAST_SHARE * hz[z]; z++) solid[c + z * layer] = 1
  return solid
}

/** The first fluid node level of every column (the level the surface fluxes and drag act on). */
export function groundLevels(grid: Pick<Grid, 'nx' | 'ny' | 'nz'>, solid: Uint8Array) {
  const layer = grid.nx * grid.ny, levels = new Int16Array(layer)
  for (let c = 0; c < layer; c++) { let z = 0; while (z < grid.nz - 1 && solid[c + z * layer]) z++; levels[c] = z }
  return levels
}

/**
 * The control-volume height of every node, m: a column's ground node owns its volume above the ground, from the ground
 * height to its top (a cut cell: from LEAST_SHARE of its level's hz up to a little over a full one, varying smoothly with
 * the ground); a solid node owns nothing (0); every other node its level's hz. Flat ground is level 0's own half
 * layer. The transport, the fall, the mixing and the budgets weigh by these volumes. Without `ground` heights each
 * column's ground is its ground node's level (the staircase: dzs[g] / 2 there, the wall node of 24.11.2026).
 */
export function nodeHeights(grid: Pick<Grid, 'nx' | 'ny' | 'nz' | 'zs' | 'hz' | 'dzs'>, solid: Uint8Array, ground?: ArrayLike<number>) {
  const { nx, ny, nz, hz, zs } = grid, layer = nx * ny, h = new Float64Array(layer * nz), levels = groundLevels(grid, solid)
  for (let z = 0, i = 0; z < nz; z++) for (let c = 0; c < layer; c++, i++) h[i] = solid[i] ? 0 : z === levels[c] ? volumeTop(grid, z) - (ground ? ground[c] : zs[z]) : hz[z]
  return h
}

/**
 * The open height of every node's faces to x + 1 (ax) and y + 1 (ay), m, for the transport: shaved faces (Adcroft,
 * Hill & Marshall 1997, MWR 125, 2293) on partial-cell volumes (nodeHeights, the ground at the column's middle), each
 * face cut by the ground interpolated onto it, the mean of its two columns' heights. In each level's layer of volume (volumeTop of the level below up to its own) the face is
 * open above that height; the open part of a layer where either node is solid goes to the first face above with both
 * nodes fluid (the merged sliver's air moves through it), so a column's faces add up to its whole open height. The
 * overlap of the two nodes' own volumes (min hn, the partial cells, 23.11.2026) closed the face up to the higher of the
 * two grounds: on a slope the transport saw a ridge raised by half a column's rise — the Schär ridge's 4 km waves
 * rectified into its long ones, w 1.2x and the waves' momentum flux 1.3-1.5x linear theory (tests/bench/potential.ts,
 * waves.ts; 26.11.2026). Faces next to solid nodes stay closed (0). The carried part joins the lower column at the
 * level of the upper one's ground node, up to a level above where it lies on steep hills (numerics review 26.11.2026).
 */
export function faceApertures(grid: Pick<Grid, 'nx' | 'ny' | 'nz' | 'zs' | 'dzs' | 'hz'>, solid: Uint8Array, ground: ArrayLike<number>) {
  const { nx, ny, nz, hz } = grid, layer = nx * ny, ax = new Float64Array(layer * nz), ay = new Float64Array(layer * nz)
  const shave = (out: Float64Array, c: number, other: number) => {
    const face = (ground[c] + ground[other]) / 2
    let carry = 0
    for (let k = 0; k < nz; k++) {
      const bottom = k > 0 ? volumeTop(grid, k - 1) : 0, top = volumeTop(grid, k)
      // The ground under the layer: its whole height (hz itself, so the faces above the ground are as without terrain).
      const open = face <= bottom ? hz[k] : Math.max(0, top - face), i = c + k * layer
      if (solid[i] || solid[other + k * layer]) { carry += open; continue }
      out[i] = open + carry; carry = 0
    }
  }
  for (let j = 0, c = 0; j < ny; j++) for (let i = 0; i < nx; i++, c++) { shave(ax, c, (i + 1) % nx + j * nx); shave(ay, c, i + ((j + 1) % ny) * nx) }
  return { ax, ay }
}

/**
 * The slope's area per unit of horizontal area of every column, sqrt(1 + |grad h|^2) (central differences, periodic):
 * the surface stress acts on the sloping area. The heat and vapour fluxes do not take it: they share out the sunlight
 * a column intercepts, which its horizontal area sets (no slope orientation towards the sun yet).
 */
export function slopeArea(grid: Pick<Grid, 'nx' | 'ny' | 'dx' | 'dy'>, h: ArrayLike<number>) {
  const { nx, ny, dx, dy } = grid, area = new Float32Array(nx * ny)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const hx = (h[(i + 1) % nx + nx * j] - h[(i + nx - 1) % nx + nx * j]) / (2 * dx), hy = (h[i + nx * ((j + 1) % ny)] - h[i + nx * ((j + ny - 1) % ny)]) / (2 * dy)
    area[i + nx * j] = Math.sqrt(1 + hx * hx + hy * hy)
  }
  return area
}

/**
 * The projection with terrain: the node mass flux rho0 u made divergence-free over the dual cells (the cells between
 * the nodes), cut by the ground (roadmap Д1, cut cells, the author's choice of 24.11.2026). Each column of a dual cell
 * is open above the ground: each corner's half of the column's side (below and above the cell's middle) by the share of
 * that half above the ground (low, high), so a node's weight in the sides is exactly its own volume (nodeHeights), and
 * where the lower corner is in the ground the node above takes its share too (the air moves along the ground, not into
 * it; numerics review 24.11.2026); w is zero at the nodes on or under the ground (ground nodes below their ground
 * height, as level 0 on flat ground) and free above. A column whose cell is under the ground (frac 0) drops out; a cell
 * with all four under it has no row. The gradient is the operator's exact adjoint over each node's own volume (its
 * mass rho0 hn, nodeHeights), so -D M (rho0 H)^-1 D^T is symmetric and semi-definite and preconditioned conjugate
 * gradients solve it, with the flat operator's exact inverse (PressureSolver.solve) as the preconditioner and each
 * stage's last pressure as the first guess. With every frac 0 or 1 and the ground on a level this is the staircase with
 * wall nodes (24.11.2026), with frac 1 everywhere the flat operator.
 */
export class MaskedProjection {
  /** Iterations and the relative residual of the last solve. */
  iterations = 0; residual = 0
  private readonly grid: Grid; private readonly solver: PressureSolver; private readonly solid: Uint8Array; private readonly any: boolean
  /** The nodes on or under the ground that are not solid (w held at zero), and 1 / (rho0 hn) of every fluid node. */
  private readonly wall: Uint8Array; private readonly inverseMass: Float64Array
  /** The share above the ground of each column's lower and upper half of each cell layer (column + layer * k). */
  private readonly low: Float64Array; private readonly high: Float64Array
  /** The dual cells under the ground in all four columns, which have no row (1). */
  readonly dropped: Uint8Array
  // Shared with helper threads (the operator and the preconditioner run as runner phases, see run): the gradient's
  // node arrays, the cells' input (work), the operator's output (out) and the preconditioner's (z).
  private readonly tu: Float64Array; private readonly tv: Float64Array; private readonly tw: Float64Array
  private readonly work: Float64Array; private readonly out: Float64Array; private readonly z: Float64Array
  private readonly b: Float64Array; private readonly q: Float64Array; private readonly r: Float64Array
  private readonly d: Float64Array; private readonly phi: Float64Array

  /** The relative residual the solve stops at, and its most iterations. */
  readonly tolerance: number; readonly maxIterations: number

  /**
   * Runs a phase's tasks (task): here, one after another, unless the model hands them to its helper threads. The
   * tasks write disjoint levels, so the result is the same either way, bit for bit.
   */
  run: (phase: MaskedPhase, tasks: number) => void = (phase, tasks) => { for (let k = 0; k < tasks; k++) this.task(phase, k) }

  /** `ground`: each column's ground height, m (terrainHeights). */
  constructor(grid: Grid, solver: PressureSolver, ground: ArrayLike<number>, tolerance = 1e-6, maxIterations = 200, memory: Memory = PRIVATE_MEMORY) {
    this.grid = grid; this.solver = solver; this.tolerance = tolerance; this.maxIterations = maxIterations
    const n = grid.n, cells = solver.cells, f = () => new Float64Array(cells), { nx, ny, nz, zs, dzs, layer } = grid, rho = solver.rho
    const solid = this.solid = solidMask(grid, ground), heights = nodeHeights(grid, solid, ground)
    this.any = solid.some(s => s === 1) || Array.prototype.some.call(ground, (h: number) => h > 0)
    this.tu = memory.f64('masked-tu', n); this.tv = memory.f64('masked-tv', n); this.tw = memory.f64('masked-tw', n)
    this.work = memory.f64('masked-work', cells); this.out = memory.f64('masked-out', cells); this.z = memory.f64('masked-z', cells)
    this.b = f(); this.q = f(); this.r = f(); this.d = f(); this.phi = f()
    this.wall = new Uint8Array(n); this.inverseMass = new Float64Array(n); this.low = new Float64Array(cells); this.high = new Float64Array(cells); this.dropped = new Uint8Array(cells)
    for (let z = 0, i = 0; z < nz; z++) for (let c = 0; c < layer; c++, i++) {
      if (solid[i]) continue
      if (zs[z] <= ground[c]) this.wall[i] = 1
      this.inverseMass[i] = 1 / (rho[z] * heights[i])
    }
    const clamp = (x: number) => Math.min(1, Math.max(0, x))
    for (let k = 0; k < nz - 1; k++) for (let c = 0; c < layer; c++) {
      const half = dzs[k] / 2, middle = zs[k] + half, h = ground[c]
      this.low[c + k * layer] = clamp((middle - Math.max(h, zs[k])) / half); this.high[c + k * layer] = clamp((zs[k + 1] - Math.max(h, middle)) / half)
    }
    for (let k = 0, c = 0; k < nz - 1; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, c++) {
      const i1 = (i + 1) % nx, j1 = ((j + 1) % ny) * nx, j0 = j * nx, l = k * layer, hi = this.high
      if (hi[i + j0 + l] === 0 && hi[i1 + j0 + l] === 0 && hi[i + j1 + l] === 0 && hi[i1 + j1 + l] === 0) this.dropped[c] = 1
    }
  }

  /** One task of a phase: the operator's gradient of node level k or divergence of cell layer k, a part of the flat solve. */
  task(phase: MaskedPhase, k: number) {
    switch (phase) {
      case 'maskedGradient': this.gradientPart(k); break
      case 'maskedDivergence': this.divergencePart(this.tu, this.tv, this.tw, this.out, k); break
      case 'maskedForward': this.solver.transform(this.work, k, k + 1); break
      case 'maskedModes': this.solver.modes(k, k + 1); break
      case 'maskedInverse': this.solver.back(this.z, k, k + 1); break
    }
  }

  /** The divergence the projection zeroes (per unit time, into `out`): the cut cells', 0 in the dropped ones. */
  divergence(u: ArrayLike<number>, v: ArrayLike<number>, w: ArrayLike<number>, out: Float64Array) {
    for (let k = 0; k < this.grid.nz - 1; k++) this.divergencePart(u, v, w, out, k)
  }

  /** Zeroes the solid nodes' velocities and w at the nodes on or under the ground, on the flat ground and at the lid. */
  mask(u: ArrayLike<number> & { [k: number]: number }, v: ArrayLike<number> & { [k: number]: number }, w: ArrayLike<number> & { [k: number]: number }) {
    const s = this.solid, wall = this.wall, { layer, n } = this.grid
    for (let i = 0; i < s.length; i++) if (s[i]) { u[i] = 0; v[i] = 0; w[i] = 0 } else if (wall[i]) w[i] = 0
    for (let c = 0; c < layer; c++) { w[c] = 0; w[n - layer + c] = 0 }
  }

  /**
   * The cut cells' divergence of cell layer k (per unit time): the sides through each column's open fraction, the lower
   * corner in the ground replaced by the node above it; top and bottom through the nodes' w (zero on the ground).
   */
  private divergencePart(u: ArrayLike<number>, v: ArrayLike<number>, w: ArrayLike<number>, out: Float64Array, k: number) {
    const { nx, ny, dx, dy, dzs, layer } = this.grid, { low, high, solid, dropped } = this, rho = this.solver.rho, r0 = rho[k] / 4, r1 = rho[k + 1] / 4, l = k * layer
    for (let j = 0, c = l; j < ny; j++) {
      const j0 = j * nx, j1 = ((j + 1) % ny) * nx
      for (let i = 0; i < nx; i++, c++) {
        if (dropped[c]) { out[c] = 0; continue }
        const i1 = (i + 1) % nx
        let ddx = 0, ddy = 0, ddz = 0
        // The four columns: (i, j) west-south, (i1, j) east-south, (i, j1) west-north, (i1, j1) east-north.
        for (let corner = 0; corner < 4; corner++) {
          const col = (corner & 1 ? i1 : i) + (corner & 2 ? j1 : j0), lo = col + l, up = lo + layer
          if (high[lo] > 0) {
            // The lower corner's half by its share above the ground, the upper one's by its; a solid lower corner's share to the upper.
            const a = solid[lo] ? 0 : r0 * low[lo], b = r1 * (high[lo] + (solid[lo] ? low[lo] : 0))
            const fu = a * u[lo] + b * u[up], fv = a * v[lo] + b * v[up]
            ddx += corner & 1 ? fu : -fu; ddy += corner & 2 ? fv : -fv
          }
          ddz += r1 * w[up] - r0 * w[lo]
        }
        out[c] = ddx / dx + ddy / dy + ddz / dzs[k]
      }
    }
  }

  /**
   * The gradient at node level k, into tu, tv, tw: the adjoint of divergencePart over the node's mass, of the potential
   * in `work` times the cells' heights, masked (the operator's first half; the projection's correction).
   */
  private gradientPart(k: number) {
    const { nx, ny, nz, dx, dy, dzs, layer } = this.grid, { tu, tv, tw, work, low, high, solid, wall, inverseMass } = this, rho = this.solver.rho
    const below = k > 0, above = k < nz - 1, r = rho[k] / 4
    for (let j = 0, i = k * layer; j < ny; j++) {
      const jm = ((j + ny - 1) % ny) * nx, j0 = j * nx
      for (let x = 0; x < nx; x++, i++) {
        if (solid[i]) { tu[i] = 0; tv[i] = 0; tw[i] = 0; continue }
        const xm = (x + nx - 1) % nx, col = x + j0
        let gu = 0, gv = 0, gw = 0
        // The four cells around the node: (xm, jm), (x, jm), (xm, j), (x, j); the node is their east / north corner when
        // the cell lies west / south of it (+), the west / south corner otherwise (-).
        if (above) {
          const f = low[col + k * layer] * r, l = k * layer, h = dzs[k]
          const a = h * work[xm + jm + l], b = h * work[x + jm + l], c = h * work[xm + j0 + l], d = h * work[x + j0 + l]
          gu += f * (a - b + c - d) / dx; gv += f * (a + b - c - d) / dy; gw -= r * (a + b + c + d) / h
        }
        if (below) {
          // As the upper corner of layer k - 1, also standing in for the lower corner when that one is solid.
          const l = (k - 1) * layer, f = r * (high[col + l] + (solid[col + l] ? low[col + l] : 0)), h = dzs[k - 1]
          const a = h * work[xm + jm + l], b = h * work[x + jm + l], c = h * work[xm + j0 + l], d = h * work[x + j0 + l]
          gu += f * (a - b + c - d) / dx; gv += f * (a + b - c - d) / dy; gw += r * (a + b + c + d) / h
        }
        const m = inverseMass[i]
        tu[i] = gu * m; tv[i] = gv * m; tw[i] = wall[i] || !below || !above ? 0 : gw * m
      }
    }
  }

  /** Projects (u, v, w) in place over the time step dt; `pressure` (per cell) is the first guess and gets the result. */
  project(u: Float32Array, v: Float32Array, w: Float32Array, dt: number, pressure: Float64Array) {
    const { b, q, r, z, d, out: sd, phi } = this, dzs = this.grid.dzs, cl = this.grid.nx * this.grid.ny, cells = this.solver.cells
    this.mask(u, v, w)
    if (!this.any) { this.iterations = 0; this.residual = 0; this.flat(u, v, w, dt, pressure); return }
    // b = D R M u* (per unit time 1: the potential phi = dt p is solved for).
    this.divergence(u, v, w, b)
    let bb = 0
    for (let c = 0; c < cells; c++) bb += b[c] * b[c]
    if (!(bb > 0)) { this.iterations = 0; this.residual = 0; return }
    // q = V phi, first guess from the last pressure; r = -b - S q.
    const dropped = this.dropped
    for (let c = 0; c < cells; c++) q[c] = dropped[c] ? 0 : pressure[c] * dt * dzs[Math.floor(c / cl)]
    this.apply(q)
    for (let c = 0; c < cells; c++) r[c] = -b[c] - sd[c]
    this.precondition(r)
    let rz = 0
    for (let c = 0; c < cells; c++) { d[c] = z[c]; rz += r[c] * z[c] }
    let k = 0, rr = 0
    for (; k < this.maxIterations; k++) {
      rr = 0
      for (let c = 0; c < cells; c++) rr += r[c] * r[c]
      if (rr <= this.tolerance * this.tolerance * bb) break
      this.apply(d)
      let dsd = 0
      for (let c = 0; c < cells; c++) dsd += d[c] * sd[c]
      if (!(dsd > 0)) break
      const alpha = rz / dsd
      for (let c = 0; c < cells; c++) { q[c] += alpha * d[c]; r[c] -= alpha * sd[c] }
      this.precondition(r)
      let rzNew = 0
      for (let c = 0; c < cells; c++) rzNew += r[c] * z[c]
      const beta = rzNew / rz
      rz = rzNew
      for (let c = 0; c < cells; c++) d[c] = z[c] + beta * d[c]
    }
    this.iterations = k; this.residual = Math.sqrt(rr / bb)
    // u = M (u* - G phi), phi = q / V; the pressure kept is phi / dt.
    for (let c = 0; c < cells; c++) { phi[c] = q[c] / dzs[Math.floor(c / cl)]; pressure[c] = phi[c] / dt }
    this.work.set(phi)
    this.run('maskedGradient', this.grid.nz)
    const { tu, tv, tw } = this
    for (let i = 0; i < u.length; i++) { u[i] += tu[i]; v[i] += tv[i]; w[i] += tw[i] }
    this.mask(u, v, w)
  }

  /** No terrain at all (flat ground everywhere): the flat projection exactly, as without terrain. */
  private flat(u: Float32Array, v: Float32Array, w: Float32Array, dt: number, pressure: Float64Array) {
    const b = this.b
    this.solver.divergence(u, v, w, dt, b); this.solver.solve(b, pressure); this.solver.correct(pressure, u, v, w, dt)
  }

  /** S q = P D R M (R H)^-1 D^T P q over the kept cells (P drops the rest), into `out`. */
  private apply(q: Float64Array) {
    const { work, dropped } = this, dzs = this.grid.dzs, cl = this.grid.nx * this.grid.ny
    for (let c = 0; c < work.length; c++) work[c] = dropped[c] ? 0 : q[c] / dzs[Math.floor(c / cl)]
    this.run('maskedGradient', this.grid.nz); this.run('maskedDivergence', this.grid.nz - 1)
  }

  /**
   * z = P S0^-1 P r with the flat operator S0 = D R H^-1 D^T: q = V phi with D R G phi = -r (PressureSolver.solve in
   * its three phases), kept to the cells with a row (symmetric and positive there).
   */
  private precondition(r: Float64Array) {
    const { work, z, dropped } = this, { dzs, nz, ny } = this.grid, cl = this.grid.nx * ny
    for (let c = 0; c < work.length; c++) work[c] = -r[c]
    this.run('maskedForward', nz - 1); this.run('maskedModes', ny); this.run('maskedInverse', nz - 1)
    for (let c = 0; c < z.length; c++) z[c] = dropped[c] ? 0 : z[c] * dzs[Math.floor(c / cl)]
  }
}
