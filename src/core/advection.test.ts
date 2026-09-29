import { describe, expect, it } from 'vitest'
import { createGrid, FluxTransport, weno } from '.'

describe('WENO5 flux-form transport', () => {
  it('reconstructs smooth data to fifth order and does not overshoot a step', () => {
    // Cell averages of x^2 over unit cells centred at -2..2 are i^2 + 1/12; the face at x = 0.5 is exactly 0.25.
    const avg = (i: number) => i * i + 1 / 12
    expect(weno(avg(-2), avg(-1), avg(0), avg(1), avg(2))).toBeCloseTo(.25, 3)
    const step = weno(0, 0, 0, 1, 1)
    expect(step).toBeGreaterThanOrEqual(-1e-9); expect(step).toBeLessThanOrEqual(1)
  })

  const setup = (nx: number) => {
    const grid = createGrid({ nx, ny: 6, nz: 5, width: nx * 1000, depth: 6000, height: 4000 })
    const rho = [1.2, 1.1, 1, .9, .8], t = new FluxTransport(grid, rho)
    const u = new Float32Array(grid.n).fill(10), v = new Float32Array(grid.n), w = new Float32Array(grid.n)
    t.setVelocity(u, v, w)
    return { grid, t, rho }
  }

  it('keeps a uniform field uniform and conserves mass', () => {
    const { grid, t, rho } = setup(20), q = new Float32Array(grid.n).fill(.01)
    for (let s = 0; s < 100; s++) t.advect(q, 5)
    expect(Math.max(...q.map(x => Math.abs(x - .01)))).toBeLessThan(1e-8)
    const blob = new Float32Array(grid.n).map((_, i) => Math.exp(-((((i % 20) - 10) / 2) ** 2)))
    const mass = (a: Float32Array) => { let m = 0; for (let i = 0; i < a.length; i++) m += a[i] * rho[Math.floor(i / grid.layer)]; return m }
    const before = mass(blob)
    for (let s = 0; s < 100; s++) t.advect(blob, 5)
    expect(Math.abs(mass(blob) / before - 1)).toBeLessThan(1e-5)
  })

  it('carries a 3-node blob once around the domain keeping most of its peak', () => {
    const { grid, t } = setup(40), q = new Float32Array(grid.n).map((_, i) => Math.exp(-((((i % 40) - 20) / 3) ** 2)))
    // 40 km at 10 m/s = 4000 steps of the model's 1 s: WENO keeps 0.91 of the peak, trilinear semi-Lagrangian 0.32.
    for (let s = 0; s < 4000; s++) t.advect(q, 1)
    const peak = Math.max(...q), min = Math.min(...q)
    expect(peak).toBeGreaterThan(.88); expect(min).toBeGreaterThan(-.02)
    expect(q.indexOf(peak) % 40).toBe(20)
  })
})
