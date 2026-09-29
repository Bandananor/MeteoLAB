import { describe, expect, it } from 'vitest'
import { computeSounding, createGrid, Environment, parcelIndices, type SimConfig } from '.'
import { CAPPED, SUMMER_DAY, SUPERCELL } from './fixtures'

const LID: SimConfig = { ...SUMMER_DAY, capHeight: 2, capStrength: 2 }
const LOADED: SimConfig = { ...SUMMER_DAY, surfaceTemp: 32, rhSurface: 50, rhLow: 35, rhMid: 40, lapseLow: 9.5, lapseMid: 8, capHeight: 1.5, capStrength: 3 }

// Surface-based parcel from MetPy 1.7.1 on the same hydrostatic profiles and the same humidity convention
// (r = RH * r_s): no +0.5 K excess, no entrainment, virtual-temperature correction.
// Regenerate with tests/reference/metpy_parcel.py.
const METPY: Record<string, { config: SimConfig; cape: number; cin: number; lcl: number; lfc: number; el: number }> = {
  summer: { config: SUMMER_DAY, cape: 6144.9, cin: 0, lcl: .704, lfc: 1.145, el: 12.392 },
  supercell: { config: SUPERCELL, cape: 3860.9, cin: -10.8, lcl: .699, lfc: 1.115, el: 11.814 },
  capped: { config: CAPPED, cape: 1817.4, cin: -113.5, lcl: .998, lfc: 2.554, el: 11.218 },
  // Capping inversions: CAPE is the net area from the lowest LFC to the highest EL, so the lid is subtracted from it.
  lid: { config: LID, cape: 5992.1, cin: 0, lcl: .704, lfc: 1.145, el: 12.406 },
  loaded: { config: LOADED, cape: 5514.0, cin: 0, lcl: 1.452, lfc: 2.146, el: 12.162 },
}

describe('surface-based parcel against MetPy', () => {
  for (const [name, ref] of Object.entries(METPY)) {
    it(`${name}: CAPE within 2 %, CIN within 5 J/kg, LCL within 50 m, EL within 100 m`, () => {
      const grid = createGrid(), s = computeSounding(ref.config, new Environment(ref.config, grid), grid.height, { excess: 0, entrain: false })
      expect(Math.abs(s.cape / ref.cape - 1)).toBeLessThan(.02)
      expect(Math.abs(s.cin - Math.abs(ref.cin))).toBeLessThan(5)
      expect(Math.abs(s.lcl! - ref.lcl)).toBeLessThan(.05)
      expect(Math.abs(s.el! - ref.el)).toBeLessThan(.1)
      // Between the LCL and the LFC of a weakly capped profile the parcel is neutral to ~1e-4 m/s2, so the LFC
      // height is ill-conditioned (MetPy's CIN there rounds to 0 over 400 m). Check it only where the cap is real.
      if (Math.abs(ref.cin) > 25) expect(Math.abs(s.lfc! - ref.lfc)).toBeLessThan(.1)
    })
  }

  // mixed_layer_cape_cin (100 hPa), most_unstable_cape_cin (300 hPa), downdraft_cape from the same script.
  const INDICES: Record<string, { mlcape: number; mlcin: number; mucape: number; dcape: number }> = {
    summer: { mlcape: 4083.7, mlcin: 0, mucape: 6144.9, dcape: 1224.2 },
    supercell: { mlcape: 2422.5, mlcin: -24.9, mucape: 3860.9, dcape: 1168.2 },
    capped: { mlcape: 1047.8, mlcin: -176.5, mucape: 1817.4, dcape: 1285.2 },
    lid: { mlcape: 3878.9, mlcin: 0, mucape: 5992.1, dcape: 1420.1 },
    loaded: { mlcape: 3385.4, mlcin: -81.4, mucape: 5514.0, dcape: 1617.0 },
  }
  for (const [name, ref] of Object.entries(INDICES)) {
    it(`${name}: ML CAPE within 4 %, ML CIN within 5 J/kg or 10 %, MU CAPE within 2 %, DCAPE within 2 %`, () => {
      const grid = createGrid(), i = parcelIndices(new Environment(METPY[name].config, grid), grid.height)
      expect(Math.abs(i.ml.cape / ref.mlcape - 1)).toBeLessThan(.04)
      // The ML parcel crossing an inversion kink: ~7 J/kg (9 %) apart on the loaded-gun profile.
      expect(Math.abs(i.ml.cin - Math.abs(ref.mlcin))).toBeLessThan(Math.max(5, .1 * Math.abs(ref.mlcin)))
      expect(Math.abs(i.mu.cape / ref.mucape - 1)).toBeLessThan(.02)
      expect(Math.abs(i.dcape / ref.dcape - 1)).toBeLessThan(.02)
    })
  }

  it('uses the app diagnostic parcel (+0.5 K, entraining) by default', () => {
    const grid = createGrid(), env = new Environment(SUMMER_DAY, grid)
    const byDefault = computeSounding(SUMMER_DAY, env, grid.height), explicit = computeSounding(SUMMER_DAY, env, grid.height, { excess: .5, entrain: true })
    expect(byDefault.cape).toBe(explicit.cape)
    expect(byDefault.cape).toBeLessThan(computeSounding(SUMMER_DAY, env, grid.height, { excess: 0, entrain: false }).cape)
  })

  it('integrates the base state hydrostatically', () => {
    const grid = createGrid(), env = new Environment(SUMMER_DAY, grid)
    // MetPy reference profile: 276.49 hPa at 10 km (it uses g = 9.80665, the model 9.81); the old exp(-z/8 km) gave 290.3.
    expect(Math.abs(env.pressureAt(10_000) / 27649 - 1)).toBeLessThan(.001)
  })
})
