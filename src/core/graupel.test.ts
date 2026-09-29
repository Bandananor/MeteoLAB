import { describe, expect, it } from 'vitest'
import { CP, KAPPA } from './constants'
import { graupelFallSpeed, graupelProcesses } from './graupel'
import { LF } from './ice'

const one = (x: number) => Float32Array.of(x)
const cell = (tk: number, p: number, values: Partial<Record<'q' | 'cloud' | 'ice' | 'snow' | 'rain' | 'graupel', number>>) => {
  const exner = (p / 1e5) ** KAPPA
  return { exner, theta: one(tk / exner), q: one(values.q ?? 0), cloud: one(values.cloud ?? 0), ice: one(values.ice ?? 0), snow: one(values.snow ?? 0), rain: one(values.rain ?? 0), graupel: one(values.graupel ?? 0) }
}
const water = (c: ReturnType<typeof cell>) => c.q[0] + c.cloud[0] + c.ice[0] + c.snow[0] + c.rain[0] + c.graupel[0]
const step = (c: ReturnType<typeof cell>, p: number, rho: number, dt: number) => graupelProcesses(c.theta, c.q, c.cloud, c.ice, c.snow, c.rain, c.graupel, 0, c.exner, p, rho, dt)

describe('graupel (ice stage 2)', () => {
  it('falls at 5-10 m/s with 1 g/m3 near the ground', () => {
    const v = graupelFallSpeed(1e-3 / 1.1, 1.1)
    expect(v).toBeGreaterThan(5); expect(v).toBeLessThan(10)
  })

  it('freezes supercooled rain far faster at -20 °C than at -5 °C, releasing exactly L_f', () => {
    const frozenAfter = (tk: number) => { const c = cell(tk, 50000, { rain: 2e-3 }); step(c, 50000, .7, 10); return c.graupel[0] }
    expect(frozenAfter(253.15)).toBeGreaterThan(100 * frozenAfter(268.15))
    // Air at ice saturation or above, so the graupel does not sublimate.
    const c = cell(253.15, 50000, { q: 1.5e-3, rain: 2e-3 }), before = c.theta[0]
    step(c, 50000, .7, 10)
    expect((c.theta[0] - before) * c.exner).toBeCloseTo(LF / CP * c.graupel[0], 5)
  })

  it('rimes cloud water below 0 °C and melts into rain above it, conserving water', () => {
    const cold = cell(263.15, 60000, { q: 1e-3, cloud: 2e-3, snow: 1e-3, graupel: 2e-3 }), before = water(cold)
    for (let k = 0; k < 30; k++) step(cold, 60000, .8, 1)
    expect(cold.cloud[0]).toBeLessThan(2e-3); expect(cold.graupel[0]).toBeGreaterThan(2e-3)
    expect(water(cold)).toBeCloseTo(before, 9)
    const warm = cell(281.15, 80000, { q: 5e-3, graupel: 2e-3 })
    const cooling = step(warm, 80000, 1, 10)
    expect(warm.rain[0]).toBeGreaterThan(0)
    expect(warm.rain[0] + warm.graupel[0]).toBeCloseTo(2e-3, 9)
    expect(cooling * warm.exner).toBeCloseTo(LF / CP * warm.rain[0], 5)
  })
})
