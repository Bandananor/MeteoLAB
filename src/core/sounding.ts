import type { SimConfig } from './config'
import { CP, EPS, G, KAPPA, LV, RD } from './constants'
import type { Environment } from './environment'
import { clamp, lerp } from './math'

export interface ParcelPoint { z: number; env: number; dew: number; parcel: number; buoyancy: number }
export interface WindPoint { z: number; u: number; v: number }
export interface Sounding {
  profile: ParcelPoint[]; wind: WindPoint[]
  cape: number; cin: number; lcl: number | null; lfc: number | null; el: number | null; freezing: number | null
}

export interface ParcelOptions {
  /** Surface parcel temperature excess, K. */ excess?: number
  /** Mix the parcel with the environment according to config.entrainment. */ entrain?: boolean
}

/**
 * Parcel ascent from the surface (heights in km), plus the wind profile and the 0 °C level of the environment.
 * Defaults reproduce the app's diagnostic parcel; `{ excess: 0, entrain: false }` is the standard surface-based parcel.
 */
export function computeSounding(config: SimConfig, env: Environment, height: number, { excess = .5, entrain = true }: ParcelOptions = {}): Sounding {
  // 25 m: the switch to the moist adiabat happens at the first saturated level, so a coarse step shifts the LCL.
  const profile: ParcelPoint[] = [], dz = 25
  let temp = config.surfaceTemp + excess, q = config.rhSurface / 100 * env.qsat(temp, 0), saturated = false
  let lcl: number | null = null, lfc: number | null = null, el: number | null = null, cape = 0, cin = 0
  for (let z = 0; z <= height; z += dz) {
    const sat = env.qsat(temp, z)
    if (q >= sat) { saturated = true; q = sat; if (lcl === null) lcl = z / 1000 }
    const tv = (temp + 273.15) * (1 + .61 * q), envT = env.temperatureEnv(z), envTv = (envT + 273.15) * (1 + .61 * env.qEnv(z)), b = G * (tv - envTv) / envTv
    if (lcl !== null && lfc === null && b > 0) lfc = z / 1000
    if (lfc !== null && el === null && b <= 0 && z / 1000 > lfc + .2) el = z / 1000
    if (lfc === null && b < 0) cin += -b * dz
    if (lfc !== null && el === null && b > 0) cape += b * dz
    profile.push({ z: z / 1000, env: envT, dew: env.dewpoint(env.qEnv(z), z), parcel: temp, buoyancy: b })
    // The parcel follows the environment's pressure: dry adiabat (theta conserved) below the LCL, pseudo-adiabat
    // dT/dp above it (midpoint rule). Height-based lapse rates assume T_parcel = T_env and made the parcel too warm aloft.
    const p0 = env.pressureAt(z), p1 = env.pressureAt(z + dz)
    if (saturated) {
      const dTdp = (t: number, p: number) => { const tk = t + 273.15, rs = env.qsatP(t, p); return (RD * tk + LV * rs) / (CP + LV * LV * rs * EPS / (RD * tk * tk)) / p }
      const mid = temp + dTdp(temp, p0) * (p1 - p0) / 2
      temp += dTdp(mid, (p0 + p1) / 2) * (p1 - p0)
    } else temp = (temp + 273.15) * (p1 / p0) ** KAPPA - 273.15
    // Entrainment is a rate per 100 m (as it was with the old 100 m step), scaled to the actual step.
    const mix = entrain ? clamp(config.entrainment * .006, 0, .02) * dz / 100 : 0
    temp = lerp(temp, env.temperatureEnv(z + dz), mix); q = lerp(q, env.qEnv(z + dz), mix)
  }
  const wind: WindPoint[] = []
  for (let z = 0; z <= 10_000; z += 250) { const [u, v] = env.windUV(z); wind.push({ z: z / 1000, u, v }) }
  let freezing: number | null = null
  for (let z = 0; z <= height; z += 25) if (env.temperatureEnv(z) <= 0) { freezing = z / 1000; break }
  return { profile, wind, cape, cin, lcl, lfc, el, freezing }
}
