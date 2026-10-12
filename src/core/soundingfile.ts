import { CP, EPS, G, KAPPA, RD } from './constants'
import type { EnvironmentProfile } from './environment'
import { qsatP } from './microphysics'

// Real soundings from text files (roadmap 2.2): the formats meteorologists and modellers pass around, read into one
// list of levels from the ground up. Supported: the University of Wyoming's TEXT:LIST (also with its HTML around it),
// SHARPpy / SPC (%RAW%), the input_sounding of CM1 and WRF (surface pressure, theta and vapour, then z, theta, vapour,
// u, v) and a CSV with a header row. Only reading and checking here; the model's environment is built from the levels
// elsewhere.

export type SoundingFormat = 'wyoming' | 'sharppy' | 'input_sounding' | 'csv'

/** One level: pressure (Pa), height above the station (m), temperature and dew point (°C; the dew point may be missing), wind (m/s, may be missing), and the vapour mixing ratio when the file gives it (kg/kg). */
export interface SoundingLevel { p: number; z: number; t: number; td: number | null; u: number | null; v: number | null; qv?: number }

export interface SoundingFile {
  format: SoundingFormat
  /** Station identifier and name, time, latitude (°) and elevation (m) — whatever the file says. */
  station?: string; time?: string; latitude?: number; elevation?: number
  /** From the ground (z = 0) up, heights increasing, pressures decreasing. */
  levels: SoundingLevel[]
  /** What was done to the data, in words for the user (levels below ground dropped, knots converted, …). */
  notes: string[]
}

/** A file that cannot be read, with a message for the user. */
export class SoundingError extends Error {}

const KNOT = .514444
const MISSING = (v: number) => !Number.isFinite(v) || v <= -9998 || v === 9999 || v === 99999
/** Wind components (m/s) from the direction it blows from (°) and its speed (m/s). */
const windUV = (dir: number, speed: number) => { const a = dir * Math.PI / 180; return [-speed * Math.sin(a), -speed * Math.cos(a)] as const }
/** Dew point (°C) of vapour pressure e (Pa): the inverse of the model's own saturation formula (qsatP). */
const dewFromE = (e: number) => { const l = Math.log(Math.max(e, 1e-3) / 611.2); return 243.5 * l / (17.67 - l) }
const dewFromQ = (q: number, p: number) => dewFromE(q * p / (EPS + q))
const dewFromRh = (t: number, rh: number) => dewFromE(611.2 * Math.exp(17.67 * t / (t + 243.5)) * Math.max(rh, .1) / 100)

/** Reads a sounding in any supported format (detected from the text). */
export function parseSounding(text: string): SoundingFile {
  const clean = stripHtml(text)
  const format = detect(clean)
  const raw = format === 'wyoming' ? wyoming(clean) : format === 'sharppy' ? sharppy(clean) : format === 'input_sounding' ? inputSounding(clean) : csv(clean)
  return finish(raw)
}

/** The format of a sounding text, or an error saying which ones are understood. */
export function detect(text: string): SoundingFormat {
  if (/%RAW%/i.test(text)) return 'sharppy'
  if (/^\s*PRES\s+HGHT\s+TEMP/m.test(text)) return 'wyoming'
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  if (lines.length > 2 && /[A-Za-zА-Яа-я]/.test(lines[0]) && /[,;\t]/.test(lines[0])) return 'csv'
  const numbers = (l: string) => l.split(/\s+/).map(Number)
  if (lines.length > 2 && numbers(lines[0]).length === 3 && numbers(lines[0]).every(Number.isFinite) && numbers(lines[1]).length === 5 && numbers(lines[1]).every(Number.isFinite)) return 'input_sounding'
  throw new SoundingError('Не удалось узнать формат. Понимаю: текст Вайомингского университета (TEXT:LIST, столбцы PRES HGHT TEMP …), SHARPpy (%RAW%), input_sounding CM1/WRF и CSV со строкой заголовков.')
}

