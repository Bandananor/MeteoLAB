import { describe, expect, it } from 'vitest'
import { CP, KAPPA } from './constants'
import { cooperCrystals, CRYSTAL_MASS, crystalSize, fragmentsPerKg, freezeRain, iceProcesses, koenigGrowth, plateSize, LF, LS, qsatIce, saturationAdjustMixed, snowFallSpeed, snowProcesses, SPLINTERS, splintering } from './ice'
import { qsatP } from './microphysics'

const one = (x: number) => Float32Array.of(x)

describe('ice microphysics (stage 1)', () => {
  it('saturates over ice below water saturation (82 % of it at -20 °C) and joins it at 0 °C', () => {
    expect(qsatIce(-20, 50000) / qsatP(-20, 50000)).toBeCloseTo(.82, 2)
    expect(qsatIce(-1e-9, 80000) / qsatP(0, 80000)).toBeCloseTo(1, 3)
  })

  it('nucleates crystals below -5 °C, more in colder air (Cooper 1986), at most 250 per litre', () => {
    expect(cooperCrystals(-3)).toBe(0)
    expect(cooperCrystals(-20) / 1e3).toBeCloseTo(2.2, 1); expect(cooperCrystals(-60)).toBe(250e3)
  })

  it('makes secondary ice: 350 splinters per mg of rime at -5 °C, none outside -3…-8 °C; tens of fragments per freezing millimetre drop', () => {
    expect(splintering(-5) * SPLINTERS * 1e-6).toBeCloseTo(350, 6); expect(splintering(-2)).toBe(0); expect(splintering(-9)).toBe(0)
    expect(splintering(-4)).toBeCloseTo(.5, 9); expect(splintering(-6.5)).toBeCloseTo(.5, 9)
    // Rain of mean drop size 1 / λ = 0.5 mm: per drop of the mass-weighted size (~3.5 mm by Bigg's law) its D⁴ fragments.
    const perDrop = fragmentsPerKg(2000) * 1000 * Math.PI / 6 * (7 / 2000) ** 3
    expect(perDrop).toBeCloseTo(2.5e13 * (7 / 2000) ** 4, 0)
  })

  it('grows crystals by habit: fastest at -15 °C (dendrites), a second peak at -5 (needles), slow at -9; plates wider than spheres', () => {
    const m = 1e-10
    expect(koenigGrowth(-15, m)).toBeGreaterThan(4 * koenigGrowth(-9, m)); expect(koenigGrowth(-5, m)).toBeGreaterThan(1.5 * koenigGrowth(-9, m))
    expect(koenigGrowth(-15.5, m)).toBeLessThan(koenigGrowth(-15, m)); expect(koenigGrowth(-40, m)).toBe(koenigGrowth(-31, m))
    // At -15 °C a crystal of 1e-10 kg gains about its own mass in a minute.
    expect(koenigGrowth(-15, m) * 60 / m).toBeGreaterThan(.5); expect(koenigGrowth(-15, m) * 60 / m).toBeLessThan(5)
    expect(plateSize(m) * 1e6).toBeCloseTo(103, -1); expect(plateSize(m)).toBeGreaterThan(1.5 * crystalSize(m, 1, 1))
  })

  it('lets 1 g/m3 of snow fall at about 1 m/s near the ground', () => {
    const v = snowFallSpeed(1e-3 / 1.1, 1.1, 1.1)
    expect(v).toBeGreaterThan(.8); expect(v).toBeLessThan(1.5)
  })

  it('keeps cloud water liquid down to -38 °C, at water saturation', () => {
    const p = 40000, exner = (p / 1e5) ** KAPPA, theta = one(243.15 / exner), q = one(1.2 * qsatP(-30, p)), cloud = one(0), ice = one(1e-5)
    const total = q[0] + cloud[0] + ice[0]
    saturationAdjustMixed(theta, q, cloud, ice, 0, exner, p)
    expect(q[0] + cloud[0] + ice[0]).toBeCloseTo(total, 9)
    expect(cloud[0]).toBeGreaterThan(0); expect(ice[0]).toBe(Math.fround(1e-5))
    expect(q[0] / qsatP(theta[0] * exner - 273.15, p)).toBeCloseTo(1, 3)
  })

  it('freezes the droplets at once below -38 °C (L_f) and holds the vapour at ice saturation', () => {
    const p = 25000, exner = (p / 1e5) ** KAPPA, theta = one(228.15 / exner), q = one(qsatP(-45, p)), cloud = one(5e-4), ice = one(0)
    const total = q[0] + cloud[0], before = theta[0]
    saturationAdjustMixed(theta, q, cloud, ice, 0, exner, p)
    expect(cloud[0]).toBe(0); expect(q[0] + ice[0]).toBeCloseTo(total, 9)
    expect(q[0] / qsatIce(theta[0] * exner - 273.15, p)).toBeCloseTo(1, 3)
    expect((theta[0] - before) * exner).toBeCloseTo((LF * 5e-4 + LS * (ice[0] - 5e-4)) / CP, 3)
  })

  it('melts cloud ice above 0 °C into cloud water with L_f', () => {
    const p = 80000, exner = (p / 1e5) ** KAPPA, theta = one(275.15 / exner), q = one(qsatP(2, p)), cloud = one(0), ice = one(1e-3)
    saturationAdjustMixed(theta, q, cloud, ice, 0, exner, p)
    expect(ice[0]).toBe(0); expect(cloud[0]).toBeGreaterThan(9e-4)
    expect(theta[0] * exner).toBeLessThan(275.15)
  })

  it('freezes rain below -38 °C into graupel with L_f', () => {
    const exner = (25000 / 1e5) ** KAPPA, theta = one(230 / exner), rain = one(1e-3), graupel = one(0)
    freezeRain(theta, rain, graupel, 0, exner)
    expect(rain[0]).toBe(0); expect(graupel[0]).toBeCloseTo(1e-3, 9); expect((theta[0] - 230 / exner) * exner).toBeCloseTo(LF / CP * 1e-3, 5)
  })

  it('grows ice at the droplets’ expense in a supercooled cloud (Bergeron) and conserves water', () => {
    const p = 50000, exner = (p / 1e5) ** KAPPA, rho = .7, s = { theta: one(253.15 / exner), q: one(qsatP(-20, p)), cloud: one(1e-3), ice: one(0), snow: one(0), n: one(0) }
    const water = () => s.q[0] + s.cloud[0] + s.ice[0] + s.snow[0], before = water()
    iceProcesses(s.theta, s.q, s.ice, s.snow, s.n, 0, exner, p, rho, 1)
    // The nucleated crystals, and their first second of growth.
    expect(s.ice[0]).toBeGreaterThan(cooperCrystals(-20) * CRYSTAL_MASS / rho); expect(s.ice[0]).toBeLessThan(2 * cooperCrystals(-20) * CRYSTAL_MASS / rho)
    for (let k = 0; k < 600; k++) { iceProcesses(s.theta, s.q, s.ice, s.snow, s.n, 0, exner, p, rho, 1); saturationAdjustMixed(s.theta, s.q, s.cloud, s.ice, 0, exner, p) }
    expect(s.ice[0] + s.snow[0]).toBeGreaterThan(1e-6); expect(s.cloud[0]).toBeLessThan(1e-3)
    expect(water()).toBeCloseTo(before, 7)
    // Supercooled water survives ten minutes of it: the Cooper crystals alone glaciate a cloud slowly.
    expect(s.cloud[0]).toBeGreaterThan(5e-4)
  })

  it('sublimates cloud ice in air dry over ice, cooling it', () => {
    const p = 30000, exner = (p / 1e5) ** KAPPA, theta = one(243.15 / exner), q = one(.5 * qsatIce(-30, p)), ice = one(1e-4), snow = one(0)
    const n = one(1e-4 / 1e-11), cooling = iceProcesses(theta, q, ice, snow, n, 0, exner, p, .45, 10)
    expect(ice[0]).toBeLessThan(1e-4); expect(cooling).toBeGreaterThan(0); expect(n[0]).toBeLessThan(1e-4 / 1e-11)
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
