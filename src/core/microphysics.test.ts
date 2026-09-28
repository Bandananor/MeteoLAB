import { describe, expect, it } from 'vitest'
import { CP, fallSpeed, KAPPA, LV, qsatP, rainProcesses, saturationAdjust } from '.'

describe('Kessler warm rain', () => {
  const one = (x: number) => Float32Array.of(x)

  it('fall speed grows with rain content and with height (thinner air)', () => {
    // 1 g/kg near the ground: 36.34 * (1.2e-6)^0.1364 = 5.7 m/s (the old constant was 7 m/s for any rain).
    expect(fallSpeed(.001, 1.2, 1.2)).toBeCloseTo(5.68, 1)
    expect(fallSpeed(.005, 1.2, 1.2)).toBeCloseTo(7.05, 1)
    expect(fallSpeed(.001, .6, 1.2) / fallSpeed(.001, 1.2, 1.2)).toBeCloseTo((.5 ** .1364) * Math.SQRT2, 6)
    expect(fallSpeed(0, 1.2, 1.2)).toBe(0)
  })

  it('autoconverts 0.1 %/s above 1 g/kg and accretes cloud onto rain', () => {
    const q = one(.01), cloud = one(.003), rain = one(0)
    rainProcesses(q, cloud, rain, 0, 280, 80000, 1, 1)
    expect(rain[0]).toBeCloseTo(.001 * .002, 8)
    const cloud2 = one(.002), rain2 = one(.002)
    rainProcesses(one(.01), cloud2, rain2, 0, 280, 80000, 1, 1)
    expect(rain2[0] - .002).toBeCloseTo(.001 * .001 + 2.2 * .002 * .002 ** .875, 8)
    expect(cloud2[0] + rain2[0]).toBeCloseTo(.004, 8)
  })

  it('evaporates rain in dry air at the Kessler rate, never past saturation', () => {
    const p = 85000, tk = 290, qs = qsatP(tk - 273.15, p)
    const q = one(.5 * qs), rain = one(.001), evap = rainProcesses(q, one(0), rain, 0, tk, p, 1, 1)
    // ~0.5 %/s of 1 g/kg at 50 % humidity: rain from cloud base evaporates over minutes, not seconds.
    expect(evap / .001).toBeGreaterThan(.002); expect(evap / .001).toBeLessThan(.01)
    expect(q[0] + rain[0]).toBeCloseTo(.5 * qs + .001, 8)
    const nearly = one(.999 * qs), lots = one(.01)
    rainProcesses(nearly, one(0), lots, 0, tk, p, 1, 1000)
    expect(nearly[0]).toBeLessThanOrEqual(qs)
    expect(rainProcesses(one(1.1 * qs), one(0), one(.001), 0, tk, p, 1, 1)).toBe(0)
  })
})

describe('saturation adjustment', () => {
  const p = 70000, exner = (p / 100000) ** KAPPA
  const cell = (tempC: number, q: number, cloud: number) => ({ theta: Float32Array.of((tempC + 273.15) / exner), q: Float32Array.of(q), cloud: Float32Array.of(cloud) })
  // Liquid-water potential temperature (linearised): conserved by condensation and evaporation.
  const thetaL = (c: ReturnType<typeof cell>) => c.theta[0] - LV / (CP * exner) * c.cloud[0]
  const qsOf = (c: ReturnType<typeof cell>) => qsatP(c.theta[0] * exner - 273.15, p)

  it('condenses a supersaturated cell to exact saturation in one step', () => {
    const c = cell(10, 1.3 * qsatP(10, p), 0), water = c.q[0] + c.cloud[0], thL = thetaL(c)
    const cond = saturationAdjust(c.theta, c.q, c.cloud, 0, exner, p)
    expect(cond).toBeGreaterThan(0)
    expect(Math.abs(c.q[0] / qsOf(c) - 1)).toBeLessThan(1e-4)
    // Latent heat raises q_s, so only part of the excess condenses (the old scheme took 32 % of it per second).
    expect(c.cloud[0]).toBeLessThan(.3 * qsatP(10, p))
    expect(c.q[0] + c.cloud[0]).toBeCloseTo(water, 9)
    expect(thetaL(c)).toBeCloseTo(thL, 3)
  })

  it('evaporates cloud water in subsaturated air until saturation or until the cloud is gone', () => {
    const partial = cell(10, .95 * qsatP(10, p), .005)
    saturationAdjust(partial.theta, partial.q, partial.cloud, 0, exner, p)
    expect(Math.abs(partial.q[0] / qsOf(partial) - 1)).toBeLessThan(1e-4)
    expect(partial.cloud[0]).toBeGreaterThan(0)
    const gone = cell(10, .5 * qsatP(10, p), .0005), thL = thetaL(gone)
    expect(saturationAdjust(gone.theta, gone.q, gone.cloud, 0, exner, p)).toBeCloseTo(-.0005, 9)
    expect(gone.cloud[0]).toBe(0)
    expect(gone.q[0]).toBeLessThan(qsOf(gone))
    expect(thetaL(gone)).toBeCloseTo(thL, 3)
  })

  it('leaves clear subsaturated air alone', () => {
    const c = cell(10, .7 * qsatP(10, p), 0), before = [c.theta[0], c.q[0]]
    expect(saturationAdjust(c.theta, c.q, c.cloud, 0, exner, p)).toBe(0)
    expect([c.theta[0], c.q[0]]).toEqual(before)
  })
})