/** The text of an HTML page (the Wyoming site sends the table in <pre>). */
function stripHtml(text: string) {
  if (!/<\s*(pre|html|body|h2)\b/i.test(text)) return text
  return text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(h\d|p|pre|tr)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** A level as read: pressure hPa, height m (above sea level, or above ground with `agl`), °C, wind m/s. */
interface Raw { p: number; z: number; t: number; td: number | null; u: number | null; v: number | null; qv?: number }
interface Read { format: SoundingFormat; levels: Raw[]; agl: boolean; notes: string[]; station?: string; time?: string; latitude?: number; elevation?: number }

/** University of Wyoming TEXT:LIST: fixed 7-character columns PRES HGHT TEMP DWPT RELH MIXR DRCT SKNT …, blanks = missing. */
function wyoming(text: string): Read {
  const lines = text.split(/\r?\n/), notes: string[] = []
  const head = lines.findIndex(l => /^\s*PRES\s+HGHT\s+TEMP/.test(l)), names = lines[head].trim().split(/\s+/)
  const col = (name: string) => names.indexOf(name)
  const [cp, cz, ct, cd, cr, cdir, csp] = ['PRES', 'HGHT', 'TEMP', 'DWPT', 'RELH', 'DRCT', 'SKNT'].map(col)
  const levels: Raw[] = []
  for (const line of lines.slice(head + 1)) {
    if (/^\s*-{5,}/.test(line) || /^\s*hPa/.test(line)) continue
    if (!/^\s*\d/.test(line)) { if (levels.length) break; continue }
    // Fixed width: field k is characters 7k..7k+7; a blank field is missing.
    const field = (k: number) => { if (k < 0) return NaN; const s = line.slice(7 * k, 7 * k + 7).trim(); return s ? Number(s) : NaN }
    const p = field(cp), z = field(cz), t = field(ct)
    if (!Number.isFinite(p) || !Number.isFinite(z)) continue
    const td = field(cd), rh = field(cr), dir = field(cdir), sp = field(csp)
    const [u, v] = Number.isFinite(dir) && Number.isFinite(sp) ? windUV(dir, sp * KNOT) : [null, null]
    levels.push({ p, z, t, td: Number.isFinite(td) ? td : Number.isFinite(rh) && Number.isFinite(t) ? dewFromRh(t, rh) : null, u, v })
  }
  notes.push('Ветер переведён из узлов в м/с')
  // The title and the station block of a full page.
  const title = /^\s*(\d{5})\s+(\S+.*?)\s+Observations at\s+(.+?)\s*$/m.exec(text)
  const lat = /Station latitude:\s*(-?[\d.]+)/.exec(text), elev = /Station elevation:\s*(-?[\d.]+)/.exec(text)
  return { format: 'wyoming', levels, agl: false, notes, station: title ? `${title[1]} ${title[2]}` : undefined, time: title?.[3], latitude: lat ? Number(lat[1]) : undefined, elevation: elev ? Number(elev[1]) : undefined }
}

/** SHARPpy / SPC: %RAW% then "PRES, HGHT, TEMP, DWPT, WDIR, WSPD" per line (wind in knots), -9999 = missing, %END%. */
function sharppy(text: string): Read {
  const lines = text.split(/\r?\n/), start = lines.findIndex(l => /%RAW%/i.test(l)), levels: Raw[] = []
  for (const line of lines.slice(start + 1)) {
    if (/%END%/i.test(line)) break
    const n = line.split(',').map(s => Number(s.trim()))
    if (n.length < 6 || MISSING(n[0]) || MISSING(n[1])) continue
    const [u, v] = !MISSING(n[4]) && !MISSING(n[5]) ? windUV(n[4], n[5] * KNOT) : [null, null]
    levels.push({ p: n[0], z: n[1], t: MISSING(n[2]) ? NaN : n[2], td: MISSING(n[3]) ? null : n[3], u, v })
  }
  const title = lines.slice(lines.findIndex(l => /%TITLE%/i.test(l)) + 1).find(l => l.trim())?.trim().split(/\s+/)
  return { format: 'sharppy', levels, agl: false, notes: ['Ветер переведён из узлов в м/с'], station: title?.[0], time: title?.[1] }
}

/**
 * input_sounding of CM1 and WRF: "surface pressure (hPa), surface theta (K), surface vapour (g/kg)", then per line
 * "height above ground (m), theta (K), vapour (g/kg), u, v (m/s)". Pressure is integrated hydrostatically from the
 * surface (dpi/dz = -g / (cp theta_v), pi the Exner function), as CM1 itself does.
 */
function inputSounding(text: string): Read {
  const rows = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.split(/\s+/).map(Number))
  const [ps, ths, qs] = rows[0], levels: Raw[] = []
  const thetaV = (th: number, q: number) => th * (1 + .61 * q)
  let z0 = 0, pi0 = (ps * 100 / 1e5) ** KAPPA, thv0 = thetaV(ths, qs / 1000)
  levels.push({ p: ps, z: 0, t: ths * pi0 - 273.15, td: dewFromQ(qs / 1000, ps * 100), u: null, v: null, qv: qs / 1000 })
  for (const r of rows.slice(1)) {
    if (r.length < 5 || r.some(x => !Number.isFinite(x))) continue
    const [z, th, q, u, v] = r, thv = thetaV(th, q / 1000)
    const pi = pi0 - G / CP * (z - z0) * 2 / (thv0 + thv), p = 1e5 * pi ** (1 / KAPPA)
    levels.push({ p: p / 100, z, t: th * pi - 273.15, td: dewFromQ(q / 1000, p), u, v, qv: q / 1000 })
    z0 = z; pi0 = pi; thv0 = thv
  }
  // The surface line has no wind: the lowest level's.
  if (levels.length > 1) { levels[0].u = levels[1].u; levels[0].v = levels[1].v }
  return { format: 'input_sounding', levels, agl: true, notes: ['Давление посчитано по гидростатике от давления у земли (как в CM1)', 'Температура и точка росы — из θ и q_v'] }
}

