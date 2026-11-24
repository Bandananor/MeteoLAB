import type { Grid } from './grid'
import type { PressureSolver } from './pressure'
import { type Memory, type Phase, PRIVATE_MEMORY } from './threads'

/** The masked projection's runner phases (threads.ts PHASES). */
export type MaskedPhase = Extract<Phase, `masked${string}`>

// Terrain (3.0 block Д, step 1; the author's choice of 22.11.2026: an immersed boundary, not terrain-following
// coordinates — the spectral pressure solver and the GPU kernels stay). The ground rises into the grid as a staircase:
// a node below the terrain height of its column is solid (its velocity is zero); the projection then makes the mass
// flux divergence-free over the fluid nodes alone (MaskedProjection), so the air goes over and around the terrain.
// Literature: .claude/literature/terrain-ibm.md (PALM and MicroHH keep their FFT solvers and accept a residual at
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
 * The solid nodes (1) of a grid under ground heights h (m): each column's ground is the node level nearest to its
 * height, and the levels below it are solid; a column under half the lowest spacing has none, so h = 0 is the flat
 * ground bit for bit. The top two levels always stay fluid (the sponge and the rigid lid).
 */
export function solidMask(grid: Pick<Grid, 'nx' | 'ny' | 'nz' | 'zs'>, h: ArrayLike<number>) {
  const { nx, ny, nz, zs } = grid, layer = nx * ny, solid = new Uint8Array(layer * nz)
  for (let c = 0; c < layer; c++) {
    let ground = 0
    while (ground < nz - 3 && Math.abs(zs[ground + 1] - h[c]) < Math.abs(zs[ground] - h[c])) ground++
    for (let z = 0; z < ground; z++) solid[c + z * layer] = 1
  }
  return solid
}

/** The first fluid node level of every column (the level the surface fluxes and drag act on). */
export function groundLevels(grid: Pick<Grid, 'nx' | 'ny' | 'nz'>, solid: Uint8Array) {
  const layer = grid.nx * grid.ny, levels = new Int16Array(layer)
  for (let c = 0; c < layer; c++) { let z = 0; while (z < grid.nz - 1 && solid[c + z * layer]) z++; levels[c] = z }
  return levels
}

/**
 * The control-volume height of every node, m (the wall node, roadmap Д1 (а), numerics review 23.11.2026): the ground
 * node of a column lies on the ground, as level 0 on the flat ground — its w is zero and it owns the half layer above
 * it, dzs[g] / 2 (level 0's hz[0] on the flat ground); a solid node owns nothing (0); every other node its level's hz.
 * So a flat plateau top is discretised as the flat ground at its height, and the transport, the fall, the mixing and
 * the budgets weigh by the same volumes.
 */
