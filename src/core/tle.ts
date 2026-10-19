import { EPSILON0 } from './electric'

// Transient luminous events above the storm (2.7.3): sprites and halos from the charge a cloud-to-ground flash lowers.
// The charge Q taken from height h leaves, with its image in the conducting ground, a dipole 2 Q h: on the axis above it
// a quasi-electrostatic field E(z) = Q h / (π ε0 z³) (Pasko et al. 1997, without the conductivity's relaxation), while
// the breakdown field falls with the air density, E_k(z) = E_K0 e^(-z / H). E falls as z⁻³ and E_k faster, so above
// ~22 km their ratio only grows: where E reaches E_k below the night ionosphere (~85 km) streamers start, a sprite; a
// weaker field that still reaches half of E_k there only lights the air without breakdown, a halo. The threshold comes
// out at ~410 C km of charge moment change for a sprite (observed 300-600 C km, Cummer & Lyons 2005; Lyons et al.
// 2003), ~200 for a halo, so almost only strong positive CG make them, as in nature. Elves (the electromagnetic pulse
// of a peak current over ~80-100 kA) and jets (from the cloud top) need what the model does not have: not here.

/** Conventional breakdown field at sea-level density (Pasko et al. 1997), V/m, and the scale height of the air, m. */
export const E_K0 = 3.2e6, AIR_SCALE_HEIGHT = 7200
/** Lower edge of the night ionosphere, m: above it the air conducts and the field does not build up. */
export const IONOSPHERE = 85_000
/** Lowest height looked at, m (below ~22 km the ratio of E to E_k grows downwards again, into the storm's own field). */
const LOWEST = 40_000
/** A halo: the field reaches this share of E_k at the ionosphere's edge without reaching E_k (an estimate). */
export const HALO_SHARE = .5

export interface TransientEvent {
  kind: 'sprite' | 'halo'
  /** Sprite: the height where streamers start (E = E_k), m; halo: the ionosphere's edge, where it glows. */
  height: number
  /** E / E_k at the ionosphere's edge. */
  ratio: number
}

/** Field above the storm after a flash of charge moment change M (C m), V/m, at height z (m). */
export const momentField = (moment: number, z: number) => Math.abs(moment) / (Math.PI * EPSILON0 * z ** 3)
/** Breakdown field at height z, m, V/m. */
export const breakdownField = (z: number) => E_K0 * Math.exp(-z / AIR_SCALE_HEIGHT)

/** The sprite or halo a CG of charge moment change M (C m) makes, or none. */
export function transientEvent(moment: number): TransientEvent | undefined {
  const ratio = momentField(moment, IONOSPHERE) / breakdownField(IONOSPHERE)
  if (ratio < HALO_SHARE) return undefined
  if (ratio < 1) return { kind: 'halo', height: IONOSPHERE, ratio }
  // The lowest height where E >= E_k: the ratio grows with height between LOWEST and the ionosphere, so a bisection.
  let lo = LOWEST, hi = IONOSPHERE
  if (momentField(moment, lo) >= breakdownField(lo)) return { kind: 'sprite', height: lo, ratio }
  for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (momentField(moment, mid) >= breakdownField(mid)) hi = mid; else lo = mid }
  return { kind: 'sprite', height: hi, ratio }
}