/** CSV with a header: columns found by their names (pressure, height, temperature, dew point or humidity, wind as direction and speed or as u and v). */
function csv(text: string): Read {
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#')), sep = [';', '\t', ','].find(s => lines[0].includes(s))!
  const header = lines[0].split(sep).map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''))
  const find = (...names: RegExp[]) => header.findIndex(h => names.some(n => n.test(h)))
  const cp = find(/^(pres|pressure|press|p)\b/), cz = find(/^(hght|height|hgt|alt|altitude|z|geopot)/), ct = find(/^(temp|temperature|t)\b/)
  const cd = find(/^(dwpt|dewpoint|dew|td)\b/), cr = find(/^(relh|rh|humidity)\b/), cdir = find(/^(drct|wdir|dir|direction)\b/)
  const csp = find(/^(sknt|wspd|speed|ws|wind)\b/), cu = find(/^u\b/), cv = find(/^v\b/)
  if (ct < 0 || (cp < 0 && cz < 0)) throw new SoundingError('В CSV нужны температура и давление или высота: столбцы вроде pres, hght, temp, dwpt (или rh), drct и sknt (или u, v).')
  const knots = csp >= 0 && /sknt|kt|knot|узл/.test(header[csp]), notes: string[] = []
  if (knots) notes.push('Ветер переведён из узлов в м/с')
  const levels: Raw[] = []
  for (const line of lines.slice(1)) {
    const n = line.split(sep).map(s => Number(s.trim().replace(',', '.')))
    const at = (k: number) => k < 0 || MISSING(n[k]) ? NaN : n[k]
    const t0 = at(ct), t = t0 > 150 ? t0 - 273.15 : t0, td0 = at(cd), td = Number.isFinite(td0) ? (td0 > 150 ? td0 - 273.15 : td0) : Number.isFinite(at(cr)) && Number.isFinite(t) ? dewFromRh(t, at(cr)) : null
    let u: number | null = null, v: number | null = null
    if (Number.isFinite(at(cu)) && Number.isFinite(at(cv))) { u = at(cu); v = at(cv) } else if (Number.isFinite(at(cdir)) && Number.isFinite(at(csp))) [u, v] = windUV(at(cdir), at(csp) * (knots ? KNOT : 1))
    levels.push({ p: at(cp), z: at(cz), t, td, u, v })
  }
  // Only pressure: heights from the hydrostatic equation; only heights: pressure from 1013.25 hPa at the first level.
  if (cz < 0) { fillHeights(levels); notes.push('Высоты посчитаны по гидростатике (в файле только давление)') }
  if (cp < 0) { fillPressures(levels); notes.push('Давление посчитано по гидростатике от 1013,25 гПа у земли (в файле только высоты)') }
  return { format: 'csv', levels, agl: false, notes }
}

