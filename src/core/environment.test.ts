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

  it('passes through the optional 0.5 and 1 km nodes (curved low-level hodograph)', () => {
    const env = new Environment({ ...SUMMER_DAY, wind0: 5, windDir0: 120, wind05: 10, windDir05: 150, wind1: 14, windDir1: 180, wind3: 20, windDir3: 240 }, createGrid())
    expect(env.windScalar(500)).toBe(10); expect(env.windDirection(1000)).toBe(180)
    expect(env.windScalar(750)).toBeCloseTo(12, 9); expect(env.windDirection(2000)).toBeCloseTo(210, 9)
    // Without the nodes the lowest 3 km is one straight segment, as before.
    const plain = new Environment({ ...SUMMER_DAY, wind0: 5, windDir0: 120, wind3: 20, windDir3: 240 }, createGrid())
    expect(plain.windScalar(1500)).toBeCloseTo(12.5, 9)
  })

  it('keeps profiles that do not cross north unchanged', () => {
    expect(at(160, 185).windDirection(1500)).toBe(172.5)
    expect(at(140, 200).windDirection(3000)).toBe(200)
  })
})
