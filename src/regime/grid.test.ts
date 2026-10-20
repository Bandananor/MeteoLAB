import { describe, expect, it } from 'vitest'
import { MESO_PERSISTENCE, SCENARIOS } from '../core'
import { DEFAULTS } from '../defaults'
import { SUMMER_DAY } from '../core/fixtures'
import type { MemberResult, MemberSample } from '../ensemble/member'
import { environmentOf, GRIDS, regimeCells, regimeOf, withMoisture, withShear } from './grid'

const wk = { ...SUMMER_DAY, profile: 'weisman-klemp' as const }
const levels = [0, 1000, 3000, 6000, 12000].map(z => ({ p: 1e5 * Math.exp(-z / 8000), z, t: 28 - z * .0065, td: 18 - z * .004, u: 2 + z / 500, v: z / 2000 }))

describe('regime map (src/regime)', () => {
  it('makes the 0-6 km shear asked, from the sliders, a sounding and the WK hodograph alike', () => {
    for (const c of [SUMMER_DAY, wk, { ...SUMMER_DAY, sounding: { levels } }]) for (const s of [0, 15, 40]) expect(environmentOf(withShear(c, s)).shear).toBeCloseTo(s, 0)
    // A calm profile takes a straight westerly shear.
    const calm = { ...SUMMER_DAY, wind0: 0, wind3: 0, wind6: 0, wind10: 0 }
    expect(environmentOf(withShear(calm, 20)).shear).toBeCloseTo(20, 0)
    // The shape is kept: the 0-3 km half of the WK shear stays its share.
    const a = withShear(wk, 15).weismanKlemp!
    expect(a.radius! / a.u6!).toBeCloseTo(8 / 30, 6)
  })

  it('moistens the air below 1.5 km and with it the CAPE, leaving the shear', () => {
    for (const c of [SUMMER_DAY, wk, { ...SUMMER_DAY, sounding: { levels } }]) {
      const dry = environmentOf(withMoisture(c, .85)), base = environmentOf(c), wet = environmentOf(withMoisture(c, 1.1))
      expect(dry.cape).toBeLessThan(base.cape); expect(wet.cape).toBeGreaterThan(base.cape)
      expect(wet.shear).toBeCloseTo(base.shear, 6)
    }
    expect(withMoisture(wk, .75).weismanKlemp!.qvMax).toBeCloseTo(.012, 6)
  })

  it('lays out the grid: rows by moisture, columns by shear, every scenario', () => {
    const cells = regimeCells(SUMMER_DAY, 'full'), { moisture, shear } = GRIDS.full
    expect(cells.length).toBe(moisture.length * shear.length)
    for (const c of cells) expect(c.shear).toBeCloseTo(shear[c.column], 0)
    // CAPE grows up the rows, the same along each.
    for (let r = 1; r < moisture.length; r++) expect(cells[r * shear.length].cape).toBeGreaterThan(cells[(r - 1) * shear.length].cape)
    for (const s of SCENARIOS) expect(regimeCells({ ...DEFAULTS, ...s.values }, 'small').every(c => Number.isFinite(c.cape) && Math.abs(c.shear - GRIDS.small.shear[c.column]) < 1.5)).toBe(true)
  })

  it('names the regime from a run’s course', () => {
    const run = (updrafts: number[], o: Partial<MemberSample> = {}, every = 600): MemberResult => ({ seed: 1, nx: 1, ny: 1, width: 1, depth: 1, rainTotal: new Float32Array(1), hailSize: new Float32Array(1), gustMax: new Float32Array(1), uhMax: new Float32Array(1),
      samples: updrafts.map((w, k) => ({ t: k * every, updraft: w, uh: 0, rain: w > 5 ? 20 : 0, gust: 0, hail: 0, flashes: 0, rotationHeld: 0, cores: 1, ...o })) })
    expect(regimeOf(run([0, 4, 6, 3]))).toBe('none')
    expect(regimeOf(run([0, 30, 12, 2, 1]))).toBe('ordinary')
    expect(regimeOf(run([0, 30, 12, 20, 18]))).toBe('multicell')
    expect(regimeOf(run([0, 30, 12, 20, 18], { rotationHeld: MESO_PERSISTENCE }))).toBe('supercell')
    // «Суперячейка WK» over 45 min, every minute: without shear one long cell that decays, at 20 m/s new ones (2-4 cores).
    const calm = '2 1 3 4 6 8 10 13 16 21 25 30 37 44 52 60 69 68 62 57 54 55 57 54 56 57 53 52 54 51 46 45 47 41 36 30 27 28 30 30 27 21 15 10 7 6'
    const sheared = '2 1 3 4 5 7 9 11 14 17 21 24 28 33 38 42 49 54 57 57 52 52 51 49 51 48 43 40 42 45 51 50 45 39 33 35 37 41 42 41 38 37 37 39 36 32'
    expect(regimeOf(run(calm.split(' ').map(Number), {}, 60))).toBe('ordinary')
    expect(regimeOf(run(sheared.split(' ').map(Number), {}, 60))).toBe('multicell')
  })
})
