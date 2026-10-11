import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, DEFAULT_GRID, DT, LARGE_GRID } from '.'
import { SUMMER_DAY } from './fixtures'

/** Fastest of `steps` model steps after two warm-up steps, ms (the fastest is the least disturbed by the machine). */
function stepTime(model: AtmosphereModel, steps = 6) {
  let best = Infinity
  for (let k = 0; k < steps + 2; k++) {
    const t0 = performance.now(); model.step(DT); model.time += DT
    if (k >= 2) best = Math.min(best, performance.now() - t0)
  }
  return best
}

describe('large domain (96 x 72 km)', () => {
  it('costs about 4x the standard domain per step: nothing in the step grows faster than the area', () => {
    const standard = new AtmosphereModel({ ...SUMMER_DAY }, createGrid(DEFAULT_GRID)), large = new AtmosphereModel({ ...SUMMER_DAY }, createGrid(LARGE_GRID))
    // Three alternating rounds, the fastest step of each domain: timed once, first, before the JIT had warmed up, the
    // standard one came out slow on a cloud runner (ratio 2.3), and other test files running alongside disturb any one timing.
    let small = Infinity, big = Infinity
    for (let round = 0; round < 3; round++) { small = Math.min(small, stepTime(standard, 4)); big = Math.min(big, stepTime(large, 4)) }
    const ratio = big / small
    const area = (LARGE_GRID.nx * LARGE_GRID.ny) / (DEFAULT_GRID.nx * DEFAULT_GRID.ny)
    // 4x the columns. The old O(n^2) Fourier transform made it ~6x: the upper bound is what matters; the lower one only
    // catches a broken measurement (allow 2-5.5x for timing noise).
    expect(area).toBe(4)
    expect(ratio).toBeGreaterThan(2); expect(ratio).toBeLessThan(5.5)
  }, 120_000)
})
