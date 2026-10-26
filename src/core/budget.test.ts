import { describe, expect, it } from 'vitest'
import { AtmosphereModel, BUDGET_TERMS, controlBuffer, createGrid, DT, type GridOptions, SharedMemory, ThreadRunner } from '.'
import { SUMMER_DAY } from './fixtures'

const run = (budget: boolean, steps: number) => {
  const m = new AtmosphereModel({ ...SUMMER_DAY, budget })
  const start = Float32Array.from(m.theta)
  for (let k = 0; k < steps; k++) { m.step(DT); m.time += DT }
  return { m, start }
}

describe('the heat budget (roadmap D2)', () => {
  it('is off by default and does not change the run when on', () => {
    const off = run(false, 40), on = run(true, 40)
    expect(off.m.budget).toBeNull()
    expect(on.m.budget).not.toBeNull()
    expect(Array.from(on.m.theta)).toEqual(Array.from(off.m.theta))
    expect(Array.from(on.m.w)).toEqual(Array.from(off.m.w))
  })

  it("adds up to theta's change over the domain (transport and mixing only move theta about)", () => {
    const { m, start } = run(true, 120), { nz, layer } = m.grid, rho = m.env.rho, hz = m.grid.hz
    let change = 0, terms = 0, heat = 0
    for (let z = 0; z < nz; z++) for (let i = z * layer; i < (z + 1) * layer; i++) {
      const mass = rho[z] * hz[z]
      change += mass * (m.theta[i] - start[i])
      for (const t of BUDGET_TERMS) terms += mass * m.budget![t][i]
      heat += mass * Math.abs(m.budget!.surface[i]) + mass * Math.abs(m.budget!.condensation[i])
    }
    // The ground and the clouds heat the air within 6 min; what the terms hold is that heat, to the transport's error.
    expect(heat).toBeGreaterThan(0)
    expect(Math.abs(terms - change)).toBeLessThan(.02 * Math.abs(change))
  })

  it('runs the same through the threads, the terms too', () => {
    const grid: GridOptions = { nx: 16, ny: 12, nz: 24, width: 19_200, depth: 13_500, height: 15_000, bottomSpacing: 100 }
    const make = (threaded: boolean) => {
      const m = new AtmosphereModel({ ...SUMMER_DAY, bubble: 1.4, budget: true }, createGrid(grid), undefined, { memory: threaded ? new SharedMemory() : undefined })
      if (threaded) { m.transportSlabs = 10; m.runner = new ThreadRunner(m, controlBuffer(), 0) }
      for (let k = 0; k < 600; k++) { m.step(1); m.time += 1 }
      return m
    }
    const plain = make(false), threaded = make(true)
    expect(Math.max(...plain.rain)).toBeGreaterThan(1e-4)
    for (const t of BUDGET_TERMS) expect(threaded.budget![t].every((v, i) => Object.is(v, plain.budget![t][i]))).toBe(true)
    // Rain has evaporated somewhere by now: the term holds cooling.
    expect(Math.min(...plain.budget!.evaporation)).toBeLessThan(0)
  })

  it('carries the terms with the air in the semi-Lagrangian transport too', () => {
    const m = new AtmosphereModel({ ...SUMMER_DAY, budget: true, followStorm: false }), { nx, ny, layer, zs } = m.grid
    m.transport = 'semi-lagrangian'
    // A mark in the dry air at ~8 km, in the westerlies, in a term and in the cold-pool indicator (both carried, neither made
    // there; the indicator is not mixed and its tails under 1e-3 K are cut, so the two centres differ by part of a node).
    const z = zs.findIndex(h => h >= 8000), c = (nx >> 1) + nx * (ny >> 1), i = c + z * layer
    m.budget!.other[i] = 5; m.cold[i] = 5
    for (let k = 0; k < 200; k++) { m.step(DT); m.time += DT }
    const centre = (a: Float32Array) => { let sx = 0, sy = 0, s = 0; for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) { const v = Math.abs(a[x + nx * y + z * layer]); sx += v * x; sy += v * y; s += v } return [sx / s, sy / s] }
    const [x, y] = centre(m.budget!.other), [cx, cy] = centre(m.cold)
    expect(Math.hypot(cx - (nx >> 1), cy - (ny >> 1))).toBeGreaterThan(1)
    expect(Math.hypot(x - (nx >> 1), y - (ny >> 1))).toBeGreaterThan(1); expect(Math.hypot(x - cx, y - cy)).toBeLessThan(1)
  })
})
