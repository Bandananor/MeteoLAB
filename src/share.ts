// Sharing an experiment and taking its results away: a link that carries every setting (not only the seed), and the
// time series as CSV files. The link is outside input, so decoding accepts only known settings of the right kind.
import { MIN_SOUNDING_TOP, type SimConfig, type SoundingLevel } from './core'

/** The settings a link may carry, with what each may be: a number, one of a few words, a flag, a pair of numbers, a sounding or zones. */
const KINDS: Record<string, 'number' | 'boolean' | 'pair' | 'sounding' | 'zones' | 'front' | 'advection' | 'wk' | readonly string[]> = {
  surfaceTemp: 'number', lapseLow: 'number', lapseMid: 'number', lapseUpper: 'number', tropopause: 'number', stratoWarming: 'number',
  rhSurface: 'number', rhLow: 'number', rhMid: 'number', rhUpper: 'number',
  wind0: 'number', wind05: 'number', wind1: 'number', wind3: 'number', wind6: 'number', wind10: 'number',
  windDir0: 'number', windDir05: 'number', windDir1: 'number', windDir3: 'number', windDir6: 'number', windDir10: 'number',
  capHeight: 'number', capStrength: 'number', moistLayer: 'number', nightInversion: 'number', front: 'number', top: 'number',
  latitude: 'number', turbulence: 'number', hour: 'number', dayOfYear: 'number', solarMax: 'number', soilMoisture: 'number',
  speed: 'number', bubble: 'number', bubbleRadius: 'number', city: 'number',
  surfaceType: ['grass', 'dry', 'water', 'urban'], microphysics: ['warm', 'ice'], transport: ['semi-lagrangian', 'weno'],
  profile: ['weisman-klemp'], domain: ['standard', 'large', 'custom'], domainSize: 'pair', edges: ['periodic', 'relaxed', 'relaxed-x'], start: ['thermals', 'line'],
  followStorm: 'boolean', lightning: 'boolean', frameMotion: 'pair', sounding: 'sounding', zones: 'zones', frontLine: 'front', largeScale: 'advection', weismanKlemp: 'wk',
}
/** Numbers from a link are kept within this magnitude (a slider never goes near it). */
const LIMIT = 1e5

const fits = (kind: (typeof KINDS)[string], v: unknown) => {
  if (kind === 'number') return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= LIMIT
  if (kind === 'boolean') return typeof v === 'boolean'
  if (kind === 'pair') return Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= LIMIT)
  if (kind === 'zones') return validZones(v)
  if (kind === 'front') return validFront(v)
  if (kind === 'advection') return validAdvection(v)
  // The Weisman-Klemp numbers (the regime map's): the vapour cap 5-25 g/kg, the hodograph's radius and 6 km wind up to 80 m/s.
  if (kind === 'wk') return !!v && typeof v === 'object' && Object.entries(v).every(([k, x]) => typeof x === 'number' && (k === 'qvMax' ? x >= .005 && x <= .025 : (k === 'radius' || k === 'u6') && x >= 0 && x <= 80))
  return typeof v === 'string' && kind.includes(v)
}

/** A moving front (SimConfig.frontLine) from outside data: its kind and numbers within the sliders' ranges (a little wider). */
function validFront(v: unknown) {
  if (!v || typeof v !== 'object') return false
  const f = v as Record<string, unknown>, num = (k: string, lo: number, hi: number) => typeof f[k] === 'number' && Number.isFinite(f[k]) && (f[k] as number) >= lo && (f[k] as number) <= hi
  return Object.keys(f).every(k => ['kind', 'contrast', 'depth', 'slope', 'speed', 'heading', 'start'].includes(k)) && (f.kind === 'cold' || f.kind === 'warm')
    && num('contrast', 0, 20) && num('depth', .1, 5) && num('slope', 10, 1000) && num('speed', 0, 40) && num('heading', -360, 720) && num('start', -200, 200)
}

/** Large-scale advection (SimConfig.largeScale) from outside data: at most MAX_CHANGES changes, layers within 0-20 km, ±20 K or g/kg, within 48 h. */
const MAX_CHANGES = 12
function validAdvection(v: unknown) {
  const num = (x: unknown, lo: number, hi: number) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi
  return Array.isArray(v) && v.length <= MAX_CHANGES && v.every(c => c && typeof c === 'object' && Object.keys(c).every(k => ['quantity', 'bottom', 'top', 'amount', 'start', 'hours'].includes(k))
    && (c.quantity === 'temperature' || c.quantity === 'moisture') && num(c.bottom, 0, 20) && num(c.top, 0, 20) && c.top >= c.bottom
    && num(c.amount, -20, 20) && num(c.start, 0, 48) && num(c.hours, 0, 48))
}

