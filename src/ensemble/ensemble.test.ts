import { describe, expect, it } from 'vitest'
import { AtmosphereModel, MESO_PERSISTENCE } from '../core'
import { SUMMER_DAY } from '../core/fixtures'
import { memberPeaks, probabilities, probabilityMap, spread } from './combine'
import { addSwaths, type MemberResult, type MemberSample, perturbConfig, runMember, SAMPLE_EVERY, UNCERTAINTY } from './member'

const sample = (t: number, o: Partial<MemberSample> = {}): MemberSample => ({ t, updraft: 0, uh: 0, rain: 0, gust: 0, hail: 0, flashes: 0, rotationHeld: 0, ...o })
/** A 2 x 2 member with the given highlights and swaths. */
function member(samples: MemberSample[], maps: Partial<Record<'rainTotal' | 'hailSize' | 'gustMax' | 'uhMax', number[]>> = {}): MemberResult {
  const f = (v?: number[]) => Float32Array.from(v ?? [0, 0, 0, 0])
  return { seed: 1, samples, nx: 2, ny: 2, width: 2000, depth: 2000, rainTotal: f(maps.rainTotal), hailSize: f(maps.hailSize), gustMax: f(maps.gustMax), uhMax: f(maps.uhMax) }
}

describe('ensemble (src/ensemble)', () => {
  it('runs a member: a sample every SAMPLE_EVERY model seconds and swaths over the ground', () => {
    const r = runMember({ ...SUMMER_DAY, seed: 11 }, 3)
    expect(r.samples.map(s => s.t)).toEqual([0, 1, 2, 3].map(k => k * SAMPLE_EVERY))
    expect(r.seed).toBe(11); expect(r.gustMax.length).toBe(r.nx * r.ny)
    expect(Math.max(...r.gustMax)).toBeGreaterThan(0)
  })

  it('folds the domain columns into the ground ones, shifted by how far the domain has moved', () => {
    const grid = { nx: 4, ny: 2, dx: 1000, dy: 1000 }, u = new Float32Array(8), v = new Float32Array(8), uhColumn = new Float32Array(8)
    u[1] = 10; uhColumn[1] = 300
    // The domain has moved 2 km east: its column 1 lies over ground column 3.
    const m = { grid, frame: [5, 0] as const, time: 400, u, v, uhColumn, edges: () => 'periodic' as const }
    const gust = new Float32Array(8), uh = new Float32Array(8)
    addSwaths(m as never, gust, uh)
    expect(uh[3]).toBe(300); expect(gust[3]).toBe(15); expect(gust[0]).toBe(5)
  })

  it('perturbs the starting data from the member’s seed, within the uncertainty, without touching the settings given', () => {
    const base = { ...SUMMER_DAY, seed: 5 }, a = perturbConfig(base), b = perturbConfig({ ...base })
    expect(a).toEqual(b); expect(base.startOffset).toBeUndefined()
    expect(perturbConfig({ ...base, seed: 6 }).surfaceTemp).not.toBe(a.surfaceTemp)
    // Over many seeds the deviations have about the standard deviations asked.
    const many = Array.from({ length: 400 }, (_, k) => perturbConfig({ ...base, seed: k + 1 })), sd = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length)
    expect(sd(many.map(c => c.surfaceTemp - base.surfaceTemp))).toBeCloseTo(UNCERTAINTY.temperature, 1)
    expect(sd(many.map(c => c.wind6 - base.wind6)) / UNCERTAINTY.wind).toBeCloseTo(1, 0)
    expect(sd(many.map(c => c.startOffset![0])) / UNCERTAINTY.offset).toBeCloseTo(1, 0)
    // A real sounding: temperature changed only below 1.5 km, the wind at every level.
    const levels = [0, 1000, 3000, 8000].map(z => ({ p: 1e5 - z * 10, z, t: 25 - z / 150, td: 15 - z / 300, u: 5, v: 0 }))
    const s = perturbConfig({ ...base, sounding: { levels } }).sounding!.levels
    expect(s[0].t).not.toBe(levels[0].t); expect(s[2].t).toBe(levels[2].t); expect(s[3].t).toBe(levels[3].t); expect(s[3].u).not.toBe(5)
  })

  it('shifts the starting thermals by startOffset', () => {
    const warmest = (m: AtmosphereModel) => { let best = 0; for (let c = 0; c < m.grid.layer; c++) if (m.theta[c] > m.theta[best]) best = c; return [best % m.grid.nx, Math.floor(best / m.grid.nx)] }
    const plain = new AtmosphereModel({ ...SUMMER_DAY, seed: 3 }), shifted = new AtmosphereModel({ ...SUMMER_DAY, seed: 3, startOffset: [4 * plain.grid.dx, 2 * plain.grid.dy] })
    const [x0, y0] = warmest(plain), [x1, y1] = warmest(shifted)
    expect([x1 - x0, y1 - y0]).toEqual([4, 2])
  })

  it('reads the probabilities, the spread and the probability maps', () => {
    const results = [
      member([sample(0), sample(600, { updraft: 30, rain: 60, rotationHeld: MESO_PERSISTENCE })], { rainTotal: [20, 0, 0, 0], gustMax: [25, 0, 0, 0] }),
      member([sample(0), sample(600, { updraft: 20, rain: 5, gust: 22 })], { rainTotal: [12, 3, 0, 0] }),
      member([sample(0), sample(600, { updraft: 4 })]),
      member([sample(0), sample(600, { updraft: 15, rain: 2, hail: 25 })], { rainTotal: [0, 11, 0, 0] }),
    ]
    const peaks = results.map(memberPeaks), p = probabilities(peaks)
    expect(peaks[0].mesocyclone).toBe(0); expect(peaks[1].mesocyclone).toBeNull()
    expect([p.storm, p.mesocyclone, p.downpour, p.hail, p.gust, p.total]).toEqual([.75, .25, .25, .25, .25, .25])
    expect(spread(peaks.map(x => x.updraft))).toEqual({ min: 4, median: 17.5, max: 30 })
    expect(Array.from(probabilityMap(results, 'rain'))).toEqual([.5, .25, 0, 0])
    expect(Array.from(probabilityMap(results, 'gust'))).toEqual([.25, 0, 0, 0])
  })
})
