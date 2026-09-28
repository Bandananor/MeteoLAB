import type { SimConfig } from './config'

const localHour = (config: SimConfig, time: number) => config.hour + time / 3600

/** Solar irradiance at the surface, W/m2. */
export function insolation(config: SimConfig, time: number) {
  return config.solarMax * Math.max(0, Math.sin(Math.PI * (localHour(config, time) - 6) / 12))
}

/**
 * Unit vector towards the sun for an equinox day (declination 0): rises at 06:00 and sets at 18:00, matching insolation().
 * Axes: x east, y up, z south (so the right-handed scene is not mirrored).
 */
export function sunDirection(config: SimConfig, time: number) {
  const h = (localHour(config, time) - 12) * Math.PI / 12, phi = config.latitude * Math.PI / 180
  return { x: -Math.sin(h), y: Math.cos(phi) * Math.cos(h), z: Math.sin(phi) * Math.cos(h) }
}
