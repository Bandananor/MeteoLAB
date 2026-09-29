import type { Grid } from './grid'

/**
 * Exact, consistent pressure projection for node-based velocities, anelastic: the mass flux rho0(z) u is made
 * divergence-free (rho0 = 1 everywhere gives the incompressible projection).
 *
 * Velocities live at grid nodes; pressure lives at the centres of the "dual" cells between nodes
 * (nx * ny * (nz-1) cells, periodic in x and y, the ground and top node levels are rigid walls).
 * D is the net flux out of a dual cell computed from its 8 corner nodes, which is the divergence that
 * trilinear semi-Lagrangian transport responds to. G is minus the adjoint of D (with half weight for
 * the wall nodes); with R = diag(rho0 of each node level), D·R·G is the consistent (density-weighted) Laplacian
 * and u - dt·G·p makes D·R·u exactly zero. The correction is the kinetic-energy-minimising one for the rho0-weighted
 * norm, i.e. the gradient of p'/rho0. D·R·G is diagonalised by a 2D DFT in x, y (rho0 depends on z only),
 * leaving one tridiagonal system per horizontal wavenumber.
 */
export class PressureSolver {
  readonly cells: number
  private readonly grid: Grid
  private readonly cosX: Float64Array; private readonly sinX: Float64Array
  private readonly cosY: Float64Array; private readonly sinY: Float64Array
  /** Horizontal symbols per mode (m + nx*n): alpha multiplies Z_A, beta multiplies Z_delta / dz^2. */
  private readonly alpha: Float64Array; private readonly beta: Float64Array
  private readonly re: Float64Array; private readonly im: Float64Array
  private readonly rowRe: Float64Array; private readonly rowIm: Float64Array
  private readonly cp: Float64Array; private readonly dRe: Float64Array; private readonly dIm: Float64Array
  /** Base-state density of each node level (ones: incompressible). */
  private readonly rho: Float64Array

