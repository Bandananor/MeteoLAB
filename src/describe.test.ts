import { describe, expect, it } from 'vitest'
import { cloudGenus, hailWord, rainWord } from './describe'

describe('words for the storm panel (src/describe.ts)', () => {
  it('names the rain rate and the hail', () => {
    expect([0, 1, 5, 20, 40, 80].map(rainWord)).toEqual(['', 'слабый', 'умеренный', 'сильный', 'ливень', 'очень сильный ливень'])
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
})
