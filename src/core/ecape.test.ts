import { describe, expect, it } from 'vitest'
import { createGrid, Environment, environmentProfile, parcelIndices, SCENARIOS, stormIndices } from '.'
import { ecapePsi, ecapeRatio } from './ecape'
import { SUMMER_DAY } from './fixtures'

const indices = (name: string) => {
  const c = { ...SUMMER_DAY, ...SCENARIOS.find(s => s.name === name)!.values }, grid = createGrid(), env = new Environment(c, grid, environmentProfile(c, grid.height))
  const p = parcelIndices(env, grid.height)
  return { p, k: stormIndices(env, p) }
}

describe('ECAPE (Peters et al. 2023)', () => {
  it('reproduces the paper’s example and its limits', () => {
    // CAPE 1000 J/kg, V_SR 45 m/s, NCAPE 500 J/kg: ECAPE ≈ 2000 J/kg (preprint, section 4).
    expect(ecapeRatio(45 / Math.sqrt(2000), .5, ecapePsi(12_000)) * 1000).toBeCloseTo(2000, -2)
    expect(ecapePsi(12_000)).toBeCloseTo(.0033, 4)
    // No entrainment (ψ → 0): the undilute CAPE plus the inflow's kinetic energy, 1 + vt².
    expect(ecapeRatio(.3, .4, 1e-9)).toBeCloseTo(1.09, 3)
    // Weaker inflow, more dilution; a drier environment (larger NCAPE), more dilution.
    expect(ecapeRatio(.1, .4, .003)).toBeLessThan(ecapeRatio(.2, .4, .003))
    expect(ecapeRatio(.1, .8, .003)).toBeLessThan(ecapeRatio(.1, .2, .003))
  })

  it('gives supercell environments most of their CAPE and weak-shear ones less', () => {
    const sup = indices('Классическая суперячейка'), day = indices('Летний день')
    expect(sup.k.ecape.ratio).toBeGreaterThan(.5); expect(sup.k.ecape.ratio).toBeLessThan(1.1)
    expect(sup.k.ecape.ncape).toBeGreaterThanOrEqual(0)
    expect(day.k.ecape.ratio).toBeLessThan(sup.k.ecape.ratio)
    expect(sup.k.ecape.ecape).toBeCloseTo(sup.k.ecape.ratio * sup.p.mu.cape, 6)
  })
})
