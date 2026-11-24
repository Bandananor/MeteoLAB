import type { Grid } from './grid'
import type { PressureSolver } from './pressure'

// Terrain (3.0 block Д, step 1; the author's choice of 22.11.2026: an immersed boundary, not terrain-following
// coordinates — the spectral pressure solver and the GPU kernels stay). The ground rises into the grid as a staircase:
// a node below the terrain height of its column is solid (its velocity is zero); the projection then makes the mass
// flux divergence-free over the fluid nodes alone (MaskedProjection), so the air goes over and around the terrain.
// Literature: .claude/literature/terrain-ibm.md (PALM and MicroHH keep their FFT solvers and accept a residual at
// the walls; here the masked operator is solved by conjugate gradients with the flat FFT solve as preconditioner).

/** A terrain form (SimConfig.terrain): heights and widths in km, the centre in km from the domain's south-west corner. */
export interface TerrainConfig {
  /** 'hill' — a round hill (3D Witch of Agnesi); 'ridge' — a long ridge (2D Witch of Agnesi) across `heading`; 'plateau' — a flat-topped rise with smooth sides. */
  kind: 'hill' | 'ridge' | 'plateau'
  /** Top height above the plain, km. */ height: number
  /** Half-width (the Agnesi a; the plateau's half side), km; at least two grid spacings after smoothing. */ width: number
  /** Centre, km from the domain's south-west corner (absent: the middle). */ x?: number; y?: number
  /** The ridge's axis, degrees clockwise from north (absent: north-south, across a westerly flow). */ heading?: number
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
 */
export class MaskedProjection {
  /** Iterations and the relative residual of the last solve. */
  iterations = 0; residual = 0
  private readonly grid: Grid; private readonly solver: PressureSolver; private readonly solid: Uint8Array; private readonly any: boolean
  private readonly tu: Float64Array; private readonly tv: Float64Array; private readonly tw: Float64Array
  private readonly b: Float64Array; private readonly q: Float64Array; private readonly r: Float64Array; private readonly z: Float64Array
  private readonly d: Float64Array; private readonly sd: Float64Array; private readonly work: Float64Array; private readonly phi: Float64Array

  /** The relative residual the solve stops at, and its most iterations. */
  readonly tolerance: number; readonly maxIterations: number

  constructor(grid: Grid, solver: PressureSolver, solid: Uint8Array, tolerance = 1e-6, maxIterations = 200) {
    this.grid = grid; this.solver = solver; this.solid = solid; this.tolerance = tolerance; this.maxIterations = maxIterations
    this.any = solid.some(s => s === 1)
    const n = grid.n, cells = solver.cells, f = () => new Float64Array(cells)
    this.tu = new Float64Array(n); this.tv = new Float64Array(n); this.tw = new Float64Array(n)
    this.b = f(); this.q = f(); this.r = f(); this.z = f(); this.d = f(); this.sd = f(); this.work = f(); this.phi = f()
  }

  /** Zeroes the solid nodes' velocities. */
  mask(u: ArrayLike<number> & { [k: number]: number }, v: ArrayLike<number> & { [k: number]: number }, w: ArrayLike<number> & { [k: number]: number }) {
    const s = this.solid
    for (let i = 0; i < s.length; i++) if (s[i]) { u[i] = 0; v[i] = 0; w[i] = 0 }
  }

  /** Projects (u, v, w) in place over the time step dt; `pressure` (per cell) is the first guess and gets the result. */
  project(u: Float32Array, v: Float32Array, w: Float32Array, dt: number, pressure: Float64Array) {
    const { b, q, r, z, d, sd, phi } = this, dzs = this.grid.dzs, cl = this.grid.nx * this.grid.ny, cells = this.solver.cells
    this.mask(u, v, w)
    if (!this.any) { this.iterations = 0; this.residual = 0; this.flat(u, v, w, dt, pressure); return }
    // b = D R M u* (per unit time 1: the potential phi = dt p is solved for).
    this.solver.divergence(u, v, w, 1, b)
    let bb = 0
    for (let c = 0; c < cells; c++) bb += b[c] * b[c]
    if (!(bb > 0)) { this.iterations = 0; this.residual = 0; return }
    // q = V phi, first guess from the last pressure; r = -b - S q.
    for (let c = 0; c < cells; c++) q[c] = pressure[c] * dt * dzs[Math.floor(c / cl)]
    this.apply(q, sd)
    for (let c = 0; c < cells; c++) r[c] = -b[c] - sd[c]
    this.precondition(r, z)
    let rz = 0
    for (let c = 0; c < cells; c++) { d[c] = z[c]; rz += r[c] * z[c] }
    let k = 0, rr = 0
    for (; k < this.maxIterations; k++) {
      rr = 0
      for (let c = 0; c < cells; c++) rr += r[c] * r[c]
      if (rr <= this.tolerance * this.tolerance * bb) break
      this.apply(d, sd)
      let dsd = 0
      for (let c = 0; c < cells; c++) dsd += d[c] * sd[c]
      if (!(dsd > 0)) break
      const alpha = rz / dsd
      for (let c = 0; c < cells; c++) { q[c] += alpha * d[c]; r[c] -= alpha * sd[c] }
      this.precondition(r, z)
      let rzNew = 0
      for (let c = 0; c < cells; c++) rzNew += r[c] * z[c]
      const beta = rzNew / rz
      rz = rzNew
      for (let c = 0; c < cells; c++) d[c] = z[c] + beta * d[c]
    }
    this.iterations = k; this.residual = Math.sqrt(rr / bb)
    // u = M (u* - G phi), phi = q / V; the pressure kept is phi / dt.
    for (let c = 0; c < cells; c++) { phi[c] = q[c] / dzs[Math.floor(c / cl)]; pressure[c] = phi[c] / dt }
    this.solver.correct(phi, u, v, w, 1)
    this.mask(u, v, w)
  }

  /** No solid node at all (terrain under half the lowest spacing): the flat projection exactly, as without terrain. */
  private flat(u: Float32Array, v: Float32Array, w: Float32Array, dt: number, pressure: Float64Array) {
    const b = this.b
    this.solver.divergence(u, v, w, dt, b); this.solver.solve(b, pressure); this.solver.correct(pressure, u, v, w, dt)
  }

  /** S q = D R M H^-1 D^T q = div(M (-G (q / V))): the masked operator in the symmetric form. */
  private apply(q: Float64Array, out: Float64Array) {
    const { tu, tv, tw, work } = this, dzs = this.grid.dzs, cl = this.grid.nx * this.grid.ny
    for (let c = 0; c < work.length; c++) work[c] = q[c] / dzs[Math.floor(c / cl)]
    tu.fill(0); tv.fill(0); tw.fill(0)
    this.solver.correct(work, tu as unknown as Float32Array, tv as unknown as Float32Array, tw as unknown as Float32Array, 1)
    this.mask(tu, tv, tw)
    this.solver.divergence(tu as unknown as Float32Array, tv as unknown as Float32Array, tw as unknown as Float32Array, 1, out)
  }

  /** z = S0^-1 r with the flat operator S0 = D R H^-1 D^T: q = V phi with D R G phi = -r (PressureSolver.solve). */
  private precondition(r: Float64Array, z: Float64Array) {
    const work = this.work, dzs = this.grid.dzs, cl = this.grid.nx * this.grid.ny
    for (let c = 0; c < work.length; c++) work[c] = -r[c]
    this.solver.solve(work, z)
    for (let c = 0; c < z.length; c++) z[c] *= dzs[Math.floor(c / cl)]
  }
}
