import { describe, expect, it } from 'vitest'
import { computeSounding, createGrid, Environment, type SimConfig } from '.'
import { CAPPED, SUMMER_DAY, SUPERCELL } from './fixtures'

// Surface-based parcel from MetPy 1.7.1 on a hydrostatic version of each profile: no +0.5 K excess, no entrainment,
// virtual-temperature correction. Regenerate with tests/reference/metpy_parcel.py.
const METPY: Record<string, { config: SimConfig; cape: number; cin: number; lcl: number; lfc: number; el: number }> = {
  summer: { config: SUMMER_DAY, cape: 6367.6, cin: 0, lcl: .729, lfc: 1.164, el: 12.35 },
  supercell: { config: SUPERCELL, cape: 4072.6, cin: 0, lcl: .723, lfc: 1.134, el: 11.776 },
  capped: { config: CAPPED, cape: 1898.4, cin: -58.6, lcl: 1.028, lfc: 2.691, el: 11.18 },
}

describe('surface-based parcel against MetPy', () => {
  // Known failure until the base state is hydrostatic (roadmap level 1): today CAPE is 7-15 % high,
  // CIN of the capped profile is 128 instead of 59 J/kg and EL is up to 0.75 km high.
  for (const [name, ref] of Object.entries(METPY)) {
    it.fails(`${name}: CAPE within 5 %, CIN within 10 J/kg, LCL/LFC within 150 m, EL within 300 m`, () => {
      const grid = createGrid(), s = computeSounding(ref.config, new Environment(ref.config, grid), grid.height, { excess: 0, entrain: false })
      expect(Math.abs(s.cape / ref.cape - 1)).toBeLessThan(.05)
      expect(Math.abs(s.cin - Math.abs(ref.cin))).toBeLessThan(10)
      expect(Math.abs(s.lcl! - ref.lcl)).toBeLessThan(.15)
      expect(Math.abs(s.lfc! - ref.lfc)).toBeLessThan(.15)
      expect(Math.abs(s.el! - ref.el)).toBeLessThan(.3)
    })
  }

  it('keeps the app diagnostic parcel (+0.5 K, entraining) unchanged by the clean-parcel option', () => {
    const grid = createGrid(), env = new Environment(SUMMER_DAY, grid)
    const clean = computeSounding(SUMMER_DAY, env, grid.height, { excess: 0, entrain: false }), app = computeSounding(SUMMER_DAY, env, grid.height)
    expect(app.cape).toBeCloseTo(5354, -1)
    expect(clean.cape).toBeGreaterThan(app.cape)
  })
})
