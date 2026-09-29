import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, SCENARIOS } from '.'
import { levelMean, QUIET, run, SUMMER_DAY, totalWater } from './fixtures'

// Default vertical grid, smaller periodic box: the invariants do not depend on the domain width and run ~10x faster.
const smallGrid = (nx: number, ny: number) => createGrid({ nx, ny, nz: 24, width: nx * 1200, depth: ny * 1125, height: 15_000 })
// Storms for the invariants: the realistic "Летний день" (ML CAPE ~2.7 kJ/kg). The old SUMMER_DAY fixture (CAPE ~6 kJ/kg)
// drove a WENO-transported updraught into the old 60 m/s limiter, which breaks the projection's exactness by design.
const STORM = { ...SUMMER_DAY, ...SCENARIOS[0].values }

// Known failures are marked it.fails; each comment names the roadmap item that should make it pass.
// Before the consistent projection (2026-09-28): theta drifted 0.28 K and u 0.052 m/s in 3 h and a storm created
// +27 % of total water in 1 h. After it: theta 0.004 K, u 0.005 m/s, and +7.5 %/h of water from transport alone.

describe('background state without a trigger', () => {
  const model = new AtmosphereModel({ ...QUIET }, smallGrid(12, 10))
  run(model, 3 * 3600)
  const { nz } = model.grid, env = model.env
  // All levels, the ground included (since the surface drag replaced the x0.94 damping there).
  const levels = Array.from({ length: nz }, (_, k) => k)
  const worst = (field: Float32Array, reference: Float64Array, relative = false) =>
    Math.max(...levels.map(z => Math.abs(levelMean(model, field, z) - reference[z]) / (relative ? reference[z] : 1)))

  // Passing since the consistent projection and the top-boundary advection fix (before: 0.28 K and 0.052 m/s).
  it('keeps theta(z) within 0.05 K for 3 hours', () => { expect(worst(model.theta, env.theta)).toBeLessThan(.05) })
  it('keeps the wind profile within 0.05 m/s for 3 hours', () => {
    expect(worst(model.u, env.u)).toBeLessThan(.05)
    expect(worst(model.v, env.v)).toBeLessThan(.05)
  })
  // Measured against the surface value: near the tropopause q is ~1000x smaller and a relative error there is noise.
  // Passing since the hidden q *= 0.999999 sink was removed (it destroyed 1 % in 3 h). With WENO (default since
  // 2026-09-29) the total is conserved exactly, but the two lowest levels exchange ~0.5 % of the surface q in 3 h: the
  // upwind-biased scheme, lower order next to the ground, diffuses the moisture gradient a little under the ~2 cm/s
  // gravity-wave noise (0.2 % before; the semi-Lagrangian scheme never mixed the ground level with the next one at all).
  it('keeps q(z) within 1 % of its surface value for 3 hours', () => { expect(worst(model.q, env.q) / env.q[0]).toBeLessThan(.01) })
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
    const model = new AtmosphereModel({ ...STORM }, smallGrid(20, 16))
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
  // consistent projection, +7.5 %/h after it (transport), -0.98 %/h with the mass fixer (hidden decay sinks), ~0 with it;
  // with WENO there is no mass fixer: the projected face fluxes conserve water by themselves (checked below).
  it('conserves total water within 0.1 % per hour in a storm', () => {
    const model = new AtmosphereModel({ ...STORM, solarMax: 0 }, smallGrid(20, 16))
    const before = totalWater(model)
    run(model, 3600)
    // Rain reaches the ground (sedimentation into rain-free air under the shaft once failed silently: water was conserved).
    expect(Math.max(...model.precipitation)).toBeGreaterThan(1)
    expect(Math.abs(totalWater(model) / before - 1)).toBeLessThan(.001)
  })

  // WENO without any mass fixer: flux form on projected face fluxes, flux-form sedimentation, conservative positivity fix.
  it('conserves total water within 0.01 % in a 30-minute storm with WENO transport and no mass fixer', () => {
    const model = new AtmosphereModel({ ...STORM, solarMax: 0 }, smallGrid(20, 16))
    model.transport = 'weno'
    const before = totalWater(model)
    run(model, 1800)
    expect(Math.max(...model.precipitation)).toBeGreaterThan(.1)
    expect(Math.abs(totalWater(model) / before - 1)).toBeLessThan(1e-4)
  })
})
