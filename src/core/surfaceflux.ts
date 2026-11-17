import { graupelFallSpeed } from './graupel'
import { hailFallSpeed } from './hail'
import { snowFallSpeed } from './ice'
import { boundedIceNumber, GRAUPEL_2M, HAIL_2M, type IceClass, momentSpeed } from './ice2m'
import { fallSpeed } from './microphysics'
import type { MomentFields } from './radar'
import { fallSpeeds } from './rain2m'

/** What the flux at a node needs: the mixing ratios and, with two-moment microphysics, the second moments. */
export type FluxSource = MomentFields & { rain: ArrayLike<number>; snow: ArrayLike<number>; graupel: ArrayLike<number>; hail: ArrayLike<number> }

/** Mass-weighted fall speed (m/s) of two-moment graupel or hail; null when the node has no second moment. */
function iceSpeed(c: IceClass, q: number, n: ArrayLike<number> | undefined, vol: ArrayLike<number> | undefined, i: number, rho: number) {
  const ni = n?.[i]
  if (ni === undefined || !(ni > 0)) return null
  const v = vol?.[i] ?? 0
  return momentSpeed(c, q, boundedIceNumber(c, q, ni, v), v, rho, 3)
}

/** Rain's mass flux through node i, kg/(m2 s): two-moment drops fall at their own mass-weighted speed. */
export function rainFlux(m: Pick<FluxSource, 'rain' | 'rainNumber'>, i: number, rho: number) {
  const r = m.rain[i], n = m.rainNumber?.[i]
  return rho * r * (n !== undefined && n > 0 ? fallSpeeds(r, n, rho)[0] : fallSpeed(r, rho, rho))
}

/**
 * Precipitation mass flux through node i (kg/(m2 s), times 3600 mm/h of water): rain, snow, graupel and hail at their
 * mass-weighted fall speeds; those of the two-moment distributions where the moments are present (rain2m.ts, ice2m.ts),
 * else those of the fixed intercepts. rho is the air density at the node (the ground node for the surface flux).
 */
export function precipitationFlux(m: FluxSource, i: number, rho: number) {
  const s = m.snow[i], g = m.graupel[i], h = m.hail[i]
  const vg = g > 0 ? iceSpeed(GRAUPEL_2M, g, m.graupelNumber, m.graupelVolume, i, rho) ?? graupelFallSpeed(g, rho) : 0
  const vh = h > 0 ? iceSpeed(HAIL_2M, h, m.hailNumber, m.hailVolume, i, rho) ?? hailFallSpeed(h, rho) : 0
  return rainFlux(m, i, rho) + rho * (s * snowFallSpeed(s, rho, rho) + g * vg + h * vh)
}
