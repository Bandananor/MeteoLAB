import { G } from './constants'
import { N0G, RHO_G } from './graupel'
import { N0H, RHO_H } from './hail'
import { N0S, RHO_S } from './ice'

// Electrification, 2.3 step 2: the charge carried by the hydrometeors and the non-inductive charging that separates it.
// Four carriers, each with its own charge per kilogram of air (C/kg, transported like the water it rides on): cloud
// ice with snow, graupel with hail, rain, and the cloud droplets with the small ions of the air (the charge left behind
// when charged particles evaporate or sublimate: it stays in the air, it does not vanish).

/** No charge separation colder than this (Mansell et al. 2005 / Saunders and Peck 1998: no data), °C. */
export const CHARGING_COLDEST = -33
/** Upper limit of the charge separated per collision, C — keeps the fit, extrapolated to large aggregates, bounded. */
export const MAX_COLLISION_CHARGE = 50e-15

/**
 * Critical rime accretion rate of Saunders and Peck (1998), g m⁻² s⁻¹: above it graupel charges positively, below it
 * negatively. Their polynomial fit for -23.7 < T < -7.35 °C, rising to the cold: 1.14 at -7.35 °C, 1.19 at -10, 1.65 at
 * -15, 2.76 at -20, 3.40 at -23.7; held constant outside that range.
 */
export function criticalRar(tc: number) {
  const t = Math.min(-7.35, Math.max(-23.7, tc))
  return 1 + 7.9262e-2 * t + 4.4847e-2 * t ** 2 + 7.4754e-3 * t ** 3 + 5.4686e-4 * t ** 4 + 1.6737e-5 * t ** 5 + 1.7613e-7 * t ** 6
}

/**
 * Charge gained by the graupel in one rebounding collision with an ice crystal of diameter d (m) at impact speed v
 * (m/s), C: B d^a v^b q±(RAR) (Saunders et al. 1991, with q± of Saunders and Peck 1998, in fC). B and a by crystal size
 * (continuous at 155 and 452 µm), b = 2.5. q+ = 6.74 (RAR - RARc) above the critical rate; below it
 * q- = 3.9 (RARc - 0.1) (4 ((RAR - (RARc + 0.1)/2) / (RARc - 0.1))² - 1), negative between 0.1 and RARc, the most
 * negative halfway. Zero above 0 °C and colder than CHARGING_COLDEST; bounded by MAX_COLLISION_CHARGE.
 */
export function collisionCharge(tc: number, rar: number, d: number, v: number) {
  if (tc >= 0 || tc < CHARGING_COLDEST || d <= 0 || v <= 0) return 0
  const c = criticalRar(tc)
  const q = rar > c ? 6.74 * (rar - c) : rar > .1 ? 3.9 * (c - .1) * (4 * ((rar - (c + .1) / 2) / (c - .1)) ** 2 - 1) : 0
  const scale = d < 155e-6 ? 4.92e13 * d ** 3.76 : d < 452e-6 ? 4.04e6 * d ** 1.9 : 52.8 * d ** .44
  const dq = scale * v ** 2.5 * q * 1e-15
  return Math.max(-MAX_COLLISION_CHARGE, Math.min(MAX_COLLISION_CHARGE, dq))
}

/** Number of ice crystals per m³ at tc °C (Cooper 1986, 5 exp(0.304 (T0 - T)) per m³), at most 250 per litre. */
export function crystalNumber(tc: number) { return Math.min(250e3, 5 * Math.exp(.304 * Math.max(0, -tc))) }

/** Mean volume diameter of crystals of mixing ratio qi (kg/kg) in air of density rho at tc °C, m (solid ice spheres). */
export function crystalDiameter(qi: number, rho: number, tc: number) { return qi > 0 ? Math.cbrt(6 * rho * qi / (Math.PI * 900 * crystalNumber(tc))) : 0 }

/** A rimer: an exponential size distribution of intercept n0 (m⁻⁴) and particle density rhoX, fall law V = a D^0.5. */
interface Rimer { n0: number; density: number }
const GRAUPEL: Rimer = { n0: N0G, density: RHO_G }, HAIL: Rimer = { n0: N0H, density: RHO_H }
const CD = .6, GAMMA_45 = 11.6317

