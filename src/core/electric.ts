import type { Grid } from './grid'
import { HorizontalDFT } from './spectral'
import { type Memory, PRIVATE_MEMORY } from './threads'

/** Vacuum permittivity, F/m. */
export const EPSILON0 = 8.8541878128e-12

/**
 * Electric potential of the storm's charge (2.3): ∇²φ = -ρ/ε0 at the grid nodes, ρ the net charge density (C/m³).
 * φ = 0 on the ground (a conductor) and at the top of the domain (the conducting upper atmosphere, as in storm
 * electrification models — Mansell et al. 2002 put it at 20 km); periodic in x and y like the model. The 7-point
 * Laplacian (stretched in z: (φ_{k+1}-φ_k)/dz_k - (φ_k-φ_{k-1})/dz_{k-1}, over hz_k) is diagonalised by the 2D DFT in
 * x and y, leaving one tridiagonal system per horizontal wavenumber over the interior levels — the same solve as the
 * pressure's (pressure.ts), on nodes and with fixed values at both ends instead of rigid walls.
 */
export class ElectricSolver {
  private readonly grid: Grid
  private readonly dft: HorizontalDFT
  /** Horizontal symbol of each mode (m + nx*n): minus the eigenvalue of the 5-point Laplacian, 1/m². */
  private readonly lambda: Float64Array
  private readonly interior: Float64Array
  private readonly cp: Float64Array; private readonly dRe: Float64Array; private readonly dIm: Float64Array

  constructor(grid: Grid, memory: Memory = PRIVATE_MEMORY) {
    const { nx, ny, nz, dx, dy } = grid
    if (nz < 3) throw new Error('the electric solver needs an interior level')
    this.grid = grid
    this.dft = new HorizontalDFT(nx, ny, nz - 2, memory, 'electric')
    this.lambda = new Float64Array(nx * ny)
    for (let n = 0; n < ny; n++) for (let m = 0; m < nx; m++) this.lambda[m + nx * n] = 4 * Math.sin(Math.PI * m / nx) ** 2 / (dx * dx) + 4 * Math.sin(Math.PI * n / ny) ** 2 / (dy * dy)
    this.interior = new Float64Array(nx * ny * (nz - 2))
    this.cp = new Float64Array(nz); this.dRe = new Float64Array(nz); this.dIm = new Float64Array(nz)
  }

  /** The potential (V) of the node charge density `rho` (C/m³) into `phi`; both are grid.n long, phi is 0 on the ground and top levels. */
  solve(rho: ArrayLike<number>, phi: { [i: number]: number; length: number }) {
    const { nx, ny, nz, layer, dzs, hz } = this.grid, ni = nz - 2, cl = nx * ny, inner = this.interior
    // Right-hand side of the interior levels: -ρ/ε0.
    for (let i = 0; i < cl * ni; i++) inner[i] = -rho[i + layer] / EPSILON0
    this.dft.forwardLayers(inner, 0, ni)
    const re = this.dft.re, im = this.dft.im, mh = this.dft.mh, cp = this.cp, dRe = this.dRe, dIm = this.dIm
    for (let n = 0; n < ny; n++) for (let m = 0; m <= mh; m++) {
      const mode = m + nx * n, lam = this.lambda[mode]
      // Row j is node level k = j + 1: lo φ_{k-1} + di φ_k + up φ_{k+1} = rhs, φ_0 = φ_{nz-1} = 0.
      for (let j = 0; j < ni; j++) {
        const k = j + 1, lo = 1 / (hz[k] * dzs[k - 1]), up = 1 / (hz[k] * dzs[k]), di = -lo - up - lam
        const a = j > 0 ? lo : 0, c = j < ni - 1 ? up : 0, r = re[mode + j * cl], s = im[mode + j * cl]
        const piv = j === 0 ? di : di - a * cp[j - 1]
        cp[j] = c / piv
        dRe[j] = (r - (j === 0 ? 0 : a * dRe[j - 1])) / piv
        dIm[j] = (s - (j === 0 ? 0 : a * dIm[j - 1])) / piv
      }
      for (let j = ni - 1; j >= 0; j--) {
        if (j < ni - 1) { dRe[j] -= cp[j] * dRe[j + 1]; dIm[j] -= cp[j] * dIm[j + 1] }
        re[mode + j * cl] = dRe[j]; im[mode + j * cl] = dIm[j]
      }
    }
    this.dft.inverseLayers(inner, 0, ni)
    for (let i = 0; i < layer; i++) { phi[i] = 0; phi[i + (nz - 1) * layer] = 0 }
    for (let i = 0; i < cl * ni; i++) phi[i + layer] = inner[i]
  }

  /**
   * Electric field E = -∇φ (V/m) at node (x, y, z): centred differences, periodic in x and y; on the ground and top
   * levels one-sided (φ is 0 there, the field normal to the conductor).
   */
  field(phi: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] {
    const { nx, ny, nz, dx, dy, zs, layer } = this.grid, at = (i: number, j: number, k: number) => phi[((i + nx) % nx) + ((j + ny) % ny) * nx + k * layer]
    const ex = -(at(x + 1, y, z) - at(x - 1, y, z)) / (2 * dx), ey = -(at(x, y + 1, z) - at(x, y - 1, z)) / (2 * dy)
    const lo = Math.max(0, z - 1), hi = Math.min(nz - 1, z + 1)
    return [ex, ey, -(at(x, y, hi) - at(x, y, lo)) / (zs[hi] - zs[lo])]
  }
}
