/**
 * The regime map (2.9), as the Weisman-Klemp (1982) diagram: the same run on a grid of environments, the boundary-layer
 * moisture (so the CAPE) one way and the 0-6 km shear the other, and what kind of storm grew in each. Everything else
 * stays as set, the seed too, so the cells differ only by the environment. The moisture scales the vapour below 1.5 km
 * (the sliders' humidity, a sounding's dew point, the WK vapour cap); the shear scales the hodograph about the ground
 * wind to a given 0-6 km difference, its shape kept (a straight westerly shear added to a calm one).
 */
import { createGrid, domainGrid, Environment, environmentProfile, parcelIndices, type SimConfig, stormIndices } from '../core'
import { clamp, mod } from '../core/math'
import { EVENTS, memberPeaks, type MemberPeaks } from '../ensemble/combine'
import type { MemberResult } from '../ensemble/member'

/** The grids: the vapour factors (rows, driest first) and the 0-6 km shears (columns, m/s). */
export const GRIDS = {
  small: { moisture: [.9, 1, 1.1], shear: [0, 20, 40] },
  full: { moisture: [.8, .9, 1, 1.1], shear: [0, 10, 20, 30, 40] },
} as const
export type GridSize = keyof typeof GRIDS

/** Below this 0-6 km difference, m/s, a profile is taken as calm: the shear is added instead of scaled. */
const CALM = 2
const WIND_NODES = [['0', 0], ['05', 500], ['1', 1000], ['3', 3000], ['6', 6000], ['10', 10000]] as const

/** ML CAPE (J/kg) and the 0-6 km shear (m/s) of a configuration's environment. */
export function environmentOf(config: SimConfig) {
  const grid = createGrid(domainGrid(config.domain, config.top, config.domainSize, config.spacing)), env = new Environment(config, grid, environmentProfile(config, grid.height))
  const p = parcelIndices(env, grid.height), k = stormIndices(env, p)
  return { cape: p.ml.cape, shear: k.shear06, srh: k.srh03 }
}

/** The configuration with its vapour below 1.5 km times `factor` (tapering to none at 1.5 km). */
export function withMoisture(config: SimConfig, factor: number): SimConfig {
  const c = structuredClone(config)
  if (c.profile === 'weisman-klemp') { c.weismanKlemp = { ...c.weismanKlemp, qvMax: (c.weismanKlemp?.qvMax ?? .016) * factor }; return c }
  if (c.sounding) {
    // The vapour pressure scales with the mixing ratio: the dew point from e = 611.2 exp(17.67 Td / (Td + 243.5)).
    const dew = (td: number, k: number) => { const l = 17.67 * td / (td + 243.5) + Math.log(k); return 243.5 * l / (17.67 - l) }
    c.sounding = { ...c.sounding, levels: c.sounding.levels.map(l => {
      const k = 1 + (factor - 1) * Math.max(0, 1 - l.z / 1500)
      return { ...l, td: l.td === null ? null : Math.min(l.t, dew(l.td, k)), qv: l.qv === undefined ? undefined : l.qv * k }
    }) }
    return c
  }
  // The slider profile: the relative humidity at a fixed temperature goes with the vapour.
  c.rhSurface = clamp(c.rhSurface * factor, 5, 100); c.rhLow = clamp(c.rhLow * factor, 5, 100)
  return c
}

/** The configuration with its 0-6 km wind difference made `shear` m/s, the hodograph's shape kept. */
export function withShear(config: SimConfig, shear: number): SimConfig {
  const c = structuredClone(config) as SimConfig & Record<string, unknown>, now = environmentOf(config).shear
  if (c.profile === 'weisman-klemp') {
    // The WK hodograph starts from calm at the ground, so it scales as a whole.
    const f = now > CALM ? shear / now : 0, wk = c.weismanKlemp ?? {}
    c.weismanKlemp = { ...wk, radius: (wk.radius ?? 8) * f, u6: (wk.u6 ?? 30) * f }
    return c
  }
  const f = now > CALM ? shear / now : 1, added = now > CALM ? 0 : shear
  // u, v at height z from the ground's: the difference scaled, or a straight westerly shear over 0-6 km added.
  const map = (z: number, u: number, v: number, u0: number, v0: number) => [u0 + (u - u0) * f + added * Math.min(z, 6000) / 6000, v0 + (v - v0) * f] as const
  if (c.sounding) {
    const ground = c.sounding.levels.find(l => l.u !== null && l.v !== null), u0 = ground?.u ?? 0, v0 = ground?.v ?? 0
    c.sounding = { ...c.sounding, levels: c.sounding.levels.map(l => {
      if (l.u === null || l.v === null) return l
      const [u, v] = map(l.z, l.u, l.v, u0, v0); return { ...l, u, v }
    }) }
    return c
  }
  const uv = (speed: number, dir: number) => { const a = (270 - dir) * Math.PI / 180; return [speed * Math.cos(a), speed * Math.sin(a)] as const }
  const [u0, v0] = uv(c.wind0, c.windDir0)
  for (const [k, z] of WIND_NODES) {
    const speed = c[`wind${k}`], dir = c[`windDir${k}`]
    if (typeof speed !== 'number' || typeof dir !== 'number') continue
    const [u, v] = map(z, ...uv(speed, dir), u0, v0), s = Math.hypot(u, v)
    c[`wind${k}`] = s
    if (s > .05) c[`windDir${k}`] = mod(270 - Math.atan2(v, u) * 180 / Math.PI, 360)
  }
  return c
}

/** One cell of the map: its settings and the environment they make. */
export interface RegimeCell { row: number; column: number; config: SimConfig; cape: number; shear: number }

/** The grid's cells, row by row (driest first), from the settings given. */
export function regimeCells(config: SimConfig, size: GridSize): RegimeCell[] {
  const { moisture, shear } = GRIDS[size]
  return moisture.flatMap((m, row) => shear.map((s, column) => {
    const c = withShear(withMoisture(config, m), s), e = environmentOf(c)
    return { row, column, config: c, cape: e.cape, shear: e.shear }
  }))
}

/** An ordinary cell's life, s: an updraught later than this is a new cell's or a steady storm's. */
export const CELL_LIFE = 40 * 60

/**
 * What kind of storm a run made: none (no updraught of 10 m/s with rain); a supercell (a mesocyclone held
 * MESO_PERSISTENCE, combine.ts); multicell (no mesocyclone, but an updraught still at least half the strongest, and
 * 10 m/s, in the run's last third and after CELL_LIFE: new cells keep rising on the gust front); or an ordinary cell
 * that rose and rained itself out. Without shear WK82's one cell (69 m/s at 16 min) holds ~55 m/s to 28 min and is
 * down to 6 by 45: judged at 40 min it would pass for a multicell.
 */
export type Regime = 'none' | 'ordinary' | 'multicell' | 'supercell'
export function regimeOf(r: MemberResult, p: MemberPeaks = memberPeaks(r)): Regime {
  if (!EVENTS.storm(p)) return 'none'
  if (p.mesocyclone !== null) return 'supercell'
  const end = r.samples[r.samples.length - 1].t, late = r.samples.filter(s => s.t >= Math.max(CELL_LIFE, end * 2 / 3)).reduce((v, s) => Math.max(v, s.updraft), 0)
  return late >= Math.max(10, p.updraft / 2) ? 'multicell' : 'ordinary'
}

