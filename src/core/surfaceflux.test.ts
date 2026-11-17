import { describe, expect, it } from 'vitest'
import { graupelFallSpeed } from './graupel'
import { hailFallSpeed } from './hail'
import { GRAUPEL_2M, momentSpeed } from './ice2m'
import { fallSpeed } from './microphysics'
import { fallSpeeds } from './rain2m'
import { precipitationFlux, rainFlux } from './surfaceflux'

const one = (x: number) => [x]

describe('precipitation flux', () => {
  it('uses the fixed intercepts without second moments', () => {
    const m = { rain: one(.002), snow: one(0), graupel: one(.001), hail: one(.0005) }, rho = 1.15
    const old = rho * (.002 * fallSpeed(.002, rho, rho) + .001 * graupelFallSpeed(.001, rho) + .0005 * hailFallSpeed(.0005, rho))
    expect(precipitationFlux(m, 0, rho)).toBeCloseTo(old, 10)
    // A zero moment (two-moment switched off: the field is there but empty) is one-moment too.
    expect(precipitationFlux({ ...m, rainNumber: one(0), graupelNumber: one(0), hailNumber: one(0) }, 0, rho)).toBeCloseTo(old, 10)
  })

  it('uses the two-moment mass-weighted speeds where the moments are present', () => {
    const rho = 1.15
    // Few large drops fall faster than many small ones of the same mass.
    const few = rainFlux({ rain: one(.002), rainNumber: one(500) }, 0, rho), many = rainFlux({ rain: one(.002), rainNumber: one(5e5) }, 0, rho)
    expect(few).toBeCloseTo(rho * .002 * fallSpeeds(.002, 500, rho)[0], 10)
    expect(few).toBeGreaterThan(many)
    const g = precipitationFlux({ rain: one(0), snow: one(0), graupel: one(.001), hail: one(0), graupelNumber: one(1e3), graupelVolume: one(.001 / 500) }, 0, rho)
    expect(g).toBeCloseTo(rho * .001 * momentSpeed(GRAUPEL_2M, .001, 1e3, .001 / 500, rho, 3), 8)
  })
})
