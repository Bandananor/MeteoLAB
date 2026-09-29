import { describe, expect, it } from 'vitest'
import { CP, KAPPA } from './constants'
import { iceFraction, LF, partitionCondensate, qsatIce, saturationAdjustMixed, snowFallSpeed, snowProcesses } from './ice'
import { qsatP } from './microphysics'

const one = (x: number) => Float32Array.of(x)

describe('ice microphysics (stage 1, not yet in the model)', () => {
  it('saturates over ice below water saturation (82 % of it at -20 °C) and joins it at 0 °C', () => {
    expect(qsatIce(-20, 50000) / qsatP(-20, 50000)).toBeCloseTo(.82, 2)
    expect(qsatIce(-1e-9, 80000) / qsatP(0, 80000)).toBeCloseTo(1, 3)
  })

  it('freezes cloud condensate linearly between 0 and -40 °C', () => {
    expect(iceFraction(280)).toBe(0); expect(iceFraction(253.15)).toBeCloseTo(.5, 9); expect(iceFraction(230)).toBe(1)
  })

  it('lets 1 g/m3 of snow fall at about 1 m/s near the ground', () => {
    const v = snowFallSpeed(1e-3 / 1.1, 1.1, 1.1)
    expect(v).toBeGreaterThan(.8); expect(v).toBeLessThan(1.5)
  })

  it('releases exactly L_f per kilogram frozen and conserves the condensate', () => {
    const exner = (60000 / 1e5) ** KAPPA, theta = one(253.15 / exner), cloud = one(.002), ice = one(0)
    const frozen = partitionCondensate(theta, cloud, ice, 0, exner)
    expect(frozen).toBeCloseTo(.001, 6)
    expect(cloud[0] + ice[0]).toBeCloseTo(.002, 9)
    expect((theta[0] - 253.15 / exner) * exner).toBeCloseTo(LF / CP * frozen, 4)
  })

  it('adjusts to the ice-weighted saturation in a cold cloud and conserves water', () => {
    const p = 40000, exner = (p / 1e5) ** KAPPA, theta = one(243.15 / exner), q = one(1.2 * qsatP(-30, p)), cloud = one(0), ice = one(0)
    const total = q[0]
    saturationAdjustMixed(theta, q, cloud, ice, 0, exner, p)
    expect(q[0] + cloud[0] + ice[0]).toBeCloseTo(total, 9)
    expect(ice[0]).toBeGreaterThan(cloud[0])
    const t = theta[0] * exner - 273.15, f = iceFraction(theta[0] * exner)
    expect(q[0] / ((1 - f) * qsatP(t, p) + f * qsatIce(t, p))).toBeCloseTo(1, 3)
  })

  it('grows snow at water saturation below 0 °C, melts it above 0 °C with L_f, and conserves total water', () => {
    const p = 60000, exner = (p / 1e5) ** KAPPA, rho = .8
    const cold = { theta: one(258.15 / exner), q: one(qsatP(-15, p)), cloud: one(5e-4), ice: one(2e-3), snow: one(1e-3), rain: one(0) }
    const water = (s: typeof cold) => s.q[0] + s.cloud[0] + s.ice[0] + s.snow[0] + s.rain[0], before = water(cold)
    for (let k = 0; k < 60; k++) snowProcesses(cold.theta, cold.q, cold.cloud, cold.ice, cold.snow, cold.rain, 0, exner, p, rho, 1.1, 1)
    expect(cold.snow[0]).toBeGreaterThan(1e-3)
    expect(water(cold)).toBeCloseTo(before, 9)
    const warm = { theta: one(278.15 / exner), q: one(.005), cloud: one(0), ice: one(0), snow: one(1e-3), rain: one(0) }
    const cooling = snowProcesses(warm.theta, warm.q, warm.cloud, warm.ice, warm.snow, warm.rain, 0, exner, p, rho, 1.1, 10)
    expect(warm.rain[0]).toBeGreaterThan(0)
    expect(warm.rain[0] + warm.snow[0]).toBeCloseTo(1e-3, 9)
    expect(cooling * exner).toBeCloseTo(LF / CP * warm.rain[0], 5)
  })
})
