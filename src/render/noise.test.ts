import { describe, expect, it } from 'vitest'
import { NOISE_SIZE, noiseTexture } from './noise'

describe('baked cloud noise (2.7 step 4)', () => {
  it('fills three octaves over the whole range and tiles: across each side it goes on as smoothly as inside', () => {
    const t = noiseTexture(), data = t.image.data as Uint8Array, n = NOISE_SIZE, at = (x: number, y: number, z: number, c: number) => data[((x % n) + (y % n) * n + (z % n) * n * n) * 4 + c]
    for (let c = 0; c < 3; c++) {
      let lo = 255, hi = 0, inside = 0, across = 0
      for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) { const v = at(x, y, z, c); lo = Math.min(lo, v); hi = Math.max(hi, v) }
        inside = Math.max(inside, Math.abs(at(n / 2, y, z, c) - at(n / 2 - 1, y, z, c)))
        across = Math.max(across, Math.abs(at(0, y, z, c) - at(n - 1, y, z, c)), Math.abs(at(y, 0, z, c) - at(y, n - 1, z, c)), Math.abs(at(y, z, 0, c) - at(y, z, n - 1, c)))
      }
      expect(lo).toBeLessThan(40); expect(hi).toBeGreaterThan(215)
      // The finest octave changes by at most ~a third of its range per texel; across the seams no more than inside.
      expect(across).toBeLessThanOrEqual(Math.max(inside, 90))
    }
    expect(Array.from(noiseTexture().image.data as Uint8Array).slice(0, 64)).toEqual(Array.from(data.slice(0, 64)))
    t.dispose()
  })
})
