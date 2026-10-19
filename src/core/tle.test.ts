import { describe, expect, it } from 'vitest'
import { breakdownField, IONOSPHERE, momentField, transientEvent } from './tle'

describe('sprites and halos (2.7.3)', () => {
  it('need a charge moment change of a few hundred C km, as observed: a sprite from ~410, a halo from ~200', () => {
    expect(transientEvent(100e3)).toBeUndefined()
    expect(transientEvent(250e3)?.kind).toBe('halo')
    const sprite = transientEvent(500e3)!
    expect(sprite.kind).toBe('sprite'); expect(sprite.height).toBeLessThan(IONOSPHERE); expect(sprite.height).toBeGreaterThan(75e3)
    // At the threshold height the field equals the breakdown field; a stronger flash starts its streamers lower.
    expect(momentField(500e3, sprite.height) / breakdownField(sprite.height)).toBeCloseTo(1, 3)
    expect(transientEvent(2000e3)!.height).toBeLessThan(sprite.height)
    // Either polarity drives the field; the sign of the charge only changes which way it points.
    expect(transientEvent(-500e3)?.kind).toBe('sprite')
  })
})
