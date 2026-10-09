// Data for the Skew-T log-p diagram (src/skewt/panel.ts): the environment by pressure, a column of the running model,
// the standard parcels as temperature-pressure paths with their indices, and the background lines (dry and moist
// adiabats, saturation mixing ratio).
import { EPS, G, KAPPA } from './constants'
import type { Environment } from './environment'
import type { Grid } from './grid'
import { qsatP } from './microphysics'
import { heightOf, liftParcel, moistStep, type ParcelKind } from './sounding'

/** One level: pressure (hPa), height (km), temperature and dewpoint (°C), ground-relative wind (m/s). */
export interface SkewLevel { p: number; z: number; t: number; td: number; u: number; v: number }

/** Dewpoint (°C) of air with mixing ratio q at pressure p (Pa), Magnus over water (as Environment.dewpoint). */
export function dewpointAt(q: number, p: number) { const e = Math.max(1, q * p / (EPS + q)), l = Math.log(e / 611.2); return 243.5 * l / (17.67 - l) }

/** The environment every `step` hPa from the ground up to 100 hPa (or the top of the domain). */
export function environmentLevels(env: Environment, height: number, step = 10): SkewLevel[] {
  const levels: SkewLevel[] = [], p0 = env.pressureAt(0) / 100
  for (let p = p0; p >= Math.max(100, env.pressureAt(height) / 100); p = (Math.ceil(p / step) - 1) * step) {
    const z = p === p0 ? 0 : heightOf(env, p * 100, height), [u, v] = env.windUV(z), q = env.qEnv(z)
    levels.push({ p, z: z / 1000, t: env.temperatureEnv(z), td: dewpointAt(q, env.pressureAt(z)), u, v })
  }
  return levels
}

/** What a column of the running model needs: potential temperature, vapour and the domain-relative wind. */
export interface ColumnSource { grid: Grid; env: Environment; theta: ArrayLike<number>; q: ArrayLike<number>; u: ArrayLike<number>; v: ArrayLike<number>; frame: readonly [number, number] }

/**
 * The model column at node (x, y), at its own levels: a virtual radiosonde of the current state (temperature from theta
 * with the base-state pressure, the anelastic model's reference; ground-relative wind).
 */
export function columnLevels(m: ColumnSource, x: number, y: number): SkewLevel[] {
  const { nx, layer, nz, zs } = m.grid, levels: SkewLevel[] = []
  for (let k = 0; k < nz; k++) {
    const i = x + y * nx + k * layer, p = m.env.pressureAt(zs[k])
    if (p < 10000) break
    levels.push({ p: p / 100, z: zs[k] / 1000, t: m.theta[i] * (p / 100000) ** KAPPA - 273.15, td: dewpointAt(Math.max(1e-6, m.q[i]), p), u: m.u[i] + m.frame[0], v: m.v[i] + m.frame[1] })
  }
  return levels
}

/** A lifted standard parcel as a path in pressure (hPa) with its indices; heights of the levels in km, pressures in hPa. */
export interface ParcelPath {
  kind: ParcelKind; path: { p: number; t: number; tEnv: number }[]
  cape: number; cin: number; start: number
  lcl: number | null; lfc: number | null; el: number | null
  pLcl: number | null; pLfc: number | null; pEl: number | null
  /** Lifted index: environment minus parcel temperature at 500 hPa, K (negative: unstable). */
  li: number | null
}

export function parcelPath(env: Environment, height: number, kind: ParcelKind): ParcelPath {
  const a = liftParcel(env, height, kind), pAt = (z: number | null) => z === null ? null : env.pressureAt(z * 1000) / 100
  // Every 100 m is plenty for drawing (the ascent itself steps 25 m).
  const path = a.profile.filter((_, k) => k % 4 === 0).map(pt => ({ p: env.pressureAt(pt.z * 1000) / 100, t: pt.parcel, tEnv: pt.env }))
  let li: number | null = null
  for (let k = 1; k < a.profile.length; k++) {
    const lo = a.profile[k - 1], hi = a.profile[k], pLo = env.pressureAt(lo.z * 1000) / 100, pHi = env.pressureAt(hi.z * 1000) / 100
    if (pLo >= 500 && pHi < 500) { const f = Math.log(pLo / 500) / Math.log(pLo / pHi); li = (lo.env + (hi.env - lo.env) * f) - (lo.parcel + (hi.parcel - lo.parcel) * f); break }
  }
  return { kind, path, cape: a.cape, cin: a.cin, start: a.start, lcl: a.lcl, lfc: a.lfc, el: a.el, pLcl: pAt(a.lcl), pLfc: pAt(a.lfc), pEl: pAt(a.el), li }
}

/** Temperature (°C) on the dry adiabat of potential temperature theta (K) at pressure p (hPa). */
export function dryAdiabat(theta: number, p: number) { return theta * (p / 1000) ** KAPPA - 273.15 }

/**
 * A pseudo-adiabat through (t0 °C, 1000 hPa), from p1 (hPa, may be below 1000) up to 100 hPa: points every 10 hPa.
 * Uses the same step as the parcels, so the lines and the parcel paths agree.
 */
export function moistAdiabat(t0: number, p1 = 1050): { p: number; t: number }[] {
  const env = { qsatP } as unknown as Environment, points: { p: number; t: number }[] = []
  // Down from 1000 hPa to p1 first, then up.
  let t = t0
  for (let p = 1000; p < p1; p += 10) t = moistStep(env, t, p * 100, Math.min(p + 10, p1) * 100)
  for (let p = p1; p >= 100; p -= 10) { points.push({ p, t }); t = moistStep(env, t, p * 100, (p - 10) * 100) }
  return points
}

/** Temperature (°C) at which the saturation mixing ratio is r (kg/kg) at pressure p (hPa). */
export function mixingRatioTemperature(r: number, p: number) { return dewpointAt(r, p * 100) }

/** Summary numbers of the environment for the side panel. */
export interface SkewIndices {
  /** Precipitable water, mm. */ pw: number
  /** Lapse rates, K/km: 0-3 km and 700-500 hPa. */ lapse03: number; lapse75: number
  /** Height of the 0 °C level, km (null: none below the top). */ freezing: number | null
  /** Bulk wind difference 0-6 km, m/s. */ shear06: number
}

export function skewIndices(env: Environment, height: number): SkewIndices {
  let pw = 0, freezing: number | null = null
  for (let z = 0; z < height; z += 50) {
    const p0 = env.pressureAt(z), p1 = env.pressureAt(z + 50)
    pw += env.qEnv(z + 25) * (p0 - p1) / G
    if (freezing === null && env.temperatureEnv(z) <= 0) freezing = z / 1000
  }
  const z7 = heightOf(env, 70000, height), z5 = heightOf(env, 50000, height)
  const [u0, v0] = env.windUV(0), [u6, v6] = env.windUV(6000)
  return {
    pw, freezing, shear06: Math.hypot(u6 - u0, v6 - v0),
    lapse03: (env.temperatureEnv(0) - env.temperatureEnv(3000)) / 3,
    lapse75: (env.temperatureEnv(z7) - env.temperatureEnv(z5)) / ((z5 - z7) / 1000),
  }
}

