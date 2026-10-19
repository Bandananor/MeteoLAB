import { G } from './constants'
import { EPSILON0 } from './electric'
import { N0G, RHO_G } from './graupel'
import { N0H, RHO_H } from './hail'
import { N0S, plateSize, RHO_S } from './ice'

// Electrification, 2.3 step 2: the charge carried by the hydrometeors and the non-inductive charging that separates it.
// Four carriers, each with its own charge per kilogram of air (C/kg, transported like the water it rides on): cloud
// ice with snow, graupel with hail, rain, and the cloud droplets with the small ions of the air (the charge left behind
// when charged particles evaporate or sublimate: it stays in the air, it does not vanish).

/** No charge separation colder than this (Mansell et al. 2005 / Saunders and Peck 1998: no data), °C. */
export const CHARGING_COLDEST = -33
/**
 * Upper limit of the charge separated per collision, C — keeps the fit, extrapolated to large aggregates and fast
 * impacts, bounded (20 fC as in Ziegler et al. 1991 and Mansell et al. 2005, by memory).
 */
export const MAX_COLLISION_CHARGE = 20e-15
/**
 * Collection efficiency of cloud droplets (~10 µm) on graupel of 1-3 mm: the effective water content of the rime
 * accretion rate is this share of the cloud water (Saunders & Peck 1998 measured RAR = EW V with EW < LWC).
 */
export const COLLECTION_EFFICIENCY = .6
/**
 * Fall (impact) speed of the rimers that do the charging, at most, m/s: the small graupel of 0.5-2 mm (~5-6 m/s), as
 * in the laboratory (targets at 2-10 m/s), not the mass-weighted speed of the whole population (~9-12 m/s with the
 * model's hail-like intercept). With the mass-weighted speed and efficiency 1 the rime accretion rate was 3-6 times too
 * high, the graupel charged positively almost everywhere and the storm came out inverted (+CG ~90%; the
 * meteorologist's review 14.10.2026).
 */
export const CHARGING_SPEED = 6

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

/** Reference size of the crystals that charge, m: ~100 µm, as in the laboratory (Takahashi 1978, Saunders et al. 1991). */
export const CRYSTAL_SIZE = 100e-6
/**
 * Most crystals per m³ in a convective core: 150 per litre (10-100+ observed, Dye et al. 1986, by memory: secondary
 * ice from Hallett-Mossop splintering and homogeneous freezing).
 */
export const MAX_CRYSTALS = 150e3
/** Size range of the crystals for the charge per collision, m (the range of the fit of Saunders et al. 1991). */
export const CRYSTAL_RANGE = [20e-6, 300e-6] as const

/**
 * Number of ice crystals per m³ for the charging: the cloud ice mass (qi kg/kg in air of density rho) in crystals of
 * CRYSTAL_SIZE, at least as many as primary nucleation gives at tc °C (Cooper 1986, 5 exp(0.304 (T0 - T)) per m³) and
 * at most MAX_CRYSTALS. With the Cooper number alone (0.03 per litre at -6 °C, 0.5 at -15 °C) there were almost no
 * crystals warmer than -20 °C: the charging came out 5-10 times too weak and the lower positive charge (positive graupel
 * at -0…-10 °C) never formed (the meteorologist's review 14.10.2026). Since 2.7.2 the model carries its own crystals (ice.ts) and passes them to chargingRate; this estimate is for callers without them.
 */
export function crystalNumber(tc: number, qi = 0, rho = 1) {
  const cooper = Math.min(MAX_CRYSTALS, 5 * Math.exp(.304 * Math.max(0, -tc))), fromMass = rho * qi / (Math.PI / 6 * 900 * CRYSTAL_SIZE ** 3)
  return Math.min(MAX_CRYSTALS, Math.max(cooper, fromMass))
}

/** Mean volume diameter of crystals of mixing ratio qi (kg/kg) in air of density rho at tc °C, m (solid ice spheres), within CRYSTAL_RANGE. */
export function crystalDiameter(qi: number, rho: number, tc: number) {
  return qi > 0 ? Math.min(CRYSTAL_RANGE[1], Math.max(CRYSTAL_RANGE[0], Math.cbrt(6 * rho * qi / (Math.PI * 900 * crystalNumber(tc, qi, rho))))) : 0
}

/** A rimer: an exponential size distribution of intercept n0 (m⁻⁴) and particle density rhoX, fall law V = a D^0.5. */
interface Rimer { n0: number; density: number }
const GRAUPEL: Rimer = { n0: N0G, density: RHO_G }, HAIL: Rimer = { n0: N0H, density: RHO_H }
const CD = .6, GAMMA_45 = 11.6317

/**
 * Charge separation rate at a node, C m⁻³ s⁻¹, gained by the graupel-hail carrier (the ice-snow carrier gets the
 * opposite): every rimer (graupel, hail) meets every crystal kind (cloud ice, snow); the collisions that rebound
 * (1 - exp(0.09 Tc), the sticking efficiency of Lin et al. 1983) each separate collisionCharge. Collisions per m³ and s:
 * N_c E π/4 ∫ (D + d_c)² n(D) dD |V - v_c| with the rimer's mass-weighted fall speed V; the rime accretion rate is the
 * effective water (COLLECTION_EFFICIENCY of the cloud water, g m⁻³) times the impact speed of the charging rimers
 * (V, at most CHARGING_SPEED), which is also the impact speed of the charge per collision. A rimer in wet growth
 * (`wetGraupel`, `wetHail`) does not charge: on its wet surface the crystals stick instead of rebounding.
 * Mixing ratios in kg/kg, rho the air density (kg/m³), snowFall the snow's mass-weighted fall speed (m/s).
 */
