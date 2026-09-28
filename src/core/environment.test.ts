import { describe, expect, it } from 'vitest'
import { createGrid, Environment } from '.'
import { SUMMER_DAY } from './fixtures'

describe('wind profile', () => {
  const at = (windDir0: number, windDir3: number) => new Environment({ ...SUMMER_DAY, windDir0, windDir3 }, createGrid())

  it('turns across north along the shorter arc', () => {
    // The old linear lerp gave 180° halfway from 350° to 10°: the wind blew from the opposite side.
    expect(at(350, 10).windDirection(1500)).toBeCloseTo(0, 9)
    expect(at(10, 350).windDirection(750)).toBeCloseTo(5, 9)
    expect(at(300, 60).windDirection(1500)).toBeCloseTo(0, 9)
    const [u, v] = at(350, 10).windUV(1500)
    expect(v).toBeLessThan(0); expect(Math.abs(u)).toBeLessThan(1e-9)
  })

  it('keeps profiles that do not cross north unchanged', () => {
    expect(at(160, 185).windDirection(1500)).toBe(172.5)
    expect(at(140, 200).windDirection(3000)).toBe(200)
  })
})