/** Virtual temperature, K. */
const tv = (l: Raw) => (l.t + 273.15) * (1 + .61 * (l.td === null ? 0 : EPS * 611.2 * Math.exp(17.67 * l.td / (l.td + 243.5)) / (l.p * 100)))
function fillHeights(levels: Raw[]) {
  levels.sort((a, b) => b.p - a.p)
  levels.forEach((l, k) => { l.z = k === 0 ? 0 : levels[k - 1].z + RD * (tv(l) + tv(levels[k - 1])) / 2 / G * Math.log(levels[k - 1].p / l.p) })
}
function fillPressures(levels: Raw[]) {
  levels.sort((a, b) => a.z - b.z)
  // The level's own pressure is needed for its vapour (virtual temperature): first the one below, then the result.
  levels.forEach((l, k) => {
    if (k === 0) { l.p = 1013.25; return }
    const below = levels[k - 1], step = () => below.p * Math.exp(-G * (l.z - below.z) / (RD * (tv(l) + tv(below)) / 2))
    l.p = below.p; l.p = step(); l.p = step()
  })
}

/**
 * Common checks: levels without temperature are dropped, heights become heights above the station (the lowest level
 * with a temperature), levels below it and out-of-order ones are dropped, pressure goes to Pa.
 */
function finish(r: Read): SoundingFile {
  const notes = [...r.notes]
  const valid = r.levels.filter(l => Number.isFinite(l.t) && Number.isFinite(l.p) && Number.isFinite(l.z))
  if (valid.length < r.levels.length) notes.push(`Пропущено уровней без температуры: ${r.levels.length - valid.length}`)
  valid.sort((a, b) => a.z - b.z)
  if (valid.length < 5) throw new SoundingError(`В файле всего ${valid.length} уровней с температурой — для профиля мало (нужно хотя бы 5).`)
  const ground = valid[0].z, levels: SoundingLevel[] = []
  for (const l of valid) {
    const last = levels[levels.length - 1]
    if (last && (l.z - ground <= last.z || l.p * 100 >= last.p)) continue
    levels.push({ p: l.p * 100, z: l.z - ground, t: l.t, td: l.td, u: l.u, v: l.v, ...(l.qv !== undefined ? { qv: l.qv } : {}) })
  }
  if (levels.length < valid.length) notes.push(`Пропущено уровней не по порядку (высота не растёт или давление не падает): ${valid.length - levels.length}`)
  const missingDew = levels.filter(l => l.td === null).length, missingWind = levels.filter(l => l.u === null).length
  if (missingDew) notes.push(`Уровней без точки росы: ${missingDew} — влажность там берётся с соседних`)
  if (missingWind) notes.push(`Уровней без ветра: ${missingWind} — ветер там интерполируется`)
  return { format: r.format, station: r.station, time: r.time, latitude: r.latitude, elevation: r.agl ? r.elevation : r.elevation ?? ground, levels, notes }
}

/** A sounding needs to reach this height to make an environment, m: the storm's top and the tropopause must be in the data. */
export const MIN_SOUNDING_TOP = 10_000

/** The environment of a sounding and what was done to its data. */
export interface SoundingProfile { profile: EnvironmentProfile; notes: string[]; top: number }

/**
 * The model's environment from a sounding (roadmap 2.2): potential temperature, vapour and wind linear in height
 * between the levels, the station's pressure at the ground (the model integrates its own hydrostatic pressure from it).
 * Vapour: the file's own, or saturation at the dew point (the model's formula, so the dew point comes back exactly);
 * levels without a dew point get the relative humidity interpolated from their neighbours, above the last one its value.
 * Above the top of the data, up to `height`, the temperature goes on with the lapse rate of the top 2 km (bounded: no
 * steeper than 7 K/km, warming at most 3 K/km, not below -80 °C). Layers where the virtual potential temperature falls
 * with height (the air would overturn by itself) are warmed to neutral, as the slider profiles are (Environment.neutralise),
 * and reported. Throws a SoundingError below MIN_SOUNDING_TOP.
 */
