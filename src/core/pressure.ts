import type { Grid } from './grid'
import { HorizontalDFT } from './spectral'
import { type Memory, PRIVATE_MEMORY } from './threads'

/**
 * Exact, consistent pressure projection for node-based velocities, anelastic: the mass flux rho0(z) u is made
 * divergence-free (rho0 = 1 everywhere gives the incompressible projection).
 *
 * Velocities live at grid nodes; pressure lives at the centres of the "dual" cells between nodes
 * (nx * ny * (nz-1) cells, periodic in x and y, the ground and top node levels are rigid walls).
 * D is the net flux out of a dual cell computed from its 8 corner nodes (per unit volume; the cell between levels k
 * and k+1 is dz_k = zs[k+1] - zs[k] high, stretched or not). G = -H^-1 D^T V is minus its adjoint with the cell
 * volumes V (dz_k) and the node volumes H (hz: half a layer at the walls); with R = diag(rho0 of each node level),
 * D·R·G is the consistent (density-weighted) Laplacian and u - dt·G·p makes D·R·u exactly zero. The correction is the
 * kinetic-energy-minimising one for the rho0-weighted norm, i.e. the gradient of p'/rho0. D·R·G is diagonalised by
 * a 2D DFT in x, y (rho0 and the spacings depend on z only), leaving one tridiagonal system per horizontal wavenumber.
 */
export class PressureSolver {
  readonly cells: number
  private readonly grid: Grid
  private readonly dft: HorizontalDFT
  /** Horizontal symbols per mode (m + nx*n): alpha of the horizontal Laplacian, beta of the 4-node horizontal average. */
  private readonly alpha: Float64Array; private readonly beta: Float64Array
  private readonly re: Float64Array; private readonly im: Float64Array
  private readonly cp: Float64Array; private readonly dRe: Float64Array; private readonly dIm: Float64Array
  /** Base-state density of each node level (ones: incompressible). */
  private readonly rho: Float64Array

  /** `memory` holds the spectra, which helper threads share (threads.ts). */
  constructor(grid: Grid, density?: ArrayLike<number>, memory: Memory = PRIVATE_MEMORY) {
    const { nx, ny, nz, dx, dy } = grid
    this.grid = grid
    this.rho = density ? Float64Array.from(density) : new Float64Array(nz).fill(1)
    if (this.rho.length !== nz) throw new Error(`density needs ${nz} levels, got ${this.rho.length}`)
    this.cells = nx * ny * (nz - 1)
    this.dft = new HorizontalDFT(nx, ny, nz - 1, memory, 'pressure')
    this.alpha = new Float64Array(nx * ny); this.beta = new Float64Array(nx * ny)
    // cos^2 of pi/2 is 3.7e-33 in floating point, not 0; the null modes must be exactly zero or the solve blows up.
    const exact = (x: number) => x < 1e-12 ? 0 : x > 1 - 1e-12 ? 1 : x
    for (let n = 0; n < ny; n++) for (let m = 0; m < nx; m++) {
      const sx = exact(Math.sin(Math.PI * m / nx) ** 2), cx = exact(Math.cos(Math.PI * m / nx) ** 2), sy = exact(Math.sin(Math.PI * n / ny) ** 2), cy = exact(Math.cos(Math.PI * n / ny) ** 2)
      this.alpha[m + nx * n] = 4 * (sx * cy / (dx * dx) + cx * sy / (dy * dy))
      this.beta[m + nx * n] = cx * cy
    }
    this.re = this.dft.re; this.im = this.dft.im
    this.cp = new Float64Array(nz); this.dRe = new Float64Array(nz); this.dIm = new Float64Array(nz)
  }