/**
 * Charge separation rate at a node, C m⁻³ s⁻¹, gained by the graupel-hail carrier (the ice-snow carrier gets the
 * opposite): every rimer (graupel, hail) meets every crystal kind (cloud ice, snow); the collisions that rebound
 * (1 - exp(0.09 Tc), the sticking efficiency of Lin et al. 1983) each separate collisionCharge. Collisions per m³ and s:
 * N_c E π/4 ∫ (D + d_c)² n(D) dD |V - v_c| with the rimer's mass-weighted fall speed V; the rime accretion rate is the
 * cloud water content (g m⁻³) times V (the riming sweep of the model's microphysics, efficiency 1).
 * Mixing ratios in kg/kg, rho the air density (kg/m³), snowFall the snow's mass-weighted fall speed (m/s).
 */
export function chargingRate(tc: number, rho: number, cloud: number, ice: number, snow: number, graupel: number, hail: number, snowFall: number) {
  if (tc >= 0 || tc < CHARGING_COLDEST || cloud <= 0 || ice + snow <= 0 || graupel + hail <= 0) return 0
  // Called at every mixed-phase node each step: no arrays, two rimers by two crystal kinds written out.
  const rebound = 1 - Math.exp(.09 * tc), water = rho * cloud * 1000
  const ni = ice > 0 ? crystalNumber(tc) : 0, di = ice > 0 ? crystalDiameter(ice, rho, tc) : 0
  const snowSlope = snow > 0 ? (Math.PI * RHO_S * N0S / (rho * snow)) ** .25 : 0, ns = snow > 0 ? N0S / snowSlope : 0, ds = snow > 0 ? 1 / snowSlope : 0
  let rate = 0
  if (graupel > 0) rate += rimerRate(GRAUPEL, graupel, tc, rho, water, rebound, ni, di, ns, ds, snowFall)
  if (hail > 0) rate += rimerRate(HAIL, hail, tc, rho, water, rebound, ni, di, ns, ds, snowFall)
  return rate
}

/** One rimer's share of chargingRate: its collisions with the cloud ice (ni per m³ of diameter di, at rest) and the snow (ns, ds, falling at vs). */
function rimerRate(rimer: Rimer, mass: number, tc: number, rho: number, water: number, rebound: number, ni: number, di: number, ns: number, ds: number, vs: number) {
  const lambda = (Math.PI * rimer.density * rimer.n0 / (rho * mass)) ** .25, fall = Math.sqrt(4 * G * rimer.density / (3 * CD * rho)) * GAMMA_45 / 6 / Math.sqrt(lambda)
  const rar = water * fall, l2 = lambda * lambda, l3 = l2 * lambda, k = Math.PI / 4 * rimer.n0 * rebound
  let rate = 0
  if (ni > 0) rate += ni * k * (2 / l3 + 2 * di / l2 + di * di / lambda) * fall * collisionCharge(tc, rar, di, fall)
  if (ns > 0) { const v = Math.abs(fall - vs); rate += ns * k * (2 / l3 + 2 * ds / l2 + ds * ds / lambda) * v * collisionCharge(tc, rar, ds, v) }
  return rate
}

/** Index of the cloud-droplet and ion carrier in transferCharge's arrays. */
export const AIR_CARRIER = 3

/**
 * Moves the charge with the mass when the microphysics moves water between the carriers [ice-snow, graupel-hail, rain,
 * cloud droplets and ions]: a carrier that lost mass gives up that share of its charge; the pool goes to the carriers
 * that gained mass, in proportion to their gains, as far as the lost mass went into them; the rest (the mass went to
 * vapour) stays in the air as ions, on the last carrier. A precipitation carrier left without mass keeps no charge
 * (it passes to the ions); the ions keep theirs in clear air. Exactly conservative: the sum of `charge` is unchanged.
 * `charge` (C/kg) and `before` / `after` (masses, kg/kg) have four entries; charge is changed in place.
 */
export function transferCharge(charge: number[], before: number[], after: number[]) {
  let pool = 0, lost = 0, gained = 0
  for (let k = 0; k < 4; k++) {
    if (after[k] < before[k]) { const share = before[k] > 0 ? (before[k] - after[k]) / before[k] : 1, out = charge[k] * share; charge[k] -= out; pool += out; lost += before[k] - after[k] }
    else gained += after[k] - before[k]
    if (k !== AIR_CARRIER && after[k] <= 0 && charge[k] !== 0) { pool += charge[k]; charge[k] = 0 }
  }
  if (pool === 0) return
  const moved = gained > 0 ? Math.min(1, lost > 0 ? gained / lost : 1) : 0
  if (moved > 0) for (let k = 0; k < 4; k++) if (after[k] > before[k]) charge[k] += pool * moved * (after[k] - before[k]) / gained
  charge[AIR_CARRIER] += pool * (1 - moved)
}
