import { describe, expect, it } from 'vitest'
import { createGrid, Environment, parcelIndices, type SimConfig, stormIndices } from '.'
import { CAPPED, SUMMER_DAY, SUPERCELL } from './fixtures'

// MetPy 1.7.1 (bunkers_storm_motion, storm_relative_helicity for the right mover, supercell_composite with SRH 0-3 km
// and 0-6 km bulk shear, significant_tornado) on the same wind profiles, from tests/reference/metpy_parcel.py.
const METPY: Record<string, { config: SimConfig; right: [number, number]; srh01: number; srh03: number; shear06: number; scp: number; stp: number }> = {
  summer: { config: SUMMER_DAY, right: [7.76, 4.41], srh01: 23.7, srh03: 73.9, shear06: 18.92, scp: 8.594, stp: .613 },
  supercell: { config: SUPERCELL, right: [5.6, 2.59], srh01: 30.7, srh03: 104.8, shear06: 21.86, scp: 8.091, stp: .575 },
  capped: { config: CAPPED, right: [7.75, 4.39], srh01: 23.7, srh03: 73.9, shear06: 18.92, scp: 2.54, stp: .181 },
}

describe('supercell indices against MetPy', () => {
  for (const [name, ref] of Object.entries(METPY)) {
    it(`${name}: Bunkers motion within 0.05 m/s, SRH within 1 m2/s2, SCP and STP within 3 %`, () => {
      const grid = createGrid(), env = new Environment(ref.config, grid), s = stormIndices(env, parcelIndices(env, grid.height))
      expect(Math.abs(s.rightMover[0] - ref.right[0])).toBeLessThan(.05); expect(Math.abs(s.rightMover[1] - ref.right[1])).toBeLessThan(.05)
      expect(Math.abs(s.srh01 - ref.srh01)).toBeLessThan(1); expect(Math.abs(s.srh03 - ref.srh03)).toBeLessThan(1)
      expect(s.shear06).toBeCloseTo(ref.shear06, 1)
      expect(Math.abs(s.scp / ref.scp - 1)).toBeLessThan(.03); expect(Math.abs(s.stp / ref.stp - 1)).toBeLessThan(.03)
    })
  }
})
