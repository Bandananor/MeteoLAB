import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, DT, MaskedProjection, solidMask, terrainHeights } from '.'
import { PressureSolver } from './pressure'
import { QUIET } from './fixtures'

const grid = createGrid({ nx: 32, ny: 24, nz: 30, width: 38_400, depth: 28_800, height: 15_000, bottomSpacing: 100 })

describe('terrain (terrain.ts, 3.0 block Д step 1)', () => {
  it('builds a hill, a ridge and a plateau of the asked height, smooth and periodic', () => {
    const hill = terrainHeights({ kind: 'hill', height: 1, width: 5 }, grid), { nx, ny } = grid
    const top = Math.max(...hill)
    expect(top).toBeGreaterThan(800); expect(top).toBeLessThanOrEqual(1000)
    expect(hill[0]).toBeLessThan(.15 * top)
    const ridge = terrainHeights({ kind: 'ridge', height: .8, width: 4 }, grid)
    // A north-south ridge: the same height along a column of x.
    for (let j = 1; j < ny; j++) expect(ridge[nx / 2 + nx * j]).toBeCloseTo(ridge[nx / 2], 3)
    const plateau = terrainHeights({ kind: 'plateau', height: .5, width: 8 }, grid)
    expect(plateau[nx / 2 + nx * ny / 2]).toBeGreaterThan(450); expect(plateau[0]).toBeLessThan(50)
  })

  it('projects a uniform wind over a hill: divergence-free over the fluid, zero in the ground, up the windward slope', () => {
    const rho = Float64Array.from({ length: grid.nz }, (_, z) => 1.2 * Math.exp(-grid.zs[z] / 9000))
    const solver = new PressureSolver(grid, rho), h = terrainHeights({ kind: 'hill', height: 1, width: 5 }, grid), solid = solidMask(grid, h)
    const masked = new MaskedProjection(grid, solver, solid), { n, nx, ny, layer } = grid
    const u = new Float32Array(n).fill(10), v = new Float32Array(n), w = new Float32Array(n), p = new Float64Array(solver.cells)
    const before = new Float64Array(solver.cells), after = new Float64Array(solver.cells)
    masked.mask(u, v, w); solver.divergence(u, v, w, 1, before)
    masked.project(u, v, w, DT, p)
    solver.divergence(u, v, w, 1, after)
    const norm = (a: Float64Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0))
    expect(masked.iterations).toBeGreaterThan(0); expect(masked.iterations).toBeLessThan(200)
    expect(norm(after) / norm(before)).toBeLessThan(1e-5)
    for (let i = 0; i < n; i++) if (solid[i]) { expect(u[i]).toBe(0); expect(w[i]).toBe(0) }
    // The first fluid node above the ground a hill's half-width upwind rises, downwind sinks (westerly flow).
    const cy = ny / 2, first = (x: number) => { let z = 0; while (solid[x + nx * cy + z * layer]) z++; return x + nx * cy + z * layer }
    const up = first(nx / 2 - 4), down = first(nx / 2 + 3)
    expect(w[up]).toBeGreaterThan(.5); expect(w[down]).toBeLessThan(-.5)
  })

  it('adds no motion to a resting atmosphere: the hill stirs it no more than the flat ground does', () => {
    // The model's own small starting perturbations stir a calm atmosphere to ~0.05 m/s in 5 min with or without terrain.
    const calm = { wind0: 0, wind05: 0, wind1: 0, wind3: 0, wind6: 0, wind10: 0, followStorm: false }
    const strongest = (terrain?: { kind: 'hill'; height: number; width: number }) => {
      const m = new AtmosphereModel({ ...QUIET, ...calm, solarMax: 0, bubble: 0, ...(terrain ? { terrain } : {}) }, grid)
      for (let t = 0; t < 5 * 60; t += DT) { m.step(DT); m.time += DT }
      let w = 0
      for (let i = 0; i < grid.n; i++) w = Math.max(w, Math.abs(m.w[i]))
      return w
    }
    const flat = strongest(), hill = strongest({ kind: 'hill', height: 1, width: 5 })
    expect(flat).toBeLessThan(.1); expect(hill).toBeLessThan(1.3 * flat + 1e-3)
  }, 120_000)

  it('is the flat ground bit for bit under half the lowest spacing (no solid node: the flat projection)', () => {
    const run = (terrain?: { kind: 'hill'; height: number; width: number }) => {
      const m = new AtmosphereModel({ ...QUIET, followStorm: false, bubble: 1.5, ...(terrain ? { terrain } : {}) }, grid)
      for (let t = 0; t < 3 * 60; t += DT) { m.step(DT); m.time += DT }
      return m
    }
    const flat = run(), low = run({ kind: 'hill', height: .04, width: 5 })
    expect(low.solid!.some(s => s === 1)).toBe(false)
    let same = true
    for (let i = 0; i < grid.n && same; i++) same = flat.w[i] === low.w[i] && flat.theta[i] === low.theta[i]
    expect(same).toBe(true)
  }, 120_000)
})
