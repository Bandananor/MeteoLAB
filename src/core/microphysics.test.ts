import { describe, expect, it } from 'vitest'
import { CP, KAPPA, LV, qsatP, saturationAdjust } from '.'

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
