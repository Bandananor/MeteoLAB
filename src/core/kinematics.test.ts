import { describe, expect, it } from 'vitest'
import { createGrid, domainGrid, Environment, derechoParameter, hailParameter, parcelIndices, SCENARIOS, type SimConfig, stormIndices } from '.'
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

describe('significant hail parameter (SPC SHIP v1.1)', () => {
  it('multiplies its terms within their caps and scales down weak CAPE, lapse rate and a low freezing level', () => {
    // MUCAPE 3000, 13 g/kg, 7.5 °C/km, -12 °C at 500 hPa, 25 m/s: 2.09.
    expect(hailParameter(3000, .013, 7.5, -12, 25, 3500)).toBeCloseTo(2.09, 2)
    // Caps: moisture 11-13.6 g/kg, shear 7-27 m/s, T500 at most -5.5 °C.
    expect(hailParameter(3000, .02, 7.5, -12, 40, 3500)).toBeCloseTo(3000 * 13.6 * 7.5 * 12 * 27 / 42e6, 6)
    expect(hailParameter(3000, .013, 7.5, -2, 25, 3500)).toBeCloseTo(hailParameter(3000, .013, 7.5, -5.5, 25, 3500), 9)
    expect(hailParameter(650, .013, 7.5, -12, 25, 3500)).toBeCloseTo(650 * 13 * 7.5 * 12 * 25 / 42e6 * .5, 6)
    expect(hailParameter(3000, .013, 5.8 / 2, -12, 25, 3500)).toBeCloseTo(3000 * 13 * 2.9 * 12 * 25 / 42e6 * .5, 6)
    expect(hailParameter(3000, .013, 7.5, -12, 25, 1200)).toBeCloseTo(2.09 / 2, 2)
  })

  it('is high for the classic supercell (~4.7), below 1 for the summer day and low in the tropics (moist-adiabatic aloft)', () => {
    const ship = (name: string) => {
      const config = { ...SUMMER_DAY, ...SCENARIOS.find(s => s.name === name)!.values }, env = new Environment(config, createGrid(domainGrid(config.domain, config.top, config.domainSize)))
      return stormIndices(env, parcelIndices(env, 18_000)).ship
    }
    expect(ship('Классическая суперячейка')).toBeGreaterThan(3); expect(ship('Летний день')).toBeLessThan(1); expect(ship('Тропическая конвекция')).toBeLessThan(.5)
  })
})

describe('derecho composite parameter (2.8)', () => {
  it('is the product of its four terms, 1 at 980 J/kg DCAPE, 2000 MUCAPE, 20 kt of shear and 16 kt of mean wind', () => {
    expect(derechoParameter(980, 2000, 10.29, 8.23)).toBeCloseTo(1, 6)
    expect(derechoParameter(1470, 3000, 20.58, 8.23)).toBeCloseTo(1.5 * 1.5 * 2, 6)
    expect(derechoParameter(1000, 0, 20, 15)).toBe(0)
  })

  it('is high under fast flow with strong downdraughts (the supercells ~8-10, the multicell storm ~2.7), low in a calm summer day and a microburst’s weak flow', () => {
    const dcp = (name: string) => {
      const config = { ...SUMMER_DAY, ...SCENARIOS.find(s => s.name === name)!.values }, env = new Environment(config, createGrid(domainGrid(config.domain, config.top, config.domainSize)))
      return stormIndices(env, parcelIndices(env, 18_000)).dcp
    }
    expect(dcp('Классическая суперячейка')).toBeGreaterThan(4); expect(dcp('Многоячейковая гроза')).toBeGreaterThan(2)
    expect(dcp('Летний день')).toBeLessThan(1); expect(dcp('Микропорыв')).toBeLessThan(1)
  })
})