export function soundingProfile(file: Pick<SoundingFile, 'levels'>, height: number): SoundingProfile {
  const L = file.levels, n = L.length, notes: string[] = [], top = L[n - 1].z
  if (top < MIN_SOUNDING_TOP) throw new SoundingError(`Зондирование заканчивается на ${(top / 1000).toFixed(1).replace('.', ',')} км — модели нужны данные хотя бы до ${MIN_SOUNDING_TOP / 1000} км (вершина грозы и тропопауза).`)
  const z = L.map(l => l.z), p = L.map(l => l.p), t = L.map(l => l.t + 273.15)
  // Relative humidity where the file has vapour or a dew point, interpolated over the gaps, held above the last one.
  const rh = fillGaps(L.map(l => l.qv !== undefined ? l.qv / qsatP(l.t, l.p) : l.td !== null ? qsatP(l.td, l.p) / qsatP(l.t, l.p) : null), z)
  const qv = L.map((l, k) => l.qv ?? Math.min(1, rh[k]) * qsatP(l.t, l.p))
  const u = fillGaps(L.map(l => l.u), z), v = fillGaps(L.map(l => l.v), z)
  // Above the data: the top 2 km's lapse rate, bounded, hydrostatic pressure, the last humidity and wind.
  if (top < height) {
    const below = z.findIndex(h => h >= top - 2000), lapse = Math.max(-3e-3, Math.min(7e-3, (t[below] - t[n - 1]) / Math.max(1, top - z[below])))
    for (let h = top + 250; h <= height + 250; h += 250) {
      const k = z.length - 1, tk = Math.max(193.15, t[k] - lapse * 250), pk = p[k] * Math.exp(-G * 250 / (RD * (t[k] + tk) / 2))
      z.push(h); t.push(tk); p.push(pk); qv.push(Math.min(qv[k], rh[n - 1] * qsatP(tk - 273.15, pk))); u.push(u[k]); v.push(v[k])
    }
    notes.push(`Выше ${(top / 1000).toFixed(1).replace('.', ',')} км данных нет: температура продолжена с градиентом верхних 2 км (${(lapse * 1000).toFixed(1).replace('.', ',')} K/км), ветер и влажность — как на верхнем уровне`)
  }
  const theta = t.map((tk, k) => tk * (1e5 / p[k]) ** KAPPA)
  // Dry convective adjustment in virtual potential temperature, from the ground up.
  let level = theta[0] * (1 + .61 * qv[0]), fixed = 0, worst = 0, where = 0
  for (let k = 1; k < theta.length; k++) {
    const moist = 1 + .61 * qv[k], thv = theta[k] * moist
    if (thv < level - 1e-9) { const warm = level / moist - theta[k]; theta[k] += warm; fixed++; if (warm > worst) { worst = warm; where = z[k] } }
    level = Math.max(level, theta[k] * moist)
  }
  if (fixed) notes.push(`Неустойчивых уровней (воздух перевернулся бы сам): ${fixed}, прогреты до нейтральных; наибольшая поправка ${worst.toFixed(1).replace('.', ',')} K на ${(where / 1000).toFixed(1).replace('.', ',')} км`)
  const at = (f: number[], h: number) => {
    if (h <= z[0]) return f[0]
    if (h >= z[z.length - 1]) return f[f.length - 1]
    let lo = 0, hi = z.length - 1
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (z[mid] <= h) lo = mid; else hi = mid }
    return f[lo] + (f[hi] - f[lo]) * (h - z[lo]) / (z[hi] - z[lo])
  }
  const lnp = p.map(Math.log)
  return {
    top, notes,
    profile: {
      theta: h => at(theta, h), qv: h => at(qv, h), wind: h => [at(u, h), at(v, h)], surfacePressure: p[0],
      // Only for completeness (qv wins): the relative humidity at the sounding's own pressure.
      rh: h => { const ph = Math.exp(at(lnp, h)); return at(qv, h) / qsatP(at(theta, h) * (ph / 1e5) ** KAPPA - 273.15, ph) },
    },
  }
}

/** Linear interpolation in height over the missing values (null); before the first and after the last known, the nearest. */
function fillGaps(f: (number | null)[], z: number[]): number[] {
  const known = f.flatMap((x, k) => x === null ? [] : [k])
  if (!known.length) return f.map(() => 0)
  return f.map((x, k) => {
    if (x !== null) return x
    const after = known.find(j => j > k), before = [...known].reverse().find(j => j < k)
    if (before === undefined) return f[after!]!
    if (after === undefined) return f[before]!
    return f[before]! + (f[after]! - f[before]!) * (z[k] - z[before]) / (z[after] - z[before])
  })
}
