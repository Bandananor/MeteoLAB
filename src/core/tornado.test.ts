import { describe, expect, it } from 'vitest'
import { MESO_PERSISTENCE, TORNADO_DEFAULTS, tornadoSigns } from '.'

const calm = { uh01: 0, lowHeld: 0, mesoHeld: 0, stp: .2, srh01: 30, lcl: 1.8, cold: 2 }

describe('signs of tornadogenesis (2.5)', () => {
  it('the levels: nothing, a favourable environment, a low mesocyclone, all the signs together', () => {
    expect(tornadoSigns(calm).level).toBe(0)
    const environment = { ...calm, stp: 2, srh01: 200, lcl: .9 }
    expect(tornadoSigns(environment).level).toBe(1)
    // Rotation at the ground that flickers for a minute is not yet a low mesocyclone; held for 4 minutes it is.
    expect(tornadoSigns({ ...environment, uh01: 40, lowHeld: 60 }).level).toBe(1)
    expect(tornadoSigns({ ...calm, uh01: 40, lowHeld: 240 }).level).toBe(2)
    const all = { ...environment, uh01: 40, lowHeld: 240, mesoHeld: MESO_PERSISTENCE }
    expect(tornadoSigns(all).level).toBe(3)
    // A very cold outflow takes the last level away; all the conditions are listed with their values.
    const { level, checks } = tornadoSigns({ ...all, cold: 9 })
    expect(level).toBe(2); expect(checks).toHaveLength(6); expect(checks.filter(c => !c.ok).map(c => c.name)[0]).toContain('Отток')
  })

  it('takes the user\'s thresholds', () => {
    const s = { ...calm, stp: .6, srh01: 80, lcl: 1.6 }
    expect(tornadoSigns(s).level).toBe(0)
    expect(tornadoSigns(s, { ...TORNADO_DEFAULTS, stp: .5, srh01: 50, lcl: 2 }).level).toBe(1)
  })
})
