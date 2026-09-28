import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid } from '.'
import { levelMean, QUIET, run, SUMMER_DAY, totalWater } from './fixtures'

// Default vertical grid, smaller periodic box: the invariants do not depend on the domain width and run ~10x faster.
const smallGrid = (nx: number, ny: number) => createGrid({ nx, ny, nz: 24, width: nx * 1200, depth: ny * 1125, height: 15_000 })

// Every test here is a known failure today; each comment names the roadmap item that should make it pass.
// Measured on 2026-09-28 (commit after 9279b97): theta drifts 0.28 K and u 0.052 m/s in 3 h, q up to 15 % near the top,
// and a storm creates +27 % of total water in 1 h.

describe('background state without a trigger', () => {
  const model = new AtmosphereModel({ ...QUIET }, smallGrid(12, 10))
  run(model, 3 * 3600)
  const { nz } = model.grid, env = model.env
  // Level 0 is excluded until the surface layer replaces the x0.94 drag at the ground.
  const levels = Array.from({ length: nz - 1 }, (_, k) => k + 1)
  const worst = (field: Float32Array, reference: Float64Array, relative = false) =>
    Math.max(...levels.map(z => Math.abs(levelMean(model, field, z) - reference[z]) / (relative ? reference[z] : 1)))

  // Fails: the projection removes only half of a level-mean w, leaving ~ -1.6 mm/s of spurious subsidence
  // (consistent projection operator), and the top level mixes in 0.1 %/step of the level below (top-boundary advection).
  it.fails('keeps theta(z) within 0.05 K for 3 hours', () => { expect(worst(model.theta, env.theta)).toBeLessThan(.05) })
  // Fails for the same spurious subsidence advecting the sheared wind profile.
  it.fails('keeps the wind profile within 0.05 m/s for 3 hours', () => {
    expect(worst(model.u, env.u)).toBeLessThan(.05)
    expect(worst(model.v, env.v)).toBeLessThan(.05)
  })
  // Fails: q *= 0.999999 every step (hidden sinks), plus the two problems above.
  it.fails('keeps q(z) within 0.2 % for 3 hours', () => { expect(worst(model.q, env.q, true)).toBeLessThan(.002) })
})

describe('pressure projection', () => {
  // A horizontally uniform w with w=0 at the ground and the top violates mass conservation, so a projection must remove it.
  // Fails: with the compact Laplacian but central-difference divergence/gradient, even a fully converged solve removes
  // exactly half of it (10 mm/s -> 5.00 mm/s). Roadmap: consistent projection operator.
  it.fails('removes a horizontally uniform vertical velocity', () => {
    const model = new AtmosphereModel({ ...QUIET }, smallGrid(12, 10)), { layer, nz } = model.grid
    model.u.fill(0); model.v.fill(0); model.w.fill(0); model.pressure.fill(0)
    for (let i = layer; i < (nz - 1) * layer; i++) model.w[i] = .01
    ;(model as unknown as { project(dt: number, iters: number): void }).project(1, 2000)
    for (let z = 1; z < nz - 1; z++) expect(Math.abs(levelMean(model, model.w, z))).toBeLessThan(1e-4)
  })
})

describe('water budget', () => {
  // No sunshine, so no surface evaporation. Rain does leave through the ground but is not counted yet, so this compares
  // q + cloud + rain in the air plus nothing. Fails today mainly because semi-Lagrangian transport on the checkerboard
  // velocity left by the inconsistent projection creates water (+27 % in 1 h); then rain fallout accounting and hidden sinks.
  it.fails('conserves total water within 1 % per hour in a storm', () => {
    const model = new AtmosphereModel({ ...SUMMER_DAY, solarMax: 0 }, smallGrid(20, 16))
    const before = totalWater(model)
    run(model, 3600)
    expect(Math.abs(totalWater(model) / before - 1)).toBeLessThan(.01)
  })
})