/** Zones of the environment (SimConfig.zones) from outside data: at most MAX_ZONES polygons of 3-MAX_CORNERS corners within ±1000 km, differences within ±15 K and ±15 g/kg. */
const MAX_ZONES = 12, MAX_CORNERS = 40
function validZones(v: unknown) {
  const num = (x: unknown, limit: number) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= limit
  return Array.isArray(v) && v.length <= MAX_ZONES && v.every(z => z && typeof z === 'object' && Object.keys(z).every(k => ['points', 'temperature', 'moisture'].includes(k))
    && num(z.temperature, 15) && num(z.moisture, 15) && Array.isArray(z.points) && z.points.length >= 3 && z.points.length <= MAX_CORNERS
    && z.points.every((p: unknown) => Array.isArray(p) && p.length === 2 && p.every(x => num(x, 1000))))
}

/**
 * A loaded sounding (SimConfig.sounding) in a link or a file: its name and levels as rows [z m, p Pa, t, td °C, u, v
 * m/s, qv kg/kg] (null: missing, qv only when the file gave it), rounded so the link stays short (~3-6 KB for a radiosonde).
 */
function packSounding(s: NonNullable<SimConfig['sounding']>) {
  const r = (x: number | null, k: number) => x === null ? null : Math.round(x * k) / k
  return { n: s.name ?? '', l: s.levels.map(l => [Math.round(l.z), Math.round(l.p), r(l.t, 100), r(l.td, 100), r(l.u, 100), r(l.v, 100), ...(l.qv !== undefined ? [r(l.qv, 1e6)] : [])]) }
}
/** Up to this many levels are read back (a radiosonde has 50-200). */
const SOUNDING_LEVELS = 2000
/**
 * A sounding from outside data (a link or a .meteolab file), packed or as stored, or null when anything is off: every
 * number finite and physical, heights rising from 0 and pressures falling, at least 5 levels, up to MIN_SOUNDING_TOP.
 */
function unpackSounding(v: unknown): SimConfig['sounding'] | null {
  if (!v || typeof v !== 'object') return null
  const o = v as { n?: unknown; l?: unknown; name?: unknown; levels?: unknown }, name = o.n ?? o.name, rows = o.l ?? o.levels
  if (!Array.isArray(rows) || rows.length < 5 || rows.length > SOUNDING_LEVELS || (name !== undefined && (typeof name !== 'string' || name.length > 200))) return null
  const num = (x: unknown, lo: number, hi: number) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi
  const opt = (x: unknown, lo: number, hi: number) => x === null || num(x, lo, hi)
  const levels: SoundingLevel[] = []
  for (const row of rows) {
    const [z, p, t, td, u, w, qv] = Array.isArray(row) ? row : row && typeof row === 'object' ? [row.z, row.p, row.t, row.td, row.u, row.v, row.qv] : []
    if (!num(z, 0, 60_000) || !num(p, 100, 110_000) || !num(t, -120, 60) || !opt(td, -150, 60) || !opt(u, -150, 150) || !opt(w, -150, 150) || !(qv === undefined || num(qv, 0, .05))) return null
    const last = levels[levels.length - 1]
    if (last ? !(z > last.z && p < last.p) : z !== 0) return null
    levels.push({ z, p, t, td: td as number | null, u: u as number | null, v: w as number | null, ...(qv !== undefined ? { qv: qv as number } : {}) })
  }
  if (levels[levels.length - 1].z < MIN_SOUNDING_TOP) return null
  return { ...(typeof name === 'string' && name ? { name } : {}), levels }
}

const toBase64Url = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromBase64Url = (text: string) => new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))

/** Numbers to 4 decimals: no float noise like 4.166666666666667 in the link. */
const round = (v: unknown): unknown => typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : Array.isArray(v) ? v.map(round)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v

/**
 * The scenarios in the order the first links (2026-10-10) numbered them; links since carry the scenario's name, so
 * adding or reordering scenarios breaks none. The first «Заряженное ружьё» (removed 2026-10-11) has the key of its
 * retired values: its name now belongs to the new scenario of 2026-10-12.
 */