  constructor(grid: Grid, density?: ArrayLike<number>) {
    const { nx, ny, nz, dx, dy, dz } = grid
    this.grid = grid
    this.rho = density ? Float64Array.from(density) : new Float64Array(nz).fill(1)
    if (this.rho.length !== nz) throw new Error(`density needs ${nz} levels, got ${this.rho.length}`)
    this.cells = nx * ny * (nz - 1)
    const table = (n: number, f: (a: number) => number) => { const t = new Float64Array(n * n); for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) t[a * n + b] = f(2 * Math.PI * ((a * b) % n) / n); return t }
    this.cosX = table(nx, Math.cos); this.sinX = table(nx, Math.sin); this.cosY = table(ny, Math.cos); this.sinY = table(ny, Math.sin)
    this.alpha = new Float64Array(nx * ny); this.beta = new Float64Array(nx * ny)
    // cos^2 of pi/2 is 3.7e-33 in floating point, not 0; the null modes must be exactly zero or the solve blows up.
    const exact = (x: number) => x < 1e-12 ? 0 : x > 1 - 1e-12 ? 1 : x
    for (let n = 0; n < ny; n++) for (let m = 0; m < nx; m++) {
      const sx = exact(Math.sin(Math.PI * m / nx) ** 2), cx = exact(Math.cos(Math.PI * m / nx) ** 2), sy = exact(Math.sin(Math.PI * n / ny) ** 2), cy = exact(Math.cos(Math.PI * n / ny) ** 2)
      this.alpha[m + nx * n] = 4 * (sx * cy / (dx * dx) + cx * sy / (dy * dy))
      this.beta[m + nx * n] = cx * cy / (dz * dz)
    }
    this.re = new Float64Array(this.cells); this.im = new Float64Array(this.cells)
    this.rowRe = new Float64Array(Math.max(nx, ny)); this.rowIm = new Float64Array(Math.max(nx, ny))
    this.cp = new Float64Array(nz); this.dRe = new Float64Array(nz); this.dIm = new Float64Array(nz)
  }

  /** Dual-cell divergence of the node mass flux rho0 u, divided by dt, into `out` (length `cells`). */
  divergence(u: Float32Array, v: Float32Array, w: Float32Array, dt: number, out: Float64Array) {
    const { nx, ny, nz, dx, dy, dz, layer } = this.grid
    for (let k = 0, c = 0; k < nz - 1; k++) {
      const l0 = k * layer, l1 = l0 + layer, r0 = this.rho[k] / 4, r1 = this.rho[k + 1] / 4
      for (let j = 0; j < ny; j++) {
        const y0 = j * nx, y1 = ((j + 1) % ny) * nx
        for (let i = 0; i < nx; i++, c++) {
          const i1 = (i + 1) % nx
          const a = i + y0 + l0, b = i1 + y0 + l0, e = i + y1 + l0, f = i1 + y1 + l0, g = i + y0 + l1, h = i1 + y0 + l1, s = i + y1 + l1, t = i1 + y1 + l1
          const ddx = (r0 * (u[b] + u[f] - u[a] - u[e]) + r1 * (u[h] + u[t] - u[g] - u[s])) / dx
          const ddy = (r0 * (v[e] + v[f] - v[a] - v[b]) + r1 * (v[s] + v[t] - v[g] - v[h])) / dy
          const ddz = (r1 * (w[g] + w[h] + w[s] + w[t]) - r0 * (w[a] + w[b] + w[e] + w[f])) / dz
          out[c] = (ddx + ddy + ddz) / dt
        }
      }
    }
  }

  /** Subtracts dt * G p from the node velocities; w at the wall levels stays untouched (it is zero). */
  correct(p: Float64Array, u: Float32Array, v: Float32Array, w: Float32Array, dt: number) {
    const { nx, ny, nz, dx, dy, dz, layer } = this.grid, cl = nx * ny
    for (let k = 0; k < nz; k++) {
      // Dual-cell layers touching node level k; wall levels see one layer, counted twice (the 1/M = 2 weight).
      const lo = Math.max(0, k - 1) * cl, hi = Math.min(nz - 2, k) * cl
      for (let j = 0; j < ny; j++) {
        const jm = ((j + ny - 1) % ny) * nx, j0 = j * nx
        for (let i = 0; i < nx; i++) {
          const im = (i + nx - 1) % nx, node = i + j * nx + k * layer
          const P = (ii: number, jj: number, base: number) => p[base + ii + jj]
          const gx = (P(i, jm, lo) + P(i, j0, lo) + P(i, jm, hi) + P(i, j0, hi) - P(im, jm, lo) - P(im, j0, lo) - P(im, jm, hi) - P(im, j0, hi)) / (4 * dx)
          const gy = (P(im, j0, lo) + P(i, j0, lo) + P(im, j0, hi) + P(i, j0, hi) - P(im, jm, lo) - P(i, jm, lo) - P(im, jm, hi) - P(i, jm, hi)) / (4 * dy)
          u[node] -= dt * gx; v[node] -= dt * gy
          if (k > 0 && k < nz - 1) {
            const below = (k - 1) * cl, above = k * cl
            const gz = (P(im, jm, above) + P(i, jm, above) + P(im, j0, above) + P(i, j0, above) - P(im, jm, below) - P(i, jm, below) - P(im, j0, below) - P(i, j0, below)) / (4 * dz)
            w[node] -= dt * gz
          }
        }
      }
    }
  }

  /** Solves (D·R·G) p = rhs exactly; rhs is consumed (overwritten). Null modes of D·R·G get p = 0. */
  solve(rhs: Float64Array, p: Float64Array) {
    const { nx, ny, nz } = this.grid, cl = nx * ny, nc = nz - 1, re = this.re, im = this.im
    // rhs is real, so its spectrum is Hermitian: only x-wavenumbers 0..nx/2 are computed, the rest are conjugates.
    const mh = Math.floor(nx / 2)
    // Forward 2D DFT of every cell layer (x then y), exp(-i theta).
    for (let k = 0; k < nc; k++) {
      const base = k * cl
      for (let j = 0; j < ny; j++) {
        const row = base + j * nx
        for (let m = 0; m <= mh; m++) { let a = 0, b = 0; for (let i = 0; i < nx; i++) { const x = rhs[row + i], t = m * nx + i; a += x * this.cosX[t]; b -= x * this.sinX[t] } this.rowRe[m] = a; this.rowIm[m] = b }
        for (let m = 0; m <= mh; m++) { re[row + m] = this.rowRe[m]; im[row + m] = this.rowIm[m] }
      }
      for (let m = 0; m <= mh; m++) {
        for (let n = 0; n < ny; n++) { let a = 0, b = 0; for (let j = 0; j < ny; j++) { const x = re[base + j * nx + m], y = im[base + j * nx + m], t = n * ny + j, c = this.cosY[t], s = this.sinY[t]; a += x * c + y * s; b += y * c - x * s } this.rowRe[n] = a; this.rowIm[n] = b }
        for (let n = 0; n < ny; n++) { re[base + n * nx + m] = this.rowRe[n]; im[base + n * nx + m] = this.rowIm[n] }
      }
    }
    // One tridiagonal system per mode: (-alpha Z_A + beta Z_delta) p = r.
    for (let n = 0; n < ny; n++) for (let m = 0; m <= mh; m++) {
      const mode = m + nx * n, a = this.alpha[mode], b = this.beta[mode]
      if (a === 0 && b === 0 || nc === 1 && a === 0) { for (let k = 0; k < nc; k++) re[mode + k * cl] = im[mode + k * cl] = 0; continue }
      this.tridiagonal(mode, a, b, nc, cl)
    }
    // Inverse 2D DFT, exp(+i theta), keep the real part.
    for (let k = 0; k < nc; k++) {
      const base = k * cl
      for (let m = 0; m <= mh; m++) {
        for (let j = 0; j < ny; j++) { let a = 0, b = 0; for (let n = 0; n < ny; n++) { const x = re[base + n * nx + m], y = im[base + n * nx + m], t = j * ny + n, c = this.cosY[t], s = this.sinY[t]; a += x * c - y * s; b += y * c + x * s } this.rowRe[j] = a; this.rowIm[j] = b }
        for (let j = 0; j < ny; j++) { re[base + j * nx + m] = this.rowRe[j]; im[base + j * nx + m] = this.rowIm[j] }
      }
      for (let j = 0; j < ny; j++) {
        const row = base + j * nx
        // Wavenumbers strictly between 0 and nx/2 stand for themselves and their conjugate partner (weight 2).
        for (let i = 0; i < nx; i++) {
          let a = 0
          for (let m = 0; m <= mh; m++) { const t = i * nx + m, weight = m === 0 || 2 * m === nx ? 1 : 2; a += weight * (re[row + m] * this.cosX[t] - im[row + m] * this.sinX[t]) }
          p[row + i] = a / cl
        }
      }
    }
  }

  // Thomas algorithm for one horizontal mode. Row k (cell between node levels k and k+1) collects, from each of its two
  // node levels n, rho_n times: the horizontal part -alpha times half the node average of p (a wall node sees one cell:
  // weight 1/2, an interior node averages two: 1/4 each), and the vertical part beta (p_above - p_below) for interior
  // nodes (w stays zero on the ground and top walls). With rho = 1 this is -alpha Z_A + beta Z_delta.
  private tridiagonal(mode: number, a: number, b: number, nc: number, cl: number) {
    const re = this.re, im = this.im, cp = this.cp, dRe = this.dRe, dIm = this.dIm
    // The horizontally uniform mode is singular (pressure defined up to a constant): pin the lowest cell.
    const pinned = a === 0
    const rho = this.rho, node = (n: number) => n === 0 || n === nc ? -a / 2 : -a / 4 - b
    const lower = (k: number) => k === 0 ? 0 : rho[k] * (-a / 4 + b)
    const upper = (k: number) => k === nc - 1 ? 0 : rho[k + 1] * (-a / 4 + b)
    const diag = (k: number) => rho[k] * node(k) + rho[k + 1] * node(k + 1)
    for (let k = 0; k < nc; k++) {
      let lo = lower(k), di = diag(k), up = upper(k), r = re[mode + k * cl], s = im[mode + k * cl]
      if (pinned && k === 0) { lo = 0; di = 1; up = 0; r = 0; s = 0 }
      if (pinned && k === 1) lo = 0
      const m = k === 0 ? di : di - lo * cp[k - 1]
      cp[k] = up / m
      dRe[k] = (r - lo * (k === 0 ? 0 : dRe[k - 1])) / m
      dIm[k] = (s - lo * (k === 0 ? 0 : dIm[k - 1])) / m
    }
    for (let k = nc - 1; k >= 0; k--) {
      if (k < nc - 1) { dRe[k] -= cp[k] * dRe[k + 1]; dIm[k] -= cp[k] * dIm[k + 1] }
      re[mode + k * cl] = dRe[k]; im[mode + k * cl] = dIm[k]
    }
  }
}
