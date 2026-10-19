import { describe, expect, it } from 'vitest'
import type { ModelDiagnostics, RotationState, Sounding } from './core'
import { cloudGenus, describeConvection, hailWord, rainWord } from './describe'

describe('words for the storm panel (src/describe.ts)', () => {
  it('names the rain rate and the hail', () => {
    expect([0, 1, 5, 20, 40, 80].map(rainWord)).toEqual(['', 'слабый ливневый дождь', 'умеренный ливневый дождь', 'сильный ливневый дождь', 'сильный ливневый дождь', 'очень сильный ливневый дождь'])
    expect([0, 5, 15, 30, 60].map(hailWord)).toEqual(['', 'мелкий', 'средний', 'крупный', 'очень крупный'])
  })
  it('classifies the cloud from cumulus humilis to cumulonimbus capillatus', () => {
    const lcl = 1.2, el = 12
    expect(cloudGenus(.5, lcl, 15, el)).toBe('')
    expect(cloudGenus(1.8, lcl, 10, el)).toMatch(/^Cu hum/)
    expect(cloudGenus(3, lcl, 2, el)).toMatch(/^Cu med/)
    expect(cloudGenus(5.5, lcl, -12, el)).toMatch(/^Cu cong/)
    expect(cloudGenus(8, lcl, -30, el)).toMatch(/^Cb calv/)
    expect(cloudGenus(11.8, lcl, -55, el)).toMatch(/^Cb cap/)
  })
  it('names a heavy shower under a weak updraught as the dissipating stage', () => {
    const d = { cores: 1, coldMax: 2, updraft: 6, cloudTop: 11, shear06: 10, gust: 12, hail: 0, rainRate: 90 } as ModelDiagnostics
    const s = { lcl: 1.2, lfc: 2, el: 12 } as Sounding, r = { persisted: 0, uh: 0, coreAnti: 0 } as RotationState
    expect(describeConvection(d, s, r).logic).toMatch(/стадия распада/)
    expect(describeConvection({ ...d, updraft: 25 }, s, r).logic).not.toMatch(/стадия распада/)
  })
})
