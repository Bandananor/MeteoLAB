import { describe, expect, it } from 'vitest'
import { createGrid, Turbulence } from '.'

describe('Smagorinsky-Lilly turbulence', () => {
  const grid = createGrid({ nx: 16, ny: 12, nz: 8, width: 16 * 1200, depth: 12 * 1125, height: 7 * 652 })
  const rho = Array.from({ length: grid.nz }, (_, z) => 1.2 * Math.exp(-z * grid.dz / 8400))
  const f = (g: (x: number, y: number, z: number) => number) => Float32Array.from({ length: grid.n }, (_, i) => g(i % grid.nx, Math.floor(i / grid.nx) % grid.ny, Math.floor(i / grid.layer)))
  // A sheared jet: strong deformation in the middle of the box.
  const u = f((x, y, z) => 10 * Math.sin(2 * Math.PI * y / grid.ny) * (z > 0 && z < grid.nz - 1 ? 1 : 0)), v = f(() => 0), w = f(() => 0)

  it('mixes where the flow deforms and the air is not too stable, never in a stable calm environment', () => {
    const t = new Turbulence(grid, rho), neutral = new Array(grid.nz).fill(300)
    t.viscosity(u, v, w, f(() => 300), neutral, .18, 1)
    expect(Math.max(...t.km)).toBeGreaterThan(50)
    const stable = Array.from({ length: grid.nz }, (_, z) => 300 + z * grid.dz * .004)
    t.viscosity(f(() => 5), v, w, f((x, y, z) => stable[z]), stable, .18, 1)
    expect(Math.max(...t.km)).toBe(0)
  })

  it('smooths a perturbation, conserving its mass', () => {
    const t = new Turbulence(grid, rho), neutral = new Array(grid.nz).fill(300)
    t.viscosity(u, v, w, f(() => 300), neutral, .18, 1)
    const q = f((x, y, z) => (x === 8 && y === 0 && z === 3 ? 1 : 0)), base = new Array(grid.nz).fill(0)
    const mass = (a: Float32Array) => { let m = 0; for (let i = 0; i < a.length; i++) { const z = Math.floor(i / grid.layer); m += a[i] * rho[z] * (z === 0 || z === grid.nz - 1 ? .5 : 1) } return m }
    const before = mass(q)
    for (let s = 0; s < 200; s++) t.mix(q, base, 3, 1)
    expect(Math.max(...q)).toBeLessThan(.9); expect(Math.min(...q)).toBeGreaterThanOrEqual(0)
    expect(Math.abs(mass(q) / before - 1)).toBeLessThan(1e-4)
  })
})