export function chargingRate(tc: number, rho: number, cloud: number, ice: number, snow: number, graupel: number, hail: number, snowFall: number, wetGraupel = false, wetHail = false, crystals?: number) {
  if (tc >= 0 || tc < CHARGING_COLDEST || cloud <= 0 || ice + snow <= 0 || graupel + hail <= 0) return 0
  // Called at every mixed-phase node each step: no arrays, two rimers by two crystal kinds written out.
  const rebound = 1 - Math.exp(.09 * tc), water = rho * cloud * 1000
  // The model's own crystals (per m³, plates of their mean mass) when it carries them, else the number estimated from the mass.
  const ni = ice <= 0 ? 0 : crystals ?? crystalNumber(tc, ice, rho)
  const di = ice <= 0 ? 0 : crystals ? Math.min(CRYSTAL_RANGE[1], Math.max(CRYSTAL_RANGE[0], plateSize(rho * ice / crystals))) : crystalDiameter(ice, rho, tc)
  const snowSlope = snow > 0 ? (Math.PI * RHO_S * N0S / (rho * snow)) ** .25 : 0, ns = snow > 0 ? N0S / snowSlope : 0, ds = snow > 0 ? 1 / snowSlope : 0
  let rate = 0
  if (graupel > 0 && !wetGraupel) rate += rimerRate(GRAUPEL, graupel, tc, rho, water, rebound, ni, di, ns, ds, snowFall)
  if (hail > 0 && !wetHail) rate += rimerRate(HAIL, hail, tc, rho, water, rebound, ni, di, ns, ds, snowFall)
  return rate
}

/** One rimer's share of chargingRate: its collisions with the cloud ice (ni per m³ of diameter di, at rest) and the snow (ns, ds, falling at vs). */
function rimerRate(rimer: Rimer, mass: number, tc: number, rho: number, water: number, rebound: number, ni: number, di: number, ns: number, ds: number, vs: number) {
  const lambda = (Math.PI * rimer.density * rimer.n0 / (rho * mass)) ** .25, fall = Math.sqrt(4 * G * rimer.density / (3 * CD * rho)) * GAMMA_45 / 6 / Math.sqrt(lambda)
  const impact = Math.min(fall, CHARGING_SPEED), rar = COLLECTION_EFFICIENCY * water * impact, l2 = lambda * lambda, l3 = l2 * lambda, k = Math.PI / 4 * rimer.n0 * rebound
  let rate = 0
  if (ni > 0) rate += ni * k * (2 / l3 + 2 * di / l2 + di * di / lambda) * fall * collisionCharge(tc, rar, di, impact)
  if (ns > 0) { const v = Math.abs(fall - vs); rate += ns * k * (2 / l3 + 2 * ds / l2 + ds * ds / lambda) * v * collisionCharge(tc, rar, ds, Math.abs(impact - vs)) }
  return rate
}

/**
 * Inductive charging (Sartor 1967; Ziegler et al. 1991, Mansell et al. 2005, by memory: the coefficients may be off by
 * 2-10 times): a rimer polarized by the vertical field ez (V/m, positive upwards) loses charge to the cloud droplets
 * that touch its lower side and rebound. Per rebound the rimer gains (π³/2) ε0 ez <cos θ> d² minus (π²/6) (d/D)² of
 * its own charge; over the population (n0, λ, V = a D^0.5) and the droplets (n_c of diameter d, collection efficiency
 * E_c, rebound probability E_r):
 *   E_c E_r n_c [(π⁴/8) ε0 ez <cos θ> d² a n0 Γ(3.5) / λ^3.5 - (π³/24) d² V ρ_g],
 * ρ_g the rimers' charge density (C/m³), V their mass-weighted fall speed. Under the main negative charge (field
 * upwards) graupel turns positive: it builds the lower positive charge that starts the -CG flashes. ~1 nC/m³ a minute
 * at 50 kV/m in 2 g/m³ of graupel; its own charge relaxes on ~2 minutes. Not in wet growth (no rebounds) nor warmer
 * than 0 °C. C m⁻³ s⁻¹ gained by the graupel-hail carrier (the droplets get the opposite).
 */
export const DROPLET_REBOUND = .01, DROPLET_SIZE = 20e-6, CONTACT_COS = .5
const GAMMA_35 = 3.3234

export function inductiveRate(tc: number, rho: number, cloud: number, graupel: number, hail: number, ez: number, rimerCharge: number, wetGraupel = false, wetHail = false) {
  if (tc >= 0 || cloud <= 0) return 0
  const d = DROPLET_SIZE, droplets = rho * cloud / (Math.PI / 6 * 1000 * d ** 3), k = COLLECTION_EFFICIENCY * DROPLET_REBOUND * droplets
  let polarize = 0, mass = 0, massFall = 0
  for (const [rimer, q, wet] of [[GRAUPEL, graupel, wetGraupel], [HAIL, hail, wetHail]] as const) {
    if (q <= 1e-9 || wet) continue
    const lambda = (Math.PI * rimer.density * rimer.n0 / (rho * q)) ** .25, a = Math.sqrt(4 * G * rimer.density / (3 * CD * rho))
    polarize += Math.PI ** 4 / 8 * EPSILON0 * ez * CONTACT_COS * d * d * a * rimer.n0 * GAMMA_35 / lambda ** 3.5
    mass += q; massFall += q * a * GAMMA_45 / 6 / Math.sqrt(lambda)
  }
  if (mass === 0) return 0
  return k * (polarize - Math.PI ** 3 / 24 * d * d * (massFall / mass) * rimerCharge)
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
