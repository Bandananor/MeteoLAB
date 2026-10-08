import { describe, expect, it } from 'vitest'
import { CP, KAPPA } from './constants'
import { graupelFallSpeed } from './graupel'
import { hailFallSpeed, hailMaxDiameter, hailProcesses } from './hail'
import { LF } from './ice'

const one = (x: number) => Float32Array.of(x)
type Species = 'q' | 'cloud' | 'ice' | 'snow' | 'rain' | 'graupel' | 'hail'
const cell = (tk: number, p: number, values: Partial<Record<Species, number>>) => {
  const exner = (p / 1e5) ** KAPPA, v = (k: Species) => one(values[k] ?? 0)
  return { exner, theta: one(tk / exner), q: v('q'), cloud: v('cloud'), ice: v('ice'), snow: v('snow'), rain: v('rain'), graupel: v('graupel'), hail: v('hail') }
}
const water = (c: ReturnType<typeof cell>) => c.q[0] + c.cloud[0] + c.ice[0] + c.snow[0] + c.rain[0] + c.graupel[0] + c.hail[0]
const step = (c: ReturnType<typeof cell>, p: number, rho: number, dt: number) =>
  hailProcesses(c.theta, c.q, c.cloud, c.ice, c.snow, c.rain, c.graupel, c.hail, 0, c.exner, p, rho, dt)

describe('hail (ice stage 3)', () => {
  it('falls faster than graupel of the same mass: 10-16 m/s with 1 g/m3 near the ground', () => {
    const v = hailFallSpeed(1e-3 / 1.1, 1.1)
    expect(v).toBeGreaterThan(10); expect(v).toBeLessThan(16)
    expect(v).toBeGreaterThan(1.3 * graupelFallSpeed(1e-3 / 1.1, 1.1))
  })

  it('has its largest stones of 1-3 cm in a hail core of 2-10 g/m3, larger in a denser core', () => {
    const d2 = hailMaxDiameter(2e-3 / 1.1, 1.1), d10 = hailMaxDiameter(1e-2 / 1.1, 1.1)
    expect(d2).toBeGreaterThan(.01); expect(d10).toBeLessThan(.03); expect(d10).toBeGreaterThan(d2)
    expect(hailMaxDiameter(0, 1.1)).toBe(0)
  })

  it('is born from graupel in wet growth (much supercooled water), not in dry growth, conserving water', () => {
    const wet = cell(265.15, 55000, { q: 4e-3, cloud: 4e-3, rain: 4e-3, graupel: 4e-3 }), before = water(wet)
    for (let k = 0; k < 60; k++) step(wet, 55000, .75, 1)
    expect(wet.hail[0]).toBeGreaterThan(1e-3)
    expect(water(wet)).toBeCloseTo(before, 8)
    // Cold, little cloud water: the graupel freezes all it collects and stays graupel.
    const dry = cell(243.15, 35000, { q: 3e-4, cloud: 2e-4, graupel: 2e-3 })
    for (let k = 0; k < 60; k++) step(dry, 35000, .5, 1)
    expect(dry.hail[0]).toBe(0)
  })

  it('in wet growth freezes only what its heat loss allows and sheds the rest as rain (heat = L_f x frozen)', () => {
    const grow = (liquid: number) => {
      const c = cell(268.15, 60000, { q: 4.5e-3, cloud: .4 * liquid, rain: .6 * liquid, hail: 5e-3 }), before = water(c), theta0 = c.theta[0]
      step(c, 60000, .8, 5)
      const grown = c.hail[0] - 5e-3
      expect((c.theta[0] - theta0) * c.exner).toBeCloseTo(LF / CP * grown, 4)
      expect(water(c)).toBeCloseTo(before, 9)
      return grown
    }
    // Dry growth would double with twice the water; the wet-growth limit holds it nearly fixed.
    const a = grow(8e-3), b = grow(16e-3)
    expect(a).toBeGreaterThan(0); expect(b / a).toBeLessThan(1.2)
  })

  it('melts into rain above 0 °C, taking L_f', () => {
    const c = cell(283.15, 85000, { q: 6e-3, hail: 3e-3 })
    const cooling = step(c, 85000, 1, 10)
    expect(c.rain[0]).toBeGreaterThan(0)
    expect(c.rain[0] + c.hail[0]).toBeCloseTo(3e-3, 9)
    expect(cooling * c.exner).toBeCloseTo(LF / CP * c.rain[0], 5)
  })
})
