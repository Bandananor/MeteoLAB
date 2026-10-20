/**
 * The simple settings (2.9): a few knobs a newcomer understands — heat, moisture, the wind aloft (the 0-6 km shear),
 * the wind's turning with height, the time of day — each a change of the whole profile, whatever it comes from (the
 * sliders, a sounding, the Weisman-Klemp formulas). The heat and the moisture are read as changes from the scenario
 * (so they need no state of their own: choosing a scenario sets them back), the shear and the turning as they are.
 */
import type { SimConfig } from '../core'
import { clamp, mod } from '../core/math'
export { environmentOf, withMoisture, withShear } from '../regime/grid'

/** Depth over which the heat and the moisture fade out, m (the boundary layer the sun and the ground act on). */
const LOW = 1500
const vapourPressure = (td: number) => 611.2 * Math.exp(17.67 * td / (td + 243.5))
/** The lowest level of a sounding with a dew point. */
const ground = (c: SimConfig) => c.sounding?.levels.find(l => l.td !== null)

/** How much warmer the ground air is than in the scenario `base`, K (null: the WK formulas, which have no knob for it). */
export function heatOf(c: SimConfig, base: SimConfig): number | null {
  if (c.profile === 'weisman-klemp') return null
  if (c.sounding) { const a = c.sounding.levels[0], b = base.sounding?.levels[0]; return b ? a.t - b.t : 0 }
  return c.surfaceTemp - base.surfaceTemp
}

/** The air near the ground `dT` K warmer, fading out by 1.5 km (a sounding's dew point with it: the humidity kept). */
export function withHeat(config: SimConfig, dT: number): SimConfig {
  const c = structuredClone(config)
  if (c.sounding) c.sounding = { ...c.sounding, levels: c.sounding.levels.map(l => { const k = dT * Math.max(0, 1 - l.z / LOW); return { ...l, t: l.t + k, td: l.td === null ? null : l.td + k } }) }
  else c.surfaceTemp += dT
  return c
}

/** The vapour near the ground as a share of the scenario's (as withMoisture scales it). */
export function moistureOf(c: SimConfig, base: SimConfig): number {
  if (c.profile === 'weisman-klemp') return (c.weismanKlemp?.qvMax ?? .016) / (base.weismanKlemp?.qvMax ?? .016)
  if (c.sounding) {
    const a = ground(c), b = ground(base), heat = heatOf(c, base) ?? 0
    // The heat moves the dew point too (withHeat): the vapour's own change is what is left.
    return a && b ? vapourPressure(a.td! - heat) / vapourPressure(b.td!) : 1
  }
  return c.rhSurface / base.rhSurface
}

/** The wind's turning from the ground to 3 km, °, clockwise (veering) positive; null: not of the sliders. */
export function turnOf(c: SimConfig): number | null {
  if (c.profile === 'weisman-klemp' || c.sounding) return null
  return mod(c.windDir3 - c.windDir0 + 180, 360) - 180
}

/**
 * The wind turning `deg` from the ground to 3 km: the nodes below 3 km take their direction from the 3 km one, turned
 * back in proportion to how far below it they are; their speeds and the wind above stay.
 */
export function withTurn(config: SimConfig, deg: number): SimConfig {
  const c = structuredClone(config), top = c.windDir3, turn = clamp(deg, -180, 180)
  c.windDir0 = mod(top - turn, 360)
  if (c.windDir05 !== undefined) c.windDir05 = mod(top - turn * (1 - 500 / 3000), 360)
  if (c.windDir1 !== undefined) c.windDir1 = mod(top - turn * (1 - 1000 / 3000), 360)
  return c
}
