import { describe, expect, it } from 'vitest'
import { stormIndices, Environment, createGrid, parcelIndices } from '../core'
import { SUMMER_DAY } from '../core/fixtures'
import { environmentOf, heatOf, moistureOf, turnOf, withHeat, withMoisture, withShear, withTurn } from './simple'

const levels = [0, 1000, 3000, 6000, 12000].map(z => ({ p: 1e5 * Math.exp(-z / 8000), z, t: 28 - z * .0065, td: 18 - z * .004, u: 2 + z / 500, v: z / 2000 }))
const sounding = { ...SUMMER_DAY, sounding: { levels } }, wk = { ...SUMMER_DAY, profile: 'weisman-klemp' as const }

describe('simple settings (src/settings/simple)', () => {
  it('reads the heat and the moisture back as changes from the scenario', () => {
    for (const base of [SUMMER_DAY, sounding]) {
      const c = withMoisture(withHeat(base, 2), 1.1)
      expect(heatOf(c, base)).toBeCloseTo(2, 6); expect(moistureOf(c, base)).toBeCloseTo(1.1, 2)
      expect(environmentOf(c).cape).toBeGreaterThan(environmentOf(base).cape)
    }
    expect(heatOf(wk, wk)).toBeNull(); expect(moistureOf(withMoisture(wk, .9), wk)).toBeCloseTo(.9, 6)
    // A sounding warms only below 1.5 km.
    const warm = withHeat(sounding, 3).sounding!.levels
    expect(warm[0].t - levels[0].t).toBeCloseTo(3, 6); expect(warm[2].t).toBe(levels[2].t)
  })

  it('turns the low-level wind and with it the helicity', () => {
    const srh = (c: typeof SUMMER_DAY) => { const g = createGrid(), env = new Environment(c, g); return stormIndices(env, parcelIndices(env, g.height)).srh03 }
    const straight = withTurn(SUMMER_DAY, 0), turned = withTurn(SUMMER_DAY, 90)
    expect(turnOf(straight)).toBeCloseTo(0, 6); expect(turnOf(turned)).toBeCloseTo(90, 6)
    expect(srh(turned)).toBeGreaterThan(srh(straight) + 50)
    expect(turned.windDir6).toBe(SUMMER_DAY.windDir6); expect(turned.wind0).toBe(SUMMER_DAY.wind0)
    expect(turnOf(sounding)).toBeNull()
    // The shear knob keeps the turning nearly (the hodograph scaled about the ground wind, not about calm).
    expect(turnOf(withShear(turned, 30))).toBeCloseTo(90, -1)
  })
})
