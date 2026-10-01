import { describe, expect, it } from 'vitest'
import { DBZ_FLOOR, reflectivity } from './radar'

describe('simulated radar reflectivity', () => {
  it('gives the Marshall-Palmer value for rain: 1 g/m3 ~ 18 mm/h ~ 43 dBZ (Z = 200 R^1.6)', () => {
    expect(reflectivity(1, 1e-3, 0, 0, 15)).toBeCloseTo(10 * Math.log10(200 * 18 ** 1.6), 0)
  })

  it('grows 17.5 dBZ per tenfold rain (Z ~ (rho q)^1.75) and is at the floor in clear air', () => {
    expect(reflectivity(1, 1e-3, 0, 0, 15) - reflectivity(1, 1e-4, 0, 0, 15)).toBeCloseTo(17.5, 6)
    expect(reflectivity(1, 0, 0, 0, 15)).toBe(DBZ_FLOOR)
  })

  it('sees dry snow far weaker than the same mass of rain, graupel brighter (few large particles), melting ice brighter still (bright band)', () => {
    const rain = reflectivity(.8, 1e-3, 0, 0, -10), snow = reflectivity(.8, 0, 1e-3, 0, -10), graupel = reflectivity(.8, 0, 0, 1e-3, -10)
    expect(rain - snow).toBeGreaterThan(5)
    // Lin's graupel intercept is 200x smaller than rain's: the same mass in large particles, Z ~ D^6 (as in WRF's calc_dbz).
    expect(graupel).toBeGreaterThan(rain); expect(graupel).toBeLessThan(60)
    expect(reflectivity(.8, 0, 1e-3, 0, 1) - snow).toBeCloseTo(-10 * Math.log10(.224), 6)
  })
})
