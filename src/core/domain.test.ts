import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, customGrid, DEFAULT_GRID, domainGrid, DT, LARGE_GRID } from '.'
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
  it('costs about 4x the standard domain per step: nothing in the step grows faster than the area', { timeout: 120_000, retry: 2 }, () => {
    const standard = new AtmosphereModel({ ...SUMMER_DAY }, createGrid(DEFAULT_GRID)), large = new AtmosphereModel({ ...SUMMER_DAY }, createGrid(LARGE_GRID))
    // Three alternating rounds, the fastest step of each domain: timed once, first, before the JIT had warmed up, the
    // standard one came out slow on a cloud runner (ratio 2.3), and other test files running alongside disturb any one timing.
    let small = Infinity, big = Infinity
    for (let round = 0; round < 3; round++) { small = Math.min(small, stepTime(standard, 4)); big = Math.min(big, stepTime(large, 4)) }
    const ratio = big / small
    const area = (LARGE_GRID.nx * LARGE_GRID.ny) / (DEFAULT_GRID.nx * DEFAULT_GRID.ny)
    // 4x the columns. The old O(n^2) Fourier transform made it ~6x: the upper bound is what matters; the lower one only
    // catches a broken measurement (allow 2-5.5x for timing noise). Up to three tries: on a shared cloud runner, with
    // other test files running alongside, one try once measured 7.0 (2026-10-12; 3.98-4.07 on a quiet laptop) — a real
    // cost that grows faster than the area fails every try.
    expect(area).toBe(4)
    expect(ratio).toBeGreaterThan(2); expect(ratio).toBeLessThan(5.5)
  })
})

describe('a domain of the user\'s own size (SimConfig.domainSize)', () => {
  it('fits the size to steps of 12 x 9 km within the limits, at the standard spacing', () => {
    expect(customGrid([60, 45])).toMatchObject({ nx: 50, ny: 40, width: 60_000, depth: 45_000 })
    // Off the steps: rounded; beyond the limits: held there; nonsense: the smallest.
    expect(customGrid([50, 40])).toMatchObject({ width: 48_000, depth: 36_000 })
    expect(customGrid([1000, 1])).toMatchObject({ width: 144_000, depth: 18_000 })
    expect(customGrid([NaN, NaN])).toMatchObject({ width: 24_000, depth: 18_000 })
    expect(domainGrid('custom', undefined, [36, 27])).toMatchObject({ nx: 30, ny: 24 })
    // Without a size, 'custom' is the standard domain.
    expect(domainGrid('custom')).toEqual(DEFAULT_GRID)
  })

  it('runs on an odd-sized grid (30 x 24 columns: the pressure and the field solvers take any size)', () => {
    const config = { ...SUMMER_DAY, domain: 'custom' as const, domainSize: [36, 27] as [number, number] }, m = new AtmosphereModel(config)
    expect([m.grid.nx, m.grid.ny]).toEqual([30, 24])
    for (let k = 0; k < 20; k++) { m.step(DT); m.time += DT }
    expect(m.u.every(Number.isFinite) && m.w.every(Number.isFinite)).toBe(true)
    expect(m.diagnostics().updraft).toBeGreaterThan(.3)
  })
})

describe('a finer horizontal grid (SimConfig.spacing, roadmap C2)', () => {
  it('keeps the domain and the levels and sets the same spacing in x and y', () => {
    expect(domainGrid('standard', undefined, undefined, .5)).toMatchObject({ nx: 96, ny: 72, nz: 50, width: 48_000, depth: 36_000 })
    expect(domainGrid('large', undefined, undefined, .25)).toMatchObject({ nx: 384, ny: 288, width: 96_000 })
    expect(domainGrid('custom', 22, [36, 27], .6)).toMatchObject({ nx: 60, ny: 45, height: 22_000 })
    expect(domainGrid('standard', undefined, undefined, undefined)).toEqual(DEFAULT_GRID)
  })

  it('runs at 0.6 km (80 x 60 columns)', () => {
    const m = new AtmosphereModel({ ...SUMMER_DAY, spacing: .6 })
    expect([m.grid.nx, m.grid.ny, m.grid.dx, m.grid.dy]).toEqual([80, 60, 600, 600])
    for (let k = 0; k < 10; k++) { m.step(DT); m.time += DT }
    expect(m.u.every(Number.isFinite) && m.w.every(Number.isFinite)).toBe(true)
    expect(m.diagnostics().updraft).toBeGreaterThan(.3)
  })
})
