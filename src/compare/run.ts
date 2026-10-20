/**
 * Two runs compared (2.9): the run going on now (B) beside one remembered (A) — usually the same scenario with one
 * setting changed and a restart. A keeps what the «Ход грозы» plots record and, every MAP_EVERY model seconds, a map
 * of the strongest echo over each column, so the screen can set the two storms side by side at the same model time.
 * Only one model runs: two at once would each go at half the speed.
 */
import { DBZ_FLOOR, MESO_PERSISTENCE, reflectivity, type SimConfig } from '../core'
import type { TimelinePoint } from '../timeline'

/** A map of the strongest echo over each column (dBZ + 32, 0-255; 0 below DBZ_FLOOR), in the domain's frame. */
export interface EchoMap { t: number; nx: number; ny: number; /** The domain, m. */ width: number; depth: number; dbz: Uint8Array }
/** A remembered run: its name, settings, the plots' samples and the echo maps. */
export interface RunRecord { name: string; config: SimConfig; points: TimelinePoint[]; maps: EchoMap[] }

/** Model seconds between echo maps. */
export const MAP_EVERY = 60
/** The offset of the stored dBZ (so -32..223 fit a byte). */
const DBZ_OFFSET = 32

/** What the echo map needs of a model (the page's mirror). */
interface EchoSource {
  grid: { nx: number; ny: number; nz: number; layer: number; width: number; depth: number }
  env: { rho: ArrayLike<number>; exner: ArrayLike<number> }
  time: number
  theta: ArrayLike<number>; rain: ArrayLike<number>; snow: ArrayLike<number>; graupel: ArrayLike<number>; hail: ArrayLike<number>
}

/** The strongest echo over each column now. */
export function echoMap(m: EchoSource): EchoMap {
  const { nx, ny, nz, layer } = m.grid, out = new Float32Array(layer).fill(DBZ_FLOOR)
  for (let k = 0; k < nz; k++) {
    const rho = m.env.rho[k], exner = m.env.exner[k]
    for (let c = 0, i = k * layer; c < layer; c++, i++) {
      if (m.rain[i] + m.snow[i] + m.graupel[i] + m.hail[i] <= 0) continue
      const d = reflectivity(rho, m.rain[i], m.snow[i], m.graupel[i], m.theta[i] * exner - 273.15, m.hail[i])
      if (d > out[c]) out[c] = d
    }
  }
  const dbz = new Uint8Array(layer)
  for (let c = 0; c < layer; c++) dbz[c] = out[c] <= DBZ_FLOOR ? 0 : Math.max(1, Math.min(255, Math.round(out[c] + DBZ_OFFSET)))
  return { t: m.time, nx, ny, width: m.grid.width, depth: m.grid.depth, dbz }
}
/** A stored echo value back to dBZ (NaN: no echo). */
export const echoDbz = (v: number) => v === 0 ? NaN : v - DBZ_OFFSET

/** The latest of `items` (by time, ascending) at or before `t`, or the first when all are later; null when empty. */
export function atTime<T extends { t: number }>(items: readonly T[], t: number): T | null {
  if (!items.length) return null
  let lo = 0, hi = items.length - 1
  if (items[0].t > t) return items[0]
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (items[mid].t <= t) lo = mid; else hi = mid - 1 }
  return items[lo]
}

/** A run's highlights: the strongest of each value, the time a mesocyclone formed and the time the rain reached the ground. */
export interface Peaks { updraft: number; uh: number; rain: number; rainTotal: number; gust: number; hail: number; flashes: number; mesocyclone: number | null; firstRain: number | null; minutes: number }

export function peaks(points: readonly TimelinePoint[]): Peaks {
  const max = (f: (p: TimelinePoint) => number) => points.reduce((v, p) => Math.max(v, f(p)), 0)
  const first = (f: (p: TimelinePoint) => boolean) => points.find(f)?.t ?? null
  const meso = points.find(p => p.rotationHeld >= MESO_PERSISTENCE)
  return {
    updraft: max(p => p.updraft), uh: max(p => p.uh), rain: max(p => p.rain), rainTotal: max(p => p.rainTotal), gust: max(p => p.gust), hail: max(p => p.hail),
    flashes: max(p => p.flashes),
    // The mesocyclone formed when the rotation began to hold, not when it had held MESO_PERSISTENCE.
    mesocyclone: meso ? meso.t - meso.rotationHeld : null, firstRain: first(p => p.rain >= 1),
    minutes: points.length ? points[points.length - 1].t / 60 : 0,
  }
}

/** Settings that are not the experiment: how fast the page runs it. */
const NOT_SETTINGS = new Set<keyof SimConfig>(['speed'])

/** The settings in which two runs differ (compared by value), in the order of `a`'s keys and then `b`'s own. */
export function configChanges(a: SimConfig, b: SimConfig) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])] as (keyof SimConfig)[]
  return keys.filter(k => !NOT_SETTINGS.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]))
}

/** The echo maps of the run going on, one every MAP_EVERY model seconds; a restart (time going back) starts anew. */
export class EchoMaps {
  readonly maps: EchoMap[] = []
  /** Adds the map of `m` now if one is due; true when it did. */
  record(m: EchoSource) {
    const last = this.maps[this.maps.length - 1]
    if (last && m.time < last.t) this.maps.length = 0
    else if (last && m.time - last.t < MAP_EVERY) return false
    this.maps.push(echoMap(m))
    return true
  }
  /** Drops the maps after model time t (a rewind). */
  truncate(t: number) { while (this.maps.length && this.maps[this.maps.length - 1].t > t) this.maps.pop() }
}
