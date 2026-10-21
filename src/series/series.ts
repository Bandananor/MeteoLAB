/**
 * Batch series (roadmap E3): a file that says what to run — the base settings (a scenario and the settings over it),
 * which knobs to vary and over which values, how many seeds and how long — and the runs it makes: every combination of
 * the values (the first knob slowest) times every seed, run off the main thread as the ensemble's members
 * (src/ensemble/pool.ts). The result is a table (one row per run) and one NetCDF file with every run's course and swaths,
 * the basis of the validation report (A1), the proximity-sounding statistics (A6) and the research of D1-D4.
 *
 * The same file gives the same runs: the seeds come from the file's first seed, and the file itself goes into the
 * NetCDF's attributes.
 */
import { SCENARIOS, type SimConfig } from '../core'
import { DEFAULTS, fillLowWind } from '../defaults'
import { cleanSettings } from '../share'
import { environmentOf, withHeat, withMoisture, withShear, withTurn } from '../settings/simple'

export const SERIES_VERSION = 1
/** At most this many runs in a series (a few hours on a laptop's cores at an hour each). */
export const MAX_RUNS = 400
/** A run's length, min. */
export const MINUTES = { min: 5, max: 240 }

/**
 * The knobs beyond the settings themselves, as the simple settings turn them: the air near the ground warmer by K,
 * the vapour below 1.5 km times a factor, the 0-6 km shear made so many m/s (the hodograph's shape kept), the wind
 * turning so many degrees from the ground to 3 km. They act after the settings, in this order.
 */
export const KNOBS = {
  heat_K: withHeat,
  moisture_factor: withMoisture,
  shear_0_6km_ms: withShear,
  turn_0_3km_deg: withTurn,
} as const satisfies Record<string, (c: SimConfig, v: number) => SimConfig>
type Knob = keyof typeof KNOBS
const isKnob = (k: string): k is Knob => Object.hasOwn(KNOBS, k)

export interface Series {
  name: string
  /** The scenario the settings lay over (by its name), or none: the defaults. */
  scenario: string | null
  settings: Partial<SimConfig>
  /** Each knob (a setting or one of KNOBS) with its values, in the file's order. */
  vary: [string, number[]][]
  /** The seeds, in order. */
  seeds: number[]
  minutes: number
}
export interface SeriesRun { index: number; params: Record<string, number>; seed: number; config: SimConfig; cape: number; shear: number; srh: number }

/** The k-th seed of a series from its first (the same file, the same seeds). */
export const seedAt = (first: number, k: number) => k ? ((first ^ Math.imul(k, 0x9e3779b1)) >>> 0) || 1 : first

/** Reads a series file; an error says what is wrong (in the file's own words: the key and the value). */
export function parseSeries(text: string, scenarios: readonly string[]): { series: Series } | { error: string } {
  let data: unknown
  try { data = JSON.parse(text) } catch (e) { return { error: `JSON: ${(e as Error).message}` } }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'the file is not a JSON object' }
  const f = data as Record<string, unknown>
  if (f.meteolab_series !== SERIES_VERSION) return { error: `"meteolab_series" must be ${SERIES_VERSION}` }
  const scenario = f.scenario ?? null
  if (scenario !== null && (typeof scenario !== 'string' || !scenarios.includes(scenario))) return { error: `"scenario": no scenario ${JSON.stringify(scenario)} (${scenarios.join(', ')})` }
  const raw = f.settings ?? {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: '"settings" must be an object' }
  const settings = cleanSettings(raw), dropped = Object.keys(raw).filter(k => !(k in settings) && k !== 'seed')
  if (dropped.length) return { error: `"settings": unknown or out of range: ${dropped.join(', ')}` }
  delete settings.seed
  const vary: [string, number[]][] = []
  if (typeof f.vary !== 'object' || f.vary === null || Array.isArray(f.vary)) return { error: '"vary" must be an object of knob: [values]' }
  for (const [key, values] of Object.entries(f.vary)) {
    if (!Array.isArray(values) || !values.length || !values.every(v => typeof v === 'number' && Number.isFinite(v))) return { error: `"vary.${key}" must be a list of numbers` }
    if (key === 'seed') return { error: '"vary.seed": the seeds go in "seeds"' }
    if (!isKnob(key)) {
      const bad = values.find(v => (cleanSettings({ [key]: v }) as Record<string, unknown>)[key] !== v)
      if (bad !== undefined) return { error: `"vary.${key}": not a numeric setting or out of range (${bad})` }
    }
    vary.push([key, values])
  }
  const minutes = f.minutes
  if (typeof minutes !== 'number' || !(minutes >= MINUTES.min && minutes <= MINUTES.max)) return { error: `"minutes" must be ${MINUTES.min}-${MINUTES.max}` }
  let seeds: number[]
  const okSeed = (s: unknown): s is number => Number.isInteger(s) && (s as number) > 0 && (s as number) < 2 ** 32
  if (Array.isArray(f.seeds)) {
    if (!f.seeds.length || !f.seeds.every(okSeed)) return { error: '"seeds" must be a count or a list of whole numbers 1 to 2^32-1' }
    seeds = f.seeds
  } else {
    const first = f.first_seed ?? 1
    if (!Number.isInteger(f.seeds) || (f.seeds as number) < 1) return { error: '"seeds" must be a count or a list of whole numbers 1 to 2^32-1' }
    if (!okSeed(first)) return { error: '"first_seed" must be a whole number 1 to 2^32-1' }
    seeds = Array.from({ length: f.seeds as number }, (_, k) => seedAt(first, k))
  }
  const runs = vary.reduce((n, [, v]) => n * v.length, seeds.length)
  if (runs > MAX_RUNS) return { error: `${runs} runs: at most ${MAX_RUNS} in a series` }
  return { series: { name: typeof f.name === 'string' ? f.name : '', scenario, settings, vary, seeds, minutes } }
}

