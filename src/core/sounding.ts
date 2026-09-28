import type { SimConfig } from './config'
import { CP, EPS, G, LV, RD } from './constants'
import type { Environment } from './environment'
import { clamp, lerp } from './math'

export interface ParcelPoint { z: number; env: number; dew: number; parcel: number; buoyancy: number }
export interface WindPoint { z: number; u: number; v: number }
export interface Sounding {
  profile: ParcelPoint[]; wind: WindPoint[]
  cape: number; cin: number; lcl: number | null; lfc: number | null; el: number | null; freezing: number | null
}

/** Parcel ascent from the surface (heights in km), plus the wind profile and the 0 °C level of the environment. */
export function computeSounding(config: SimConfig, env: Environment, height: number): Sounding {
  const profile: ParcelPoint[] = [], dz = 100
  let temp = config.surfaceTemp + .5, q = config.rhSurface / 100 * env.qsat(temp, 0), saturated = false
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
    if (saturated) { const tk = temp + 273.15, gamma = G * (1 + LV * sat / (RD * tk)) / (CP + LV * LV * sat * EPS / (RD * tk * tk)); temp -= gamma * dz } else temp -= .0098 * dz
    const mix = clamp(config.entrainment * .006, 0, .02)
    temp = lerp(temp, env.temperatureEnv(z + dz), mix); q = lerp(q, env.qEnv(z + dz), mix)
  }
  const wind: WindPoint[] = []
  for (let z = 0; z <= 10_000; z += 250) { const [u, v] = env.windUV(z); wind.push({ z: z / 1000, u, v }) }
  let freezing: number | null = null
  for (let z = 0; z <= height; z += 25) if (env.temperatureEnv(z) <= 0) { freezing = z / 1000; break }
  return { profile, wind, cape, cin, lcl, lfc, el, freezing }
}
