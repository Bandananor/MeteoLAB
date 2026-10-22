import { describe, expect, it } from 'vitest'
import { captionLayout, wrapParts } from './captions'

describe('video captions (M4)', () => {
  it('keeps a vertical frame’s text out of a phone app’s bottom fifth and right strip', () => {
    const v = captionLayout(1080, 1920)
    // The event and its numbers (two lines at most) end above the bottom fifth.
    expect(v.event + v.size * 2.25).toBeLessThan(1920 * .8)
    expect(v.margin + v.maxWidth).toBeLessThanOrEqual(1080 * .82 + 1)
    expect(v.size).toBeGreaterThan(40)
  })

  it('puts a wide frame’s event near the bottom, the text the same size relative to the short side', () => {
    const w = captionLayout(1920, 1080)
    expect(w.event).toBeGreaterThan(1080 * .8)
    expect(w.event + w.size).toBeLessThan(1080)
    expect(w.margin + w.maxWidth).toBe(1920 - w.margin)
    expect(captionLayout(3840, 2160).size / w.size).toBeCloseTo(2, 1)
  })

  it('wraps the numbers by their parts, never inside one', () => {
    const fits = (l: string) => l.length <= 28
    expect(wrapParts(['поток 41 м/с', 'дождь 86 мм/ч', 'град 1,8 см'], fits)).toEqual(['поток 41 м/с · дождь 86 мм/ч', 'град 1,8 см'])
    expect(wrapParts(['a', 'b'], () => true)).toEqual(['a · b'])
    expect(wrapParts(['очень длинная часть строки, длиннее места'], fits)).toEqual(['очень длинная часть строки, длиннее места'])
    expect(wrapParts([], fits)).toEqual([])
  })
})
