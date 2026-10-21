import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '../defaults'
import type { MemberResult } from '../ensemble/member'
import { environmentOf } from '../settings/simple'
import { expandSeries, MAX_RUNS, parseSeries, seedAt, type Series, seriesTemplate } from './series'
import { seriesCsv, seriesNetCDF } from './results'

const NAMES = ['Летний день', 'Суперячейка']
const file = (over: Record<string, unknown> = {}) => JSON.stringify({ meteolab_series: 1, name: 'тест', scenario: null, settings: { surfaceTemp: 30 }, vary: { wind6: [10, 20], moisture_factor: [0.9, 1.1] }, seeds: 2, first_seed: 77, minutes: 30, ...over })
const parsed = (text: string) => { const r = parseSeries(text, NAMES); if ('error' in r) throw new Error(r.error); return r.series }
const error = (over: Record<string, unknown>) => { const r = parseSeries(file(over), NAMES); return 'error' in r ? r.error : '' }

describe('batch series (E3)', () => {
  it('reads a file: the scenario, the settings, the knobs in order, the seeds from the first one', () => {
    const s = parsed(file())
    expect(s).toMatchObject({ name: 'тест', scenario: null, settings: { surfaceTemp: 30 }, vary: [['wind6', [10, 20]], ['moisture_factor', [0.9, 1.1]]], minutes: 30 })
    expect(s.seeds).toEqual([77, seedAt(77, 1)])
    expect(s.seeds[1]).not.toBe(77)
    expect(parsed(file({ seeds: [5, 6, 7] })).seeds).toEqual([5, 6, 7])
    expect(parsed(file({ scenario: 'Суперячейка' })).scenario).toBe('Суперячейка')
  })

  it('says what is wrong in a file', () => {
    expect(parseSeries('{', NAMES)).toHaveProperty('error')
    expect(error({ meteolab_series: 2 })).toMatch(/meteolab_series/)
    expect(error({ scenario: 'Нет такого' })).toMatch(/scenario/)
    expect(error({ settings: { surfaceTemp: 30, nonsense: 1 } })).toMatch(/nonsense/)
    expect(error({ vary: { wind6: [] } })).toMatch(/vary.wind6/)
    expect(error({ vary: { surfaceType: [1, 2] } })).toMatch(/vary.surfaceType/)
    expect(error({ vary: { seed: [1, 2] } })).toMatch(/seeds/)
    expect(error({ minutes: 1000 })).toMatch(/minutes/)
    expect(error({ seeds: 0 })).toMatch(/seeds/)
    expect(error({ seeds: [1.5] })).toMatch(/seeds/)
    expect(error({ vary: { wind6: Array.from({ length: 30 }, (_, k) => k) }, seeds: 20 })).toMatch(String(MAX_RUNS))
  })

  it('expands into every combination times every seed, the first knob slowest; the knobs act on the settings', () => {
    const s = parsed(file()), base = { ...structuredClone(DEFAULTS), surfaceTemp: 30 }
    const runs = expandSeries(s, base)
    expect(runs.map(r => [r.params.wind6, r.params.moisture_factor, r.seed])).toEqual([
      [10, .9, 77], [10, .9, s.seeds[1]], [10, 1.1, 77], [10, 1.1, s.seeds[1]], [20, .9, 77], [20, .9, s.seeds[1]], [20, 1.1, 77], [20, 1.1, s.seeds[1]],
    ])
    expect(runs.map(r => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(runs[0].config.wind6).toBe(10); expect(runs[7].config.wind6).toBe(20)
    // The moisture scales the slider humidity; the environment is measured on the result.
    expect(runs[2].config.rhSurface / runs[0].config.rhSurface).toBeCloseTo(1.1 / .9, 5)
    expect(runs[2].cape).toBeGreaterThan(runs[0].cape)
    expect(runs[0].cape).toBeCloseTo(environmentOf(runs[0].config).cape, 6)
    // The shear knob makes the 0-6 km difference asked.
    const sheared = expandSeries(parsed(file({ vary: { shear_0_6km_ms: [25] }, seeds: 1 })), base)
    expect(sheared[0].shear).toBeCloseTo(25, 0)
  })

  it('refuses a knob with nothing to act on', () => {
    const wk = { ...structuredClone(DEFAULTS), profile: 'weisman-klemp' as const }
    expect(() => expandSeries(parsed(file({ vary: { heat_K: [1] } })), wk)).toThrow(/heat_K/)
    expect(() => expandSeries(parsed(file({ vary: { turn_0_3km_deg: [45] } })), wk)).toThrow(/turn/)
  })

  it('makes a template from settings that reads back as they are', () => {
    const s = parsed(seriesTemplate('мой опыт', 'Суперячейка', { surfaceTemp: 31, seed: 9 }, 1234))
    expect(s).toMatchObject({ name: 'мой опыт', scenario: 'Суперячейка', settings: { surfaceTemp: 31 } })
    expect(s.seeds[0]).toBe(1234)
  })

  it('writes the finished runs as a table and a NetCDF file', () => {
    const s: Series = parsed(file({ vary: { wind6: [10, 20] }, seeds: 1 })), runs = expandSeries(s, structuredClone(DEFAULTS))
    const result = (k: number): MemberResult => ({
      seed: runs[k].seed, nx: 3, ny: 2, width: 3000, depth: 2000,
      samples: [0, 60, 120].map(t => ({ t, updraft: 5 + k * 10 + t / 60, uh: 0, rain: 2, gust: 8, hail: 0, flashes: 0, rotationHeld: 0, cores: 1 })),
      rainTotal: Float32Array.from([0, 1, 2, 3, 4, 5 + k]), hailSize: new Float32Array(6), gustMax: new Float32Array(6), uhMax: new Float32Array(6),
    })
    // Only the second run has finished.
    const results = [null, result(1)], csv = seriesCsv(['wind6'], runs, results).trim().split('\n')
    expect(csv).toHaveLength(2)
    expect(csv[0]).toMatch(/^model_version,seed,run_link,run,wind6,env_ml_cape_jkg,env_shear_0_6km_ms,env_srh_0_3km_m2s2,regime,max_updraft_ms/)
    expect(csv[1].split(',').slice(3, 5)).toEqual(['1', '20'])
    expect(csv[1]).toContain(',17,')
    expect(seriesNetCDF(['wind6'], runs, [null, null], { name: 'x', version: 'v', text: '{}' })).toBeNull()
    const nc = seriesNetCDF(['wind6'], runs, [result(0), result(1)], { name: 'тест', version: 'v9', text: file() })!
    expect(String.fromCharCode(...nc.subarray(0, 3))).toBe('CDF')
    const latin = new TextDecoder().decode(nc)
    for (const name of ['series_json', 'max_updraft', 'rain_total', 'regime', 'flag_meanings', 'wind6']) expect(latin).toContain(name)
  })
})
