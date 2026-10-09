import { describe, expect, it } from 'vitest'
import { AtmosphereModel, columnLevels, createGrid, dryAdiabat, Environment, environmentLevels, mixingRatioTemperature, moistAdiabat, parcelIndices, parcelPath, qsatP, skewIndices, weismanKlemp } from '.'
import { QUIET, SUMMER_DAY } from './fixtures'

describe('Skew-T data (src/core/skewt.ts)', () => {
  const grid = createGrid(), env = new Environment(SUMMER_DAY, grid)

  it('draws the background lines consistently: theta, saturation and the pseudo-adiabat', () => {
    expect(dryAdiabat(300, 1000)).toBeCloseTo(26.85, 2)
    // On a mixing-ratio line the air is exactly saturated at that mixing ratio.
    for (const [r, p] of [[.004, 850], [.012, 1000], [.002, 500]]) expect(qsatP(mixingRatioTemperature(r, p), p * 100)).toBeCloseTo(r, 5)
    // The pseudo-adiabat passes through its label at 1000 hPa, cools upwards, and more slowly than the dry adiabat.
    const line = moistAdiabat(20), at = (p: number) => line.find(x => x.p === p)!.t
    expect(at(1000)).toBeCloseTo(20, 4); expect(at(500)).toBeLessThan(at(700))
    expect(at(1000) - at(850)).toBeLessThan(dryAdiabat(293.15, 1000) - dryAdiabat(293.15, 850))
  })

  it('gives each standard parcel the same numbers as the indices in the side panel', () => {
    const i = parcelIndices(env, grid.height)
    for (const kind of ['sb', 'ml', 'mu'] as const) {
      const p = parcelPath(env, grid.height, kind)
      expect(p.cape).toBeCloseTo(i[kind].cape, 6); expect(p.cin).toBeCloseTo(i[kind].cin, 6); expect(p.lfc).toBe(i[kind].lfc)
      // Pressures fall with height along the path; the LCL lies below the LFC.
      expect(p.path.every((x, k) => k === 0 || x.p < p.path[k - 1].p)).toBe(true)
      if (p.pLcl !== null && p.pLfc !== null) expect(p.pLcl).toBeGreaterThanOrEqual(p.pLfc)
    }
    // A buoyant surface parcel on a summer day: negative lifted index.
    expect(parcelPath(env, grid.height, 'sb').li!).toBeLessThan(0)
  })

  it('lists the environment from the ground up and reads a column of the model', () => {
    const levels = environmentLevels(env, grid.height)
    expect(levels[0].z).toBe(0); expect(levels[0].t).toBeCloseTo(env.temperatureEnv(0), 6)
    expect(levels.every(l => l.td <= l.t + 1e-6)).toBe(true); expect(levels.at(-1)!.p).toBeGreaterThanOrEqual(100)
    // A fresh model is the environment itself (up to the starting noise), with the ground-relative wind.
    const m = new AtmosphereModel({ ...QUIET, bubble: 0 }, grid), column = columnLevels(m, 5, 5)
    expect(column[0].t).toBeCloseTo(m.env.temperatureEnv(0), 1)
    const [u, v] = m.env.windUV(grid.zs[3]); expect(column[3].u).toBeCloseTo(u, 3); expect(column[3].v).toBeCloseTo(v, 3)
  })

  it('summarises the environment: the WK sounding has ~40 mm of water and 6-8 K/km aloft', () => {
    const wk = new Environment({ ...SUMMER_DAY, profile: 'weisman-klemp' }, grid, weismanKlemp({ qvMax: .014 })), s = skewIndices(wk, grid.height)
    expect(s.pw).toBeGreaterThan(30); expect(s.pw).toBeLessThan(60)
    expect(s.lapse75).toBeGreaterThan(5); expect(s.lapse75).toBeLessThan(9); expect(s.freezing!).toBeGreaterThan(3)
  })
})