/** A series' base settings: the defaults with its scenario and its settings laid over (as the simulator lays a link's). */
export function seriesBase(series: Series): SimConfig {
  const c: SimConfig = { ...structuredClone(DEFAULTS), ...(series.scenario === null ? {} : structuredClone(SCENARIOS.find(x => x.name === series.scenario)!.values)), ...structuredClone(series.settings) }
  fillLowWind(c)
  return c
}

/** A series file of these settings (a template to edit): its name, the scenario and the settings over it. */
export function seriesTemplate(name: string, scenario: string | null, settings: Partial<SimConfig>, seed: number) {
  const s = { ...settings } as Record<string, unknown>
  delete s.seed
  const text = JSON.stringify({ meteolab_series: SERIES_VERSION, name, scenario, settings: s, vary: { shear_0_6km_ms: [10, 20, 30], moisture_factor: [0.9, 1, 1.1] }, seeds: 2, first_seed: seed, minutes: 60 }, null, 2)
  // A list of numbers on one line (a sounding's levels and the knobs' values read better so).
  return text.replace(/\[\s*(-?[\d.e+-]+(?:,\s*-?[\d.e+-]+)*)\s*\]/g, (_, list: string) => `[${list.split(/,\s*/).join(', ')}]`)
}

/** Throws when a knob has nothing to act on in `base`: the heat in the WK formulas, the turning of a sounding's or WK's wind. */
export function checkKnobs(series: Series, base: SimConfig) {
  const keys = series.vary.map(([k]) => k), wk = base.profile === 'weisman-klemp'
  if (wk && keys.includes('heat_K')) throw new Error('"heat_K": the Weisman-Klemp profile has no ground temperature knob')
  if ((wk || base.sounding) && keys.includes('turn_0_3km_deg')) throw new Error('"turn_0_3km_deg": only the sliders’ wind turns (not a sounding’s or WK’s)')
}

/** Every run of a series from its base settings (`base`: the defaults with the scenario and the settings laid over); checkKnobs first. */
export function expandSeries(series: Series, base: SimConfig): SeriesRun[] {
  checkKnobs(series, base)
  const combos = series.vary.reduce<Record<string, number>[]>((list, [key, values]) => list.flatMap(p => values.map(v => ({ ...p, [key]: v }))), [{}])
  const runs: SeriesRun[] = []
  for (const params of combos) {
    // The settings first, then the knobs in KNOBS' order (the shear after the moisture: it is measured on the result).
    let c = { ...structuredClone(base), ...Object.fromEntries(Object.entries(params).filter(([k]) => !isKnob(k))) } as SimConfig
    for (const k of Object.keys(KNOBS) as Knob[]) if (k in params) c = KNOBS[k](c, params[k])
    const env = environmentOf(c)
    for (const seed of series.seeds) runs.push({ index: runs.length, params, seed, config: { ...structuredClone(c), seed }, cape: env.cape, shear: env.shear, srh: env.srh })
  }
  return runs
}
