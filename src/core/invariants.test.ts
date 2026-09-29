import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid } from '.'
import { levelMean, QUIET, run, SUMMER_DAY, totalWater } from './fixtures'

// Default vertical grid, smaller periodic box: the invariants do not depend on the domain width and run ~10x faster.
const smallGrid = (nx: number, ny: number) => createGrid({ nx, ny, nz: 24, width: nx * 1200, depth: ny * 1125, height: 15_000 })

// Known failures are marked it.fails; each comment names the roadmap item that should make it pass.
// Before the consistent projection (2026-09-28): theta drifted 0.28 K and u 0.052 m/s in 3 h and a storm created
// +27 % of total water in 1 h. After it: theta 0.004 K, u 0.005 m/s, and +7.5 %/h of water from transport alone.

describe('background state without a trigger', () => {
  const model = new AtmosphereModel({ ...QUIET }, smallGrid(12, 10))
  run(model, 3 * 3600)
  const { nz } = model.grid, env = model.env
  // Level 0 is excluded until the surface layer replaces the x0.94 drag at the ground.
  const levels = Array.from({ length: nz - 1 }, (_, k) => k + 1)
  const worst = (field: Float32Array, reference: Float64Array, relative = false) =>
    Math.max(...levels.map(z => Math.abs(levelMean(model, field, z) - reference[z]) / (relative ? reference[z] : 1)))

  // Passing since the consistent projection and the top-boundary advection fix (before: 0.28 K and 0.052 m/s).
  it('keeps theta(z) within 0.05 K for 3 hours', () => { expect(worst(model.theta, env.theta)).toBeLessThan(.05) })
  it('keeps the wind profile within 0.05 m/s for 3 hours', () => {
    expect(worst(model.u, env.u)).toBeLessThan(.05)
    expect(worst(model.v, env.v)).toBeLessThan(.05)
  })
  // Measured against the surface value: near the tropopause q is ~1000x smaller and a relative error there is noise.
  // Passing since the hidden q *= 0.999999 sink was removed (it destroyed 1 % in 3 h).
  it('keeps q(z) within 0.2 % of its surface value for 3 hours', () => { expect(worst(model.q, env.q) / env.q[0]).toBeLessThan(.002) })
})

describe('pressure projection', () => {
  // A horizontally uniform w with w=0 at the ground and the top violates mass conservation, so a projection must remove it.
  // The old SOR projection (compact Laplacian, central divergence/gradient) removed exactly half of it.
  it('removes a horizontally uniform vertical velocity', () => {
    const model = new AtmosphereModel({ ...QUIET }, smallGrid(12, 10)), { layer, nz } = model.grid
    model.u.fill(0); model.v.fill(0); model.w.fill(0); model.pressure.fill(0)
    for (let i = layer; i < (nz - 1) * layer; i++) model.w[i] = .01
    ;(model as unknown as { project(dt: number): void }).project(1)
    for (let z = 1; z < nz - 1; z++) expect(Math.abs(levelMean(model, model.w, z))).toBeLessThan(1e-4)
  })

  it('leaves no dual-cell divergence after a stormy step', () => {
    const model = new AtmosphereModel({ ...SUMMER_DAY }, smallGrid(20, 16))
    run(model, 900)
    const solver = (model as unknown as { solver: { cells: number; divergence(u: Float32Array, v: Float32Array, w: Float32Array, dt: number, out: Float64Array): void } }).solver
    const div = new Float64Array(solver.cells)
    solver.divergence(model.u, model.v, model.w, 1, div)
    // Velocities are stored as float32 (~1e-8 s-1 of rounding); storm divergence before the projection is ~1e-3 s-1.
    expect(Math.max(...div.map(Math.abs))).toBeLessThan(1e-7)
    // A 15-minute storm stays inside the working range: the velocity safety limits never fire.
    expect(model.clipped).toBe(0)
  })
})

describe('water budget', () => {
  // No sunshine, so no surface evaporation; rain that reaches the ground is counted. History: +27 %/h before the
  // consistent projection, +7.5 %/h after it (transport), -0.98 %/h with the mass fixer (hidden decay sinks), ~0 now.
  it('conserves total water within 0.1 % per hour in a storm', () => {
    const model = new AtmosphereModel({ ...SUMMER_DAY, solarMax: 0 }, smallGrid(20, 16))
    const before = totalWater(model)
    run(model, 3600)
    expect(Math.abs(totalWater(model) / before - 1)).toBeLessThan(.001)
  })
})
