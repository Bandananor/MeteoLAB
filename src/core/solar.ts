import type { SimConfig } from './config'

const localHour = (config: SimConfig, time: number) => config.hour + time / 3600

/**
 * Solar declination, rad, for day of the year n (Cooper 1969: 23.44° sin(2π (284 + n) / 365)); absent n = an equinox
 * (declination 0), as before 2026-10-11.
 */
export function declination(n?: number) { return n === undefined ? 0 : 23.44 * Math.PI / 180 * Math.sin(2 * Math.PI * (284 + n) / 365) }

/** Solar irradiance on the horizontal surface, W/m2: solarMax (sun in the zenith) times the cosine of the zenith angle. */
export function insolation(config: SimConfig, time: number) {
  // The single-storm mode has no sun (SimConfig.single): the storm alone, no thermals of the afternoon around it.
  return config.single ? 0 : config.solarMax * Math.max(0, sunDirection(config, time).y)
}

/**
 * Unit vector towards the sun at local solar time, latitude and declination (day of the year; at an equinox it rises at
 * 06:00 and sets at 18:00), matching insolation(). Axes: x east, y up, z south (so the right-handed scene is not mirrored).
 */
export function sunDirection(config: SimConfig, time: number) {
  const h = (localHour(config, time) - 12) * Math.PI / 12, phi = config.latitude * Math.PI / 180, d = declination(config.dayOfYear)
  const cd = Math.cos(d), sd = Math.sin(d)
  return { x: -cd * Math.sin(h), y: Math.sin(phi) * sd + Math.cos(phi) * cd * Math.cos(h), z: Math.sin(phi) * cd * Math.cos(h) - Math.cos(phi) * sd }
}
