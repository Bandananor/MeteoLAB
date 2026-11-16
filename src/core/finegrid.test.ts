import { describe, expect, it } from 'vitest'
import { domainGrid, MAX_NODES, SCENARIOS, SPACING_MIN, stepsPerDt } from '.'
import { SUMMER_DAY } from './fixtures'
import { decodeSettings, encodeSettings } from '../share'

describe('precise runs finer than 250 m (3.0: no lower limit, a memory guard only)', () => {
  it('a grid takes any spacing down to 10 m, coarsened only past MAX_NODES', () => {
    const g = domainGrid('standard', undefined, undefined, .1)
    expect([g.nx, g.ny]).toEqual([480, 360])
    const tiny = domainGrid('standard', undefined, undefined, .02)
    expect(tiny.nx * tiny.ny * tiny.nz).toBeLessThanOrEqual(MAX_NODES * 1.01)
    expect(tiny.width / tiny.nx).toBeGreaterThan(20)
  })

  it('cuts the step so the horizontal Courant number stays that of 250 m', () => {
    expect(stepsPerDt(undefined)).toBe(1); expect(stepsPerDt(.5)).toBe(1); expect(stepsPerDt(.25)).toBe(1)
    expect(stepsPerDt(.2)).toBe(2); expect(stepsPerDt(.125)).toBe(2); expect(stepsPerDt(.1)).toBe(3); expect(stepsPerDt(.05)).toBe(5)
  })

  it('a link keeps to the live run\'s 250 m', () => {
    const names = SCENARIOS.map(s => s.name)
    expect(decodeSettings(encodeSettings({ ...SUMMER_DAY, spacing: .05 }, SUMMER_DAY, null), names)?.values.spacing).toBe(SPACING_MIN)
    expect(decodeSettings(encodeSettings({ ...SUMMER_DAY, spacing: .5 }, SUMMER_DAY, null), names)?.values.spacing).toBe(.5)
  })
})