const NUMBERED = ['Летний день', 'Сухой воздух', 'Сдвиг ветра', 'Микропорыв', 'Заряженное ружьё (2026-10-10)', 'HSLC', 'Жаркий город', 'Суперячейка WK', 'Тропическая конвекция', 'Суточный ход']
/** Renamed scenarios: a link with the old name opens the scenario under its new one. */
const RENAMED: Record<string, string> = { 'Сдвиг ветра': 'Многоячейковая гроза', 'Тёплая адвекция: грозы не будет': 'Тёплый воздух над слоем: гроз не будет' }
const LIGHT_WIND = { wind0: 2, wind3: 5, wind6: 9, wind10: 14, windDir0: 200, windDir3: 230, windDir6: 250, windDir10: 260 }
const SUMMER_AIR = { surfaceTemp: 28, rhSurface: 55, rhLow: 50, rhMid: 45, rhUpper: 30, lapseLow: 9.3, lapseMid: 6.3, lapseUpper: 6.5, capStrength: 1, capHeight: 1.4, moistLayer: 1 }
/**
 * Retired scenarios with their values as they were: a link to one opens the same experiment, its settings laid over
 * these (without a scenario selected). Values copied from src/core/scenarios.ts at the time.
 */
const RETIRED: Record<string, Partial<SimConfig>> = {
  'Сухой воздух': { bubbleRadius: 2.5, ...SUMMER_AIR, ...LIGHT_WIND, surfaceTemp: 25.5, rhLow: 35, rhMid: 15, rhUpper: 10 },
  'Жаркий город': { bubbleRadius: 2.5, ...SUMMER_AIR, ...LIGHT_WIND, surfaceTemp: 29, rhSurface: 45, rhLow: 45, lapseLow: 9.5, surfaceType: 'urban', soilMoisture: 15, solarMax: 1100 },
  'Заряженное ружьё (2026-10-10)': { surfaceTemp: 30, rhSurface: 50, rhLow: 25, rhMid: 35, rhUpper: 30, lapseLow: 9.6, lapseMid: 6.8, lapseUpper: 6.5, capStrength: 3, capHeight: 1, bubble: 0,
    wind0: 6, wind3: 15, wind6: 22, wind10: 28, windDir0: 170, windDir3: 220, windDir6: 245, windDir10: 255 },
}

/** The settings that differ from `base` (the defaults with the scenario laid over), with the scenario's name, as a URL-safe string. */
export function encodeSettings(config: SimConfig, base: SimConfig, scenario: string | null) {
  const values: Record<string, unknown> = {}
  for (const key of Object.keys(KINDS)) {
    if (key === 'sounding') { if (config.sounding && JSON.stringify(config.sounding) !== JSON.stringify(base.sounding)) values.sounding = packSounding(config.sounding); continue }
    const v = round((config as unknown as Record<string, unknown>)[key]), b = round((base as unknown as Record<string, unknown>)[key])
    if (v !== undefined && JSON.stringify(v) !== JSON.stringify(b)) values[key] = v
  }
  return toBase64Url(JSON.stringify(scenario === null ? { c: values } : { n: scenario, c: values }))
}

/**
 * Reads a link's settings back, with the index of its scenario in `names` (null if there is none or it no longer
 * exists; a retired scenario's values come with the link's own); anything unknown or of the wrong kind is dropped, a
 * broken string gives null.
 */
export function decodeSettings(text: string, names: readonly string[]): { scenario: number | null; values: Partial<SimConfig> } | null {
  let data: unknown
  try { data = JSON.parse(fromBase64Url(text)) } catch { return null }
  if (!data || typeof data !== 'object') return null
  const { n, s, c } = data as { n?: unknown; s?: unknown; c?: unknown }
  const old = typeof n === 'string' ? n : Number.isInteger(s) ? NUMBERED[s as number] : undefined, name = old === undefined ? undefined : RENAMED[old] ?? old
  const index = name === undefined ? -1 : names.indexOf(name), retired = index < 0 && name !== undefined && Object.hasOwn(RETIRED, name) ? RETIRED[name] : {}
  return { scenario: index < 0 ? null : index, values: { ...retired, ...cleanSettings(c) } }
}

/** Only the known settings of the right kind from outside data (a link, a saved file), and a whole positive seed. */
export function cleanSettings(data: unknown): Partial<SimConfig> {
  const values: Record<string, unknown> = {}
  if (data && typeof data === 'object') for (const [key, v] of Object.entries(data)) {
    if (key === 'sounding') { const s = unpackSounding(v); if (s) values.sounding = s }
    else if (Object.hasOwn(KINDS, key) && fits(KINDS[key], v)) values[key] = v
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
