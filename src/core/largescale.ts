// Large-scale advection (2.6): the environment changes over hours, as the flow around the storm brings warmer, colder,
// moister or drier air ("moisture comes in by the evening", "cold aloft from a trough: +500 J/kg of CAPE in 2 h"). As in
// research models (CM1's large-scale forcing), the change is a tendency added to every node of a layer, uniform over
// the domain: the storm's own structure is kept, the air around it and the reference it is measured against move
// together. The base state's pressure and density stay as they were (a few K change them by ~1 %).
import { KAPPA } from './constants'
import type { EnvironmentProfile } from './environment'

export interface AdvectionChange {
  /** What changes: the temperature (K) or the water vapour (g/kg). */
  quantity: 'temperature' | 'moisture'
  /** The layer, km above the ground; the change fades out over LAYER_FADE above and below it. */
  bottom: number; top: number
  /** The whole change: K or g/kg. */
  amount: number
  /** When it starts, h from the start of the run, and over how many hours it comes (at a steady rate). */
  start: number; hours: number
}

/** How far the change fades out beyond its layer, m. */
export const LAYER_FADE = 500

/** Share of the change at height z (m) for the layer: 1 inside, falling linearly to 0 over LAYER_FADE outside. */
export function layerShare(c: Pick<AdvectionChange, 'bottom' | 'top'>, z: number) {
  const b = c.bottom * 1000, t = c.top * 1000
  if (z < b) return b <= 0 ? 1 : Math.max(0, 1 - (b - z) / LAYER_FADE)
  return z <= t ? 1 : Math.max(0, 1 - (z - t) / LAYER_FADE)
}

/** Share of the change that has come by time s (seconds of the run): a steady rate from start over hours. */
export function timeShare(c: Pick<AdvectionChange, 'start' | 'hours'>, s: number) {
  const t = s / 3600 - c.start
  return t <= 0 ? 0 : c.hours <= 0 || t >= c.hours ? 1 : t / c.hours
}

/** How much warmer (K of temperature) and moister (kg/kg) the environment is at height z (m) by time s. */
export function advected(changes: readonly AdvectionChange[] | undefined, z: number, s: number): [number, number] {
  let dt = 0, dq = 0
  if (changes) for (const c of changes) {
    const v = c.amount * layerShare(c, z) * timeShare(c, s)
    if (c.quantity === 'temperature') dt += v; else dq += v / 1000
  }
  return [dt, dq]
}

/**
 * The environment at time s (seconds of the run), for its numbers ahead (CAPE, CIN by the hour): the profile `env` with
 * the changes that have come by then.
 */
export function advectedProfile(env: { thetaEnv(z: number): number; qEnv(z: number): number; windUV(z: number): readonly [number, number]; pressureAt(z: number): number }, changes: readonly AdvectionChange[] | undefined, s: number): EnvironmentProfile {
  const exner = (z: number) => (env.pressureAt(z) / 100000) ** KAPPA
  return {
    theta: z => env.thetaEnv(z) + advected(changes, z, s)[0] / exner(z),
    qv: z => Math.max(0, env.qEnv(z) + advected(changes, z, s)[1]),
    rh: () => 0,
    wind: z => env.windUV(z),
    surfacePressure: env.pressureAt(0),
  }
}
