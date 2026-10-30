/**
 * The ensemble's summary (2.9), as forecasters read one: the share of members in which an event happened (its
 * probability for these settings), the spread of each value (least, median, most), and per ground column the share of
 * members whose swath reached a threshold there — the probability maps.
 */
import { MESO_PERSISTENCE, UH_ROTATING, uhScale } from '../core'
import type { MemberResult } from './member'

/** The maps: what each counts and from what threshold. */
export const MAPS = {
  rain: { field: 'rainTotal', threshold: 10 },
  gust: { field: 'gustMax', threshold: 20 },
  uh: { field: 'uhMax', threshold: UH_ROTATING },
  hail: { field: 'hailSize', threshold: 20 },
} as const satisfies Record<string, { field: 'rainTotal' | 'gustMax' | 'uhMax' | 'hailSize'; threshold: number }>
export type MapKind = keyof typeof MAPS

/** A member's highlights over its run. */
export interface MemberPeaks { updraft: number; uh: number; rain: number; rainTotal: number; gust: number; hail: number; flashes: number; mesocyclone: number | null; outflow: number; outflowLow: number }

export function memberPeaks(r: MemberResult): MemberPeaks {
  const max = (k: 'updraft' | 'uh' | 'rain' | 'gust' | 'hail' | 'flashes') => r.samples.reduce((v, s) => Math.max(v, s[k]), 0)
  const meso = r.samples.find(s => s.rotationHeld >= MESO_PERSISTENCE)
  return { updraft: max('updraft'), uh: max('uh'), rain: max('rain'), rainTotal: r.rainTotal.reduce((v, x) => Math.max(v, x), 0), gust: max('gust'), hail: max('hail'), flashes: max('flashes'), mesocyclone: meso ? meso.t - meso.rotationHeld : null,
    outflow: r.samples.reduce((v, s) => Math.max(v, s.outflow ?? 0), 0), outflowLow: r.samples.reduce((v, s) => Math.max(v, s.outflowLow ?? 0), 0) }
}

/** The events counted, each with its test on a member's highlights. */
export const EVENTS = {
  storm: (p: MemberPeaks) => p.updraft >= 10 && p.rain >= 1,
  mesocyclone: (p: MemberPeaks) => p.mesocyclone !== null,
  hail: (p: MemberPeaks) => p.hail >= MAPS.hail.threshold,
  gust: (p: MemberPeaks) => p.gust >= MAPS.gust.threshold,
  downpour: (p: MemberPeaks) => p.rain >= 50,
  total: (p: MemberPeaks) => p.rainTotal >= 20,
} as const
export type EventKind = keyof typeof EVENTS

/** The share (0-1) of members in which each event happened. */
export function probabilities(peaks: readonly MemberPeaks[]) {
  const out = {} as Record<EventKind, number>
  for (const k of Object.keys(EVENTS) as EventKind[]) out[k] = peaks.length ? peaks.filter(EVENTS[k]).length / peaks.length : 0
  return out
}

/** Least, median and most of some values (NaN when there are none). */
export function spread(values: readonly number[]) {
  if (!values.length) return { min: NaN, median: NaN, max: NaN }
  const v = [...values].sort((a, b) => a - b), mid = v.length >> 1
  return { min: v[0], median: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, max: v[v.length - 1] }
}

/** Per ground column, the share of members whose swath of `kind` reached its threshold there (UH's scaled to the member's grid, uhScale). */
export function probabilityMap(results: readonly MemberResult[], kind: MapKind) {
  const { field, threshold } = MAPS[kind], out = new Float32Array(results[0]?.rainTotal.length ?? 0)
  for (const r of results) { const f = r[field], at = kind === 'uh' ? threshold * uhScale(r.width / r.nx) : threshold; for (let c = 0; c < out.length; c++) if (f[c] >= at) out[c]++ }
  for (let c = 0; c < out.length; c++) out[c] /= results.length
  return out
}