export function nodeHeights(grid: Pick<Grid, 'nx' | 'ny' | 'nz' | 'hz' | 'dzs'>, solid: Uint8Array) {
  const { nx, ny, nz, hz, dzs } = grid, layer = nx * ny, h = new Float64Array(layer * nz), ground = groundLevels(grid, solid)
  for (let z = 0, i = 0; z < nz; z++) for (let c = 0; c < layer; c++, i++) h[i] = solid[i] ? 0 : z > 0 && z === ground[c] ? dzs[z] / 2 : hz[z]
  return h
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
 * The projection with terrain: the node mass flux rho0 u made divergence-free over the dual cells with the solid nodes'
 * velocities held at zero. With M the mask, it solves D R M G p = D R M u* / dt and sets u = M (u* - dt G p). Written for
 * q = V p (V the cells' heights) the operator is -D (R M H^-1) D^T, symmetric and semi-definite, so preconditioned
 * conjugate gradients solve it; the preconditioner is the flat operator's exact inverse (PressureSolver.solve), and the
 * last step's pressure is the first guess. A cell with all eight corners solid has no row and never touches a fluid node.
 *
 * The wall nodes (a column's ground node above level 0, nodeHeights) are the flat ground's level 0 at their height: M
 * holds their w at zero, they are cut from the dual cells below them (D leaves out their u and v there and G their
 * cells below, symmetrically: otherwise a step of the slope, a cell with a solid and a wall corner on a side, lets half
 * a face of air through — the numerics review 24.11.2026 measured w over a 1 km hill 40 % under linear theory with it,
 * 15 % over without), the cells left with no node at all (below every corner's ground) are dropped, and H at them is
 * the half layer they own, so the gradient there is the flat ground's one-sided one. The operator stays symmetric, and
 * its null space is the flat one's (the constant and each layer's horizontal checkerboard), which the flat solve
 * leaves out too.
 */
export class MaskedProjection {
  /** Iterations and the relative residual of the last solve. */
  iterations = 0; residual = 0
  private readonly grid: Grid; private readonly solver: PressureSolver; private readonly solid: Uint8Array; private readonly any: boolean
  /** The wall nodes (w held at zero), and the factor hz / H that turns the solver's gradient into the one over H. */
  private readonly wall: Uint8Array; private readonly scale: Float64Array
  /** The dual cells below the wall nodes, which have no row (1). */
  readonly dropped: Uint8Array
  /** The wall nodes (index), level by level, and where each level's start in it (nz + 1 entries). */
  private readonly walls: Int32Array; private readonly wallsFrom: Int32Array
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

  constructor(grid: Grid, solver: PressureSolver, solid: Uint8Array, tolerance = 1e-6, maxIterations = 200, memory: Memory = PRIVATE_MEMORY) {
    this.grid = grid; this.solver = solver; this.solid = solid; this.tolerance = tolerance; this.maxIterations = maxIterations
    this.any = solid.some(s => s === 1)
    const n = grid.n, cells = solver.cells, f = () => new Float64Array(cells), { nx, ny, nz, hz, layer } = grid
    this.tu = memory.f64('masked-tu', n); this.tv = memory.f64('masked-tv', n); this.tw = memory.f64('masked-tw', n)
    this.work = memory.f64('masked-work', cells); this.out = memory.f64('masked-out', cells); this.z = memory.f64('masked-z', cells)
    this.b = f(); this.q = f(); this.r = f(); this.d = f(); this.phi = f()
    const ground = groundLevels(grid, solid), heights = nodeHeights(grid, solid)
    this.wall = new Uint8Array(n); this.scale = new Float64Array(n).fill(1); this.dropped = new Uint8Array(cells)
    const walls: number[] = []
    this.wallsFrom = new Int32Array(nz + 1)
    for (let z = 0; z < nz; z++) {
      this.wallsFrom[z] = walls.length
      if (z > 0) for (let c = 0; c < layer; c++) if (ground[c] === z) { const i = c + z * layer; this.wall[i] = 1; this.scale[i] = hz[z] / heights[i]; walls.push(i) }
    }
    this.wallsFrom[nz] = walls.length
    this.walls = Int32Array.from(walls)
    for (let k = 0, c = 0; k < nz - 1; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, c++) {
      const i1 = (i + 1) % nx, j1 = ((j + 1) % ny) * nx, j0 = j * nx
      if (k + 1 <= Math.min(ground[i + j0], ground[i1 + j0], ground[i + j1], ground[i1 + j1])) this.dropped[c] = 1
    }
  }

  /** One task of a phase: the operator's gradient of node level k or divergence of cell layer k, a part of the flat solve. */
  task(phase: MaskedPhase, k: number) {
    switch (phase) {
      case 'maskedGradient': this.gradientPart(k); break
      case 'maskedDivergence': this.divergencePart(k); break
      case 'maskedForward': this.solver.transform(this.work, k, k + 1); break
      case 'maskedModes': this.solver.modes(k, k + 1); break
      case 'maskedInverse': this.solver.back(this.z, k, k + 1); break
    }
  }

  /** The divergence the projection zeroes (per unit time, into `out`): the cells' with the wall nodes cut, 0 in the dropped ones. */
  divergence(u: Float32Array, v: Float32Array, w: Float32Array, out: Float64Array) {
    this.solver.divergence(u, v, w, 1, out); this.cutDivergence(u, v, out)
    for (let c = 0; c < out.length; c++) if (this.dropped[c]) out[c] = 0
  }

  /**
   * Takes the wall nodes' u and v out of the divergence of the cells below them (`out`, per unit time): each is the
   * upper corner of four cells of the layer below, where PressureSolver.divergence counted rho/4 (±u/dx ± v/dy).
   * The wall nodes from..to-1 of the list (default all).
   */
  private cutDivergence(u: ArrayLike<number>, v: ArrayLike<number>, out: Float64Array, from = 0, to = this.walls.length) {
    const { nx, ny, dx, dy, layer } = this.grid, rho = this.solver.rho, walls = this.walls
    for (let k = from; k < to; k++) {
      const i = walls[k], z = Math.floor(i / layer), c = i - z * layer, x = c % nx, y = (c - x) / nx, r = rho[z] / 4, base = (z - 1) * layer
      const xm = (x + nx - 1) % nx, ym = (y + ny - 1) % ny, ux = r * u[i] / dx, vy = r * v[i] / dy
      // The node is the cells' corner t (cell x-1, y-1), s (x, y-1), h (x-1, y) and g (x, y): + for the east / north corners.
      out[base + xm + nx * ym] -= ux + vy; out[base + x + nx * ym] -= -ux + vy; out[base + xm + nx * y] -= ux - vy; out[base + x + nx * y] -= -ux - vy
    }
  }

  /** Takes the cells below each wall node out of its gradient: adds back the part PressureSolver.correct took from them. */
  private cutGradient(phi: Float64Array, tu: Float64Array, tv: Float64Array, from: number, to: number) {
    const { nx, ny, dx, dy, dzs, hz, layer } = this.grid, walls = this.walls
    for (let k = from; k < to; k++) {
      const i = walls[k], z = Math.floor(i / layer), c = i - z * layer, x = c % nx, y = (c - x) / nx, base = (z - 1) * layer, wLo = dzs[z - 1] / hz[z]
      const xm = (x + nx - 1) % nx, ym = (y + ny - 1) % ny, P = (ii: number, jj: number) => phi[base + ii + nx * jj]
      tu[i] += wLo * (P(x, ym) + P(x, y) - P(xm, ym) - P(xm, y)) / (4 * dx)
      tv[i] += wLo * (P(xm, y) + P(x, y) - P(xm, ym) - P(x, ym)) / (4 * dy)
    }
  }

  /** Zeroes the solid nodes' velocities and the wall nodes' w, and w on the flat ground and the lid (as the model holds them). */
  mask(u: ArrayLike<number> & { [k: number]: number }, v: ArrayLike<number> & { [k: number]: number }, w: ArrayLike<number> & { [k: number]: number }) {
    const s = this.solid, wall = this.wall, { layer, n } = this.grid
    for (let i = 0; i < s.length; i++) if (s[i]) { u[i] = 0; v[i] = 0; w[i] = 0 } else if (wall[i]) w[i] = 0
    for (let c = 0; c < layer; c++) { w[c] = 0; w[n - layer + c] = 0 }
  }

  /** The masked gradient -M G (work) over H at node level k, into tu, tv, tw (the operator's first half). */
  private gradientPart(k: number) {
    const { tu, tv, tw, work, scale, solid, wall } = this, { layer, nz } = this.grid, a = k * layer, e = a + layer
    tu.fill(0, a, e); tv.fill(0, a, e); tw.fill(0, a, e)
    this.solver.correct(work, tu as unknown as Float32Array, tv as unknown as Float32Array, tw as unknown as Float32Array, 1, k, k + 1)
    this.cutGradient(work, tu, tv, this.wallsFrom[k], this.wallsFrom[k + 1])
    for (let i = a; i < e; i++) { const s = scale[i]; tu[i] *= s; tv[i] *= s; tw[i] *= s; if (solid[i]) { tu[i] = 0; tv[i] = 0; tw[i] = 0 } else if (wall[i]) tw[i] = 0 }
    if (k === 0 || k === nz - 1) tw.fill(0, a, e)
  }

  /** The divergence of tu, tv, tw in cell layer k, the wall nodes above it cut, into `out` (the operator's second half). */
  private divergencePart(k: number) {
    const { tu, tv, tw, out, dropped } = this, cl = this.grid.layer
    this.solver.divergence(tu as unknown as Float32Array, tv as unknown as Float32Array, tw as unknown as Float32Array, 1, out, k, k + 1)
    this.cutDivergence(tu, tv, out, this.wallsFrom[k + 1], this.wallsFrom[k + 2])
    for (let c = k * cl; c < (k + 1) * cl; c++) if (dropped[c]) out[c] = 0
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
    // u = M (u* - G phi) with G over H, phi = q / V; the pressure kept is phi / dt.
    for (let c = 0; c < cells; c++) { phi[c] = q[c] / dzs[Math.floor(c / cl)]; pressure[c] = phi[c] / dt }
    this.work.set(phi)
    this.run('maskedGradient', this.grid.nz)
    const { tu, tv, tw } = this
    for (let i = 0; i < u.length; i++) { u[i] += tu[i]; v[i] += tv[i]; w[i] += tw[i] }
    this.mask(u, v, w)
  }

  /** No solid node at all (terrain under half the lowest spacing): the flat projection exactly, as without terrain. */
  private flat(u: Float32Array, v: Float32Array, w: Float32Array, dt: number, pressure: Float64Array) {
    const b = this.b
    this.solver.divergence(u, v, w, dt, b); this.solver.solve(b, pressure); this.solver.correct(pressure, u, v, w, dt)
  }

  /** S q = P D R M H^-1 D^T P q = div(M (-G (q / V))) over the kept cells (P drops the rest), into `out`. */
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
