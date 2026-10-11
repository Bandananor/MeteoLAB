// Sharing an experiment and taking its results away: a link that carries every setting (not only the seed), and the
// time series as CSV files. The link is outside input, so decoding accepts only known settings of the right kind.
import type { SimConfig } from './core'

/** The settings a link may carry, with what each may be: a number, one of a few words, a flag or a pair of numbers. */
const KINDS: Record<string, 'number' | 'boolean' | 'pair' | readonly string[]> = {
  surfaceTemp: 'number', lapseLow: 'number', lapseMid: 'number', lapseUpper: 'number', tropopause: 'number', stratoWarming: 'number',
  rhSurface: 'number', rhLow: 'number', rhMid: 'number', rhUpper: 'number',
  wind0: 'number', wind05: 'number', wind1: 'number', wind3: 'number', wind6: 'number', wind10: 'number',
  windDir0: 'number', windDir05: 'number', windDir1: 'number', windDir3: 'number', windDir6: 'number', windDir10: 'number',
  capHeight: 'number', capStrength: 'number', moistLayer: 'number', nightInversion: 'number', front: 'number', top: 'number',
  latitude: 'number', turbulence: 'number', hour: 'number', dayOfYear: 'number', solarMax: 'number', soilMoisture: 'number',
  speed: 'number', bubble: 'number', bubbleRadius: 'number',
  surfaceType: ['grass', 'dry', 'water', 'urban'], microphysics: ['warm', 'ice'], transport: ['semi-lagrangian', 'weno'],
  profile: ['weisman-klemp'], domain: ['standard', 'large'], edges: ['periodic', 'relaxed', 'relaxed-x'], start: ['thermals', 'line'],
  followStorm: 'boolean', frameMotion: 'pair',
}
/** Numbers from a link are kept within this magnitude (a slider never goes near it). */
const LIMIT = 1e5

const fits = (kind: (typeof KINDS)[string], v: unknown) => {
  if (kind === 'number') return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= LIMIT
  if (kind === 'boolean') return typeof v === 'boolean'
  if (kind === 'pair') return Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= LIMIT)
  return typeof v === 'string' && kind.includes(v)
}

const toBase64Url = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromBase64Url = (text: string) => new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))

/** Numbers to 4 decimals: no float noise like 4.166666666666667 in the link. */
const round = (v: unknown): unknown => typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : Array.isArray(v) ? v.map(round) : v

/** The settings that differ from `base` (the defaults with the scenario laid over), with the scenario's index, as a URL-safe string. */
export function encodeSettings(config: SimConfig, base: SimConfig, scenario: number | null) {
  const values: Record<string, unknown> = {}
  for (const key of Object.keys(KINDS)) {
    const v = round((config as unknown as Record<string, unknown>)[key]), b = round((base as unknown as Record<string, unknown>)[key])
    if (v !== undefined && JSON.stringify(v) !== JSON.stringify(b)) values[key] = v
  }
  return toBase64Url(JSON.stringify(scenario === null ? { c: values } : { s: scenario, c: values }))
}

/** Reads a link's settings back; anything unknown or of the wrong kind is dropped, a broken string gives null. */
export function decodeSettings(text: string, scenarios: number): { scenario: number | null; values: Partial<SimConfig> } | null {
  let data: unknown
  try { data = JSON.parse(fromBase64Url(text)) } catch { return null }
  if (!data || typeof data !== 'object') return null
  const { s, c } = data as { s?: unknown; c?: unknown }
  const scenario = Number.isInteger(s) && (s as number) >= 0 && (s as number) < scenarios ? s as number : null
  return { scenario, values: cleanSettings(c) }
}

/** Only the known settings of the right kind from outside data (a link, a saved file), and a whole positive seed. */
export function cleanSettings(data: unknown): Partial<SimConfig> {
  const values: Record<string, unknown> = {}
  if (data && typeof data === 'object') for (const [key, v] of Object.entries(data)) {
    if (Object.hasOwn(KINDS, key) && fits(KINDS[key], v)) values[key] = v
    else if (key === 'seed' && Number.isInteger(v) && (v as number) > 0 && (v as number) < 2 ** 32) values.seed = v
  }
  return values as Partial<SimConfig>
}

/** Rows as CSV with a header line (comma-separated, numbers as they are; for spreadsheets and scripts). */
export function toCsv<T>(rows: readonly T[], columns: readonly [string, (row: T) => number | string][]) {
  const cell = (v: number | string) => typeof v === 'number' ? (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '') : `"${v.replace(/"/g, '""')}"`
  return [columns.map(([name]) => name).join(','), ...rows.map(r => columns.map(([, f]) => cell(f(r))).join(','))].join('\n') + '\n'
}

/** Hands a text file to the browser's download (the user's own click starts it). */
export function download(name: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
