import type { SimConfig } from './config'
import { CP, EPS, G, KAPPA, LV, RD } from './constants'
import type { Environment } from './environment'
import { lerp } from './math'

export interface ParcelPoint { z: number; env: number; dew: number; parcel: number; buoyancy: number }
export interface WindPoint { z: number; u: number; v: number }
export interface Sounding {
  profile: ParcelPoint[]; wind: WindPoint[]
  cape: number; cin: number; lcl: number | null; lfc: number | null; el: number | null; freezing: number | null
}

/** Fraction of the parcel replaced by environmental air per 100 m of ascent in the diagnostic (entraining) parcel. */
export const PARCEL_ENTRAINMENT = .0039

export interface ParcelOptions {
  /** Surface parcel temperature excess, K. */ excess?: number
  /** Mix the parcel with the environment at PARCEL_ENTRAINMENT. */ entrain?: boolean
}

interface Ascent { profile: ParcelPoint[]; cape: number; cin: number; lcl: number | null; lfc: number | null; el: number | null }

// Lifts a parcel from height z0 (m) with temperature temp (°C) and mixing ratio q through the environment, 25 m steps.
// `mix` is the fraction replaced by environmental air per step; below `countFrom` buoyancy is not integrated (the
// mixed-layer parcel replaces its own layer, as in MetPy).
function ascend(env: Environment, height: number, z0: number, temp: number, q: number, mix: number, countFrom = z0): Ascent {
  // 25 m: the switch to the moist adiabat happens at the first saturated level, so a coarse step shifts the LCL.
  const profile: ParcelPoint[] = [], dz = 25
  let saturated = false, lcl: number | null = null, lfc: number | null = null, el: number | null = null, cape = 0, cin = 0
  for (let z = z0; z <= height; z += dz) {
    const sat = env.qsat(temp, z)
    if (q >= sat) { saturated = true; q = sat; if (lcl === null) lcl = z / 1000 }
    const tv = (temp + 273.15) * (1 + .61 * q), envT = env.temperatureEnv(z), envTv = (envT + 273.15) * (1 + .61 * env.qEnv(z)), b = G * (tv - envTv) / envTv
    if (z >= countFrom) {
      // MetPy joins the mixed-layer parcel at the ground (buoyancy 0 by construction) straight to the layer top:
      // the skipped layer contributes a trapezoid.
      if (z - dz < countFrom && countFrom > z0) { if (b < 0) cin += -b * (z - z0) / 2; else if (lcl !== null) cape += b * (z - z0) / 2 }
      if (lcl !== null && lfc === null && b > 0) lfc = z / 1000
      if (lfc !== null && el === null && b <= 0 && z / 1000 > lfc + .2) el = z / 1000
      if (lfc === null && b < 0) cin += -b * dz
      if (lfc !== null && el === null && b > 0) cape += b * dz
    }
    profile.push({ z: z / 1000, env: envT, dew: env.dewpoint(env.qEnv(z), z), parcel: temp, buoyancy: b })
    // The parcel follows the environment's pressure: dry adiabat (theta conserved) below the LCL, pseudo-adiabat
    // dT/dp above it. Height-based lapse rates assume T_parcel = T_env and made the parcel too warm aloft.
    const p0 = env.pressureAt(z), p1 = env.pressureAt(z + dz)
    temp = saturated ? moistStep(env, temp, p0, p1) : (temp + 273.15) * (p1 / p0) ** KAPPA - 273.15
    temp = lerp(temp, env.temperatureEnv(z + dz), mix); q = lerp(q, env.qEnv(z + dz), mix)
  }
  return { profile, cape, cin, lcl, lfc, el }
}

/** One pseudo-adiabatic step of a saturated parcel from pressure p0 to p1 (either direction), midpoint rule. */
function moistStep(env: Environment, temp: number, p0: number, p1: number) {
  const dTdp = (t: number, p: number) => { const tk = t + 273.15, rs = env.qsatP(t, p); return (RD * tk + LV * rs) / (CP + LV * LV * rs * EPS / (RD * tk * tk)) / p }
  const mid = temp + dTdp(temp, p0) * (p1 - p0) / 2
  return temp + dTdp(mid, (p0 + p1) / 2) * (p1 - p0)
}

/**
 * Parcel ascent from the surface (heights in km), plus the wind profile and the 0 °C level of the environment.
 * Defaults reproduce the app's diagnostic parcel; `{ excess: 0, entrain: false }` is the standard surface-based parcel.
 */
export function computeSounding(_config: SimConfig, env: Environment, height: number, { excess = .5, entrain = true }: ParcelOptions = {}): Sounding {
  const temp = env.temperatureEnv(0) + excess, q = env.mixingRatio(0, temp, env.pressureAt(0))
  // Entrainment is a rate per 100 m (as it was with the old 100 m step), scaled to the 25 m step.
  const { profile, cape, cin, lcl, lfc, el } = ascend(env, height, 0, temp, q, entrain ? PARCEL_ENTRAINMENT * 25 / 100 : 0)
  const wind: WindPoint[] = []
  for (let z = 0; z <= 10_000; z += 250) { const [u, v] = env.windUV(z); wind.push({ z: z / 1000, u, v }) }
  let freezing: number | null = null
  for (let z = 0; z <= height; z += 25) if (env.temperatureEnv(z) <= 0) { freezing = z / 1000; break }
  return { profile, wind, cape, cin, lcl, lfc, el, freezing }
}

