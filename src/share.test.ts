import { describe, expect, it } from 'vitest'
import { SCENARIOS, type SimConfig } from './core'
import { SUMMER_DAY } from './core/fixtures'
import { decodeSettings, encodeSettings, toCsv } from './share'

const NAMES = SCENARIOS.map(s => s.name)
const encodeText = (json: string) => btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const encode = (data: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(data)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('shared links and CSV (src/share.ts)', () => {
  it('carries the changed settings and the scenario, and gives them back', () => {
    const base: SimConfig = { ...SUMMER_DAY, ...SCENARIOS[2].values }
    const config: SimConfig = { ...base, surfaceTemp: 31.5, wind6: 25, surfaceType: 'urban', domain: 'large', frameMotion: [14, 0], followStorm: false, nightInversion: 4 }
    const link = encodeSettings(config, base, SCENARIOS[2].name)
    expect(link).toMatch(/^[A-Za-z0-9_-]+$/)
    const back = decodeSettings(link, NAMES)!
    expect(back.scenario).toBe(2)
    expect(back.values).toEqual({ surfaceTemp: 31.5, wind6: 25, surfaceType: 'urban', domain: 'large', frameMotion: [14, 0], followStorm: false, nightInversion: 4 })
    // Nothing changed: an empty set of values.
    expect(decodeSettings(encodeSettings(base, base, null), NAMES)).toEqual({ scenario: null, values: {} })
  })

  it('finds the scenario by name; the first links (numbers in the old order) still open the same one', () => {
    expect(decodeSettings(encode({ n: 'HSLC', c: {} }), NAMES)!.scenario).toBe(NAMES.indexOf('HSLC'))
    expect(decodeSettings(encode({ s: 5, c: {} }), NAMES)!.scenario).toBe(NAMES.indexOf('HSLC'))
    // Renamed (2026-10-12): the old name opens the scenario under its new one.
    expect(decodeSettings(encode({ n: 'Сдвиг ветра', c: {} }), NAMES)!.scenario).toBe(NAMES.indexOf('Многоячейковая гроза'))
    expect(decodeSettings(encode({ s: 2, c: {} }), NAMES)!.scenario).toBe(NAMES.indexOf('Многоячейковая гроза'))
    // Retired ones (the first loaded gun, 2026-10-11; «Сухой воздух», 2026-10-12): their own values under the link's,
    // without a scenario — the same experiment. The new «Заряженное ружьё» keeps its name for itself.
    const gun = decodeSettings(encode({ s: 4, c: { hour: 9 } }), NAMES)!
    expect(gun.scenario).toBeNull(); expect(gun.values).toMatchObject({ capStrength: 3, capHeight: 1, surfaceTemp: 30, hour: 9 })
    expect(decodeSettings(encode({ n: 'Заряженное ружьё', c: {} }), NAMES)!.scenario).toBe(NAMES.indexOf('Заряженное ружьё'))
    const dry = decodeSettings(encode({ n: 'Сухой воздух', c: { rhMid: 20 } }), NAMES)!
    expect(dry.scenario).toBeNull(); expect(dry.values).toMatchObject({ rhMid: 20, rhLow: 35, surfaceTemp: 25.5, bubbleRadius: 2.5 })
    expect(decodeSettings(encodeSettings(SUMMER_DAY, SUMMER_DAY, 'Нет такого'), NAMES)!.scenario).toBeNull()
  })

  it('drops whatever is unknown or of the wrong kind, and refuses a broken link', () => {
    const back = decodeSettings(encode({ s: 99, c: { surfaceTemp: '30', surfaceType: 'lava', wind0: 1e9, hour: 7, frameMotion: [1, 'x'], constructor: 1, seed: 5 } }), NAMES)!
    // A whole positive seed is a known setting too (files carry it; a link has it as ?seed= as well).
    expect(back).toEqual({ scenario: null, values: { hour: 7, seed: 5 } })
    // A "__proto__" key in the JSON itself is dropped and pollutes nothing.
    expect(decodeSettings(encodeText('{"c":{"__proto__":{"polluted":1},"hour":8}}'), NAMES)!.values).toEqual({ hour: 8 })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(decodeSettings('%%%not base64', NAMES)).toBeNull()
    expect(decodeSettings(encode([1, 2]), NAMES)).toEqual({ scenario: null, values: {} })
  })

  it('writes CSV with a header, rounded numbers and quoted text', () => {
    const csv = toCsv([{ t: 30, w: 12.34567, note: 'a, "b"' }, { t: 60, w: NaN, note: '' }], [['t_s', r => r.t], ['w_ms', r => r.w], ['note', r => r.note]])
    expect(csv).toBe('t_s,w_ms,note\n30,12.346,"a, ""b"""\n60,,""\n')
  })
})
