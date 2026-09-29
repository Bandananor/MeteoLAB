import { describe, expect, it } from 'vitest'
import { createGrid } from './grid'
import { PressureSolver } from './pressure'

// Random velocities on small grids (even sizes include the (pi, pi) null mode that once blew up the solve).
const cases: [number, number, number][] = [[1, 1, 4], [4, 1, 3], [4, 4, 4], [8, 6, 5], [12, 10, 24], [40, 32, 24]]

describe('PressureSolver', () => {
  for (const [nx, ny, nz] of cases) for (const anelastic of [false, true]) {
    it(`removes the dual-cell divergence of a random ${anelastic ? 'mass flux (rho0 falls 6x)' : 'field'} on ${nx}x${ny}x${nz}`, () => {
      const grid = createGrid({ nx, ny, nz, width: nx * 1200, depth: ny * 1125, height: 15_000 })
      const solver = new PressureSolver(grid, anelastic ? Array.from({ length: nz }, (_, z) => 1.2 * Math.exp(-z * grid.dz / 8400)) : undefined)
      let seed = 12345
      const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - .5
      const u = new Float32Array(grid.n).map(random), v = new Float32Array(grid.n).map(random), w = new Float32Array(grid.n).map(random)
      for (let i = 0; i < grid.layer; i++) { w[i] = 0; w[i + (nz - 1) * grid.layer] = 0 }
      const div = new Float64Array(solver.cells), p = new Float64Array(solver.cells)
      solver.divergence(u, v, w, 1, div)
      const before = Math.max(...div.map(Math.abs))
      solver.solve(div.slice(), p)
      solver.correct(p, u, v, w, 1)
      solver.divergence(u, v, w, 1, div)
      expect(p.every(Number.isFinite)).toBe(true)
      expect(Math.max(...div.map(Math.abs))).toBeLessThan(before * 1e-6)
    })
  }
})
