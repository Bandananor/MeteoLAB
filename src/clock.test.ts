import { describe, expect, it } from 'vitest'
import { elapsed, elapsedShort, minuteMark, timeOfDay } from './clock'

describe('time on the page (src/clock.ts)', () => {
  it('the run in hours, the local time it has reached, minute marks', () => {
    expect(elapsed(0)).toBe('0:00:00'); expect(elapsed(425)).toBe('0:07:05'); expect(elapsed(4800)).toBe('1:20:00')
    // Started at 8:00, an hour later it is 9:00; 13.5 h is 13:30; past midnight it wraps.
    expect(timeOfDay(8, 3600)).toBe('09:00'); expect(timeOfDay(13.5, 0)).toBe('13:30'); expect(timeOfDay(23, 7200)).toBe('01:00')
    expect(elapsedShort(425)).toBe('0:07'); expect(elapsedShort(4800)).toBe('1:20')
    expect(minuteMark(40)).toBe('40′'); expect(minuteMark(70)).toBe('1:10'); expect(minuteMark(120)).toBe('2:00')
  })
})