  /** Dual-cell divergence of the node mass flux rho0 u, divided by dt, into `out` (length `cells`); cell layers k0..k1-1. */
  divergence(u: Float32Array, v: Float32Array, w: Float32Array, dt: number, out: Float64Array, k0 = 0, k1 = this.grid.nz - 1) {
    const { nx, ny, dx, dy, dzs, layer } = this.grid
    for (let k = k0, c = k0 * nx * ny; k < k1; k++) {
      const l0 = k * layer, l1 = l0 + layer, r0 = this.rho[k] / 4, r1 = this.rho[k + 1] / 4, dz = dzs[k]
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

  /** Subtracts dt * G p from the node velocities of levels k0..k1-1; w at the wall levels stays untouched (it is zero). */
  correct(p: Float64Array, u: Float32Array, v: Float32Array, w: Float32Array, dt: number, k0 = 0, k1 = this.grid.nz) {
    const { nx, ny, nz, dx, dy, dzs, hz, layer } = this.grid, cl = nx * ny
    for (let k = k0; k < k1; k++) {
      // Dual-cell layers touching node level k, weighted by their height over the node's (V/H): a wall level sees one
      // layer with weight 2 on a uniform grid.
      const lo = Math.max(0, k - 1) * cl, hi = Math.min(nz - 2, k) * cl
      const wLo = k > 0 ? dzs[k - 1] / hz[k] : 0, wHi = k < nz - 1 ? dzs[k] / hz[k] : 0
      for (let j = 0; j < ny; j++) {
        const jm = ((j + ny - 1) % ny) * nx, j0 = j * nx
        for (let i = 0; i < nx; i++) {
          const im = (i + nx - 1) % nx, node = i + j * nx + k * layer
          const P = (ii: number, jj: number, base: number) => p[base + ii + jj]
          const gx = (wLo * (P(i, jm, lo) + P(i, j0, lo) - P(im, jm, lo) - P(im, j0, lo)) + wHi * (P(i, jm, hi) + P(i, j0, hi) - P(im, jm, hi) - P(im, j0, hi))) / (4 * dx)
          const gy = (wLo * (P(im, j0, lo) + P(i, j0, lo) - P(im, jm, lo) - P(i, jm, lo)) + wHi * (P(im, j0, hi) + P(i, j0, hi) - P(im, jm, hi) - P(i, jm, hi))) / (4 * dy)
          u[node] -= dt * gx; v[node] -= dt * gy
          if (k > 0 && k < nz - 1) {
            const below = (k - 1) * cl, above = k * cl
            const gz = (P(im, jm, above) + P(i, jm, above) + P(im, j0, above) + P(i, j0, above) - P(im, jm, below) - P(i, jm, below) - P(im, j0, below) - P(i, j0, below)) / (4 * hz[k])
            w[node] -= dt * gz
          }
        }
      }
    }
  }

  /** Solves (D·R·G) p = rhs exactly; rhs is consumed (overwritten). Null modes of D·R·G get p = 0. */
  solve(rhs: Float64Array, p: Float64Array) {
    const nc = this.grid.nz - 1
    this.transform(rhs, 0, nc); this.modes(0, this.grid.ny); this.back(p, 0, nc)
  }

  // The three parts of solve, for helper threads: the forward transform of cell layers k0..k1-1 (rhs consumed), the
  // tridiagonal systems of the modes with y-wavenumbers n0..n1-1, the inverse transform of layers k0..k1-1 into p.
  transform(rhs: Float64Array, k0: number, k1: number) { this.dft.forwardLayers(rhs, k0, k1) }
  back(p: Float64Array, k0: number, k1: number) { this.dft.inverseLayers(p, k0, k1) }
  modes(n0: number, n1: number) {
    const { nx, nz } = this.grid, cl = nx * this.grid.ny, nc = nz - 1, re = this.re, im = this.im, mh = this.dft.mh
    // One tridiagonal system per mode.
    for (let n = n0; n < n1; n++) for (let m = 0; m <= mh; m++) {
      const mode = m + nx * n, a = this.alpha[mode], b = this.beta[mode]
      if (a === 0 && b === 0 || nc === 1 && a === 0) { for (let k = 0; k < nc; k++) re[mode + k * cl] = im[mode + k * cl] = 0; continue }
      this.tridiagonal(mode, a, b, nc, cl)
    }
  }

  // Thomas algorithm for one horizontal mode. Row k (the cell between node levels k and k+1, dz_k high) collects, from
  // each of its two node levels n, rho_n times: the horizontal part -alpha/2 times the node's gradient weights
  // dz_c / (2 hz_n) of the cells c touching it (uniform: 1/2 each for an interior node, 1 for a wall node), and the
  // vertical part beta (p_above - p_below) / (hz_n dz_k) for interior nodes (w stays zero on the ground and top walls).
  // On a uniform grid: -alpha Z_A + beta Z_delta / dz^2.
  private tridiagonal(mode: number, a: number, b: number, nc: number, cl: number) {
    const re = this.re, im = this.im, cp = this.cp, dRe = this.dRe, dIm = this.dIm, { dzs, hz } = this.grid
    // The horizontally uniform mode is singular (pressure defined up to a constant): pin the lowest cell.
    const pinned = a === 0
    const rho = this.rho
    for (let k = 0; k < nc; k++) {
      let di = -a / 2 * (rho[k] * dzs[k] / (2 * hz[k]) + rho[k + 1] * dzs[k] / (2 * hz[k + 1])), lo = 0, up = 0
      if (k > 0) { lo = -a / 2 * rho[k] * dzs[k - 1] / (2 * hz[k]); const v = b * rho[k] / (hz[k] * dzs[k]); lo += v; di -= v }
      if (k < nc - 1) { up = -a / 2 * rho[k + 1] * dzs[k + 1] / (2 * hz[k + 1]); const v = b * rho[k + 1] / (hz[k + 1] * dzs[k]); up += v; di -= v }
      let r = re[mode + k * cl], s = im[mode + k * cl]
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
