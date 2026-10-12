import { describe, expect, it } from 'vitest'
import { EPSILON0, ElectricSolver } from './electric'
import { createGrid } from './grid'

describe('electric field (2.3): the potential of the storm charge', () => {
  it('solves the discrete Poisson equation exactly, on a uniform and a stretched grid', () => {
    for (const bottom of [undefined, 150]) {
      const grid = createGrid({ nx: 12, ny: 10, nz: 18, width: 12 * 1200, depth: 10 * 1100, height: 18_000, bottomSpacing: bottom })
      const { nx, ny, nz, dx, dy, dzs, hz, layer } = grid, solver = new ElectricSolver(grid)
      let seed = 7
      const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - .5
      const rho = new Float64Array(grid.n).map(() => random() * 1e-9), phi = new Float64Array(grid.n)
      solver.solve(rho, phi)
      // The discrete Laplacian of the solution gives back -ρ/ε0 at every interior node.
      const at = (i: number, j: number, k: number) => phi[((i + nx) % nx) + ((j + ny) % ny) * nx + k * layer]
      let worst = 0, scale = 0
      for (let k = 1; k < nz - 1; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const lap = (at(i + 1, j, k) - 2 * at(i, j, k) + at(i - 1, j, k)) / (dx * dx) + (at(i, j + 1, k) - 2 * at(i, j, k) + at(i, j - 1, k)) / (dy * dy)
          + ((at(i, j, k + 1) - at(i, j, k)) / dzs[k] - (at(i, j, k) - at(i, j, k - 1)) / dzs[k - 1]) / hz[k]
        const target = -rho[i + j * nx + k * layer] / EPSILON0
        worst = Math.max(worst, Math.abs(lap - target)); scale = Math.max(scale, Math.abs(target))
      }
      expect(worst / scale).toBeLessThan(1e-9)
      for (let i = 0; i < layer; i++) { expect(phi[i]).toBe(0); expect(phi[i + (nz - 1) * layer]).toBe(0) }
    }
  })

  it('a charged layer between the ground and the top: the parallel-plate field above and below it', () => {
    // 1 nC/m³ between 6 and 8 km under a top at 20 km: a sheet of σ = 2 µC/m² at h = 7 km. Below it
    // E_z = -σ (H - h) / (H ε0) (pointing down to the ground), above it +σ h / (H ε0).
    const grid = createGrid({ nx: 4, ny: 4, nz: 81, width: 4000, depth: 4000, height: 20_000 }), solver = new ElectricSolver(grid)
    const rho = new Float64Array(grid.n), phi = new Float64Array(grid.n)
    for (let k = 0; k < grid.nz; k++) if (grid.zs[k] >= 6000 && grid.zs[k] <= 8000) for (let i = 0; i < grid.layer; i++) rho[i + k * grid.layer] = 1e-9
    // Nodes own hz of height: the 9 nodes from 6 to 8 km carry 9 × 250 m (the end nodes half of a 250 m cell more).
    const sigma = 1e-9 * 9 * 250, h = 7000, H = 20_000
    solver.solve(rho, phi)
    const [, , below] = solver.field(phi, 1, 1, 8), [, , above] = solver.field(phi, 1, 1, 60)
    expect(below / (-sigma * (H - h) / (H * EPSILON0))).toBeCloseTo(1, 6)
    expect(above / (sigma * h / (H * EPSILON0))).toBeCloseTo(1, 6)
    // ~165 kV/m under such a layer: the order of the fields measured in storms (up to a few hundred kV/m).
    expect(Math.abs(below)).toBeGreaterThan(160e3); expect(Math.abs(below)).toBeLessThan(170e3)
  })

  it('a point charge far from the edges: Coulomb with its images in the ground and the top', () => {
    // 1 C at 6 km over a 60 × 60 km domain with 500 m spacing; 12 nodes (6 km) away the field within 2 % (the error of
    // a charge smeared over one cell and a centred difference falls as (spacing / distance)²: ~5 % at 6 nodes).
    const n = 120, grid = createGrid({ nx: n, ny: n, nz: 41, width: 60_000, depth: 60_000, height: 20_000 }), solver = new ElectricSolver(grid)
    const rho = new Float64Array(grid.n), phi = new Float64Array(grid.n), c = n / 2, kc = 12, Q = 1
    rho[c + c * n + kc * grid.layer] = Q / (grid.dx * grid.dy * grid.hz[kc])
    solver.solve(rho, phi)
    const coulomb = (x: number, y: number, z: number) => {
      // Images: +Q at 2mH + h, -Q at 2mH - h (φ = 0 on z = 0 and z = H), and the periodic copies of the domain.
      let ex = 0, ey = 0, ez = 0
      for (let px = -1; px <= 1; px++) for (let py = -1; py <= 1; py++) for (let m = -6; m <= 6; m++) for (const [zq, q] of [[2 * m * 20_000 + 6000, Q], [2 * m * 20_000 - 6000, -Q]] as const) {
        const rx = x - px * 60_000, ry = y - py * 60_000, rz = z - zq, r = Math.hypot(rx, ry, rz), f = q / (4 * Math.PI * EPSILON0 * r ** 3)
        ex += f * rx; ey += f * ry; ez += f * rz
      }
      return [ex, ey, ez]
    }
    for (const [dxn, dyn, k] of [[12, 0, kc], [0, -12, kc], [9, 9, kc], [0, 0, kc + 12], [12, 0, 2]]) {
      const got = solver.field(phi, c + dxn, c + dyn, k), want = coulomb(dxn * grid.dx, dyn * grid.dy, grid.zs[k])
      const err = Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]) / Math.hypot(...want)
      expect(err).toBeLessThan(.02)
    }
  })
})