export interface ParcelIndex { cape: number; cin: number; lcl: number | null; lfc: number | null; el: number | null }
export interface ParcelIndices {
  /** Surface-based parcel. */ sb: ParcelIndex
  /** Mixed-layer parcel: theta and q averaged over the lowest 100 hPa, lifted from the ground. */ ml: ParcelIndex
  /** Most-unstable parcel (highest theta-e in the lowest 300 hPa); `start` is its height, km. */ mu: ParcelIndex & { start: number }
  /** Downdraft CAPE, J/kg: the lowest theta-e parcel between 700 and 500 hPa lowered moist-adiabatically from its wet-bulb temperature. */
  dcape: number
}

/** Height (m) where the environment's pressure falls to p, 10 m resolution. */
function heightOf(env: Environment, p: number, top: number) { let z = 0; while (z < top && env.pressureAt(z) > p) z += 10; return z }

/** Equivalent potential temperature (Bolton 1980), K; t in °C, q mixing ratio, p in Pa. */
export function thetaE(t: number, q: number, p: number) {
  const tk = t + 273.15, e = Math.max(1e-3, q * p / (EPS + q)) / 100, tl = 2840 / (3.5 * Math.log(tk) - Math.log(e) - 4.805) + 55, r = q * 1000
  return tk * (100000 / p) ** (.2854 * (1 - .00028 * r)) * Math.exp((3.376 / tl - .00254) * r * (1 + .00081 * r))
}

/** Wet-bulb temperature, °C: adiabatic saturation T - Tw = L/cp (q_s(Tw) - q), by bisection. */
function wetBulb(env: Environment, t: number, q: number, p: number) {
  let lo = t - 40, hi = t
  // t - Tw - L/cp (q_s(Tw) - q) falls as Tw rises: positive means the root lies above.
  for (let k = 0; k < 50; k++) { const mid = (lo + hi) / 2; if (t - mid - LV / CP * (env.qsatP(mid, p) - q) > 0) lo = mid; else hi = mid }
  return (lo + hi) / 2
}

/** Standard parcel indices (no temperature excess, no entrainment), comparable with MetPy / SHARPpy. */
export function parcelIndices(env: Environment, height: number): ParcelIndices {
  const strip = ({ cape, cin, lcl, lfc, el }: Ascent): ParcelIndex => ({ cape, cin, lcl, lfc, el })
  const p0 = env.pressureAt(0)
  const sb = strip(ascend(env, height, 0, env.temperatureEnv(0), env.qEnv(0), 0))
  // Mixed layer: pressure-weighted means of theta and q over the lowest 100 hPa.
  const mlTop = heightOf(env, p0 - 10000, height)
  let thetaSum = 0, qSum = 0, weight = 0
  for (let z = 0; z < mlTop; z += 10) { const dp = env.pressureAt(z) - env.pressureAt(z + 10); thetaSum += env.thetaEnv(z + 5) * dp; qSum += env.qEnv(z + 5) * dp; weight += dp }
  const ml = strip(ascend(env, height, 0, thetaSum / weight * (p0 / 100000) ** KAPPA - 273.15, qSum / weight, 0, mlTop))
  // Most unstable: the highest theta-e in the lowest 300 hPa.
  const muTop = heightOf(env, p0 - 30000, height)
  let muZ = 0, best = -Infinity
  for (let z = 0; z <= muTop; z += 25) { const te = thetaE(env.temperatureEnv(z), env.qEnv(z), env.pressureAt(z)); if (te > best) { best = te; muZ = z } }
  const mu = { ...strip(ascend(env, height, muZ, env.temperatureEnv(muZ), env.qEnv(muZ), 0)), start: muZ / 1000 }
  // Downdraft: the lowest theta-e between 700 and 500 hPa, lowered to the ground along the pseudo-adiabat.
  let start = heightOf(env, 70000, height), worst = Infinity
  for (let z = start, top = heightOf(env, 50000, height); z <= top; z += 25) { const te = thetaE(env.temperatureEnv(z), env.qEnv(z), env.pressureAt(z)); if (te < worst) { worst = te; start = z } }
  const vt = (t: number, q: number) => (t + 273.15) * (1 + .61 * q)
  let temp = wetBulb(env, env.temperatureEnv(start), env.qEnv(start), env.pressureAt(start)), dcape = 0
  let prev = vt(env.temperatureEnv(start), env.qEnv(start)) - vt(temp, env.qsatP(temp, env.pressureAt(start)))
  for (let z = start; z > 0; z -= 25) {
    const below = Math.max(0, z - 25), pa = env.pressureAt(z), pb = env.pressureAt(below)
    temp = moistStep(env, temp, pa, pb)
    const diff = vt(env.temperatureEnv(below), env.qEnv(below)) - vt(temp, env.qsatP(temp, pb))
    dcape += RD * (prev + diff) / 2 * Math.log(pb / pa); prev = diff
  }
  return { sb, ml, mu, dcape }
}
