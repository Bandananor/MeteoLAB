import { CP, EPS, LV, RV } from './constants'
import { clamp } from './math'
import { qsatP, saturationAdjust } from './microphysics'

// Ice microphysics, stage 1 (2026-09-29): cloud ice and snow, single-moment, after Lin, Farley & Orville (1983).
// Graupel and hail are stage 2. SI units throughout; the Lin constants are converted from cgs.
// Since 2.7.2 (2026-10-19) the ice comes from processes, not from a share by temperature: crystals nucleate (Cooper
// 1986) and grow by deposition at the expense of the droplets (Bergeron), cloud water stays liquid down to -38 °C and
// freezes at once below (homogeneous freezing); before, the condensate froze linearly from 0 to -40 °C and a
// supercell's core at -20…-30 °C held 0.5 g/m3 of water against 1-3 in nature. Cloud ice carries its number of crystals
// (per kg of air, transported like the mass): from nucleation, rime splintering (Hallett & Mossop 1974) and the frozen
// droplets; with the Cooper number alone the core had almost no crystals warmer than -30 °C and the storms no charge.

/** Latent heat of fusion and of sublimation, J/kg. */
export const LF = 3.34e5, LS = LV + LF
/** Homogeneous freezing of cloud droplets and rain: -38 °C (Pruppacher & Klett 1997). */
export const T0 = 273.15, T_HOMOGENEOUS = 235.15, CW = 4187
/** Primary ice nucleation (Cooper 1986) starts below this temperature, °C; and the most crystals it gives, per m³ (Thompson et al. 2008: 250 per litre). */
export const NUCLEATION_START = -5, MAX_NUCLEATED = 250e3
/** Mass of a freshly nucleated crystal and the largest mean crystal mass of cloud ice (beyond it the ice is snow), kg (Rutledge & Hobbs 1983). */
export const CRYSTAL_MASS = 1e-12, MAX_CRYSTAL_MASS = 9.4e-10
/** Bulk density of a cloud-ice crystal for its size (solid spheres), kg/m³. */
const RHO_I = 900
/** Cloud droplets per m³ that homogeneous freezing turns into as many crystals: droplets of 20 µm (charge.ts DROPLET_SIZE) of the frozen water. */
const DROPLET_MASS = Math.PI / 6 * 1000 * 20e-6 ** 3
/**
 * Rime splintering (Hallett & Mossop 1974): 350 splinters per milligram of rime at -5 °C, falling to none at -3 and
 * -8 °C (Cotton et al. 1986), per kg of rime.
 */
export const SPLINTERS = 3.5e8
export function splintering(tc: number) { return tc >= -3 || tc <= -8 ? 0 : tc > -5 ? (-3 - tc) / 2 : (tc + 8) / 3 }
/**
 * Shattering of freezing raindrops (Lawson et al. 2015: a drop of D µm throws off 2.5e-11 D⁴ fragments, ~25 for 1 mm),
 * per kg of rain frozen, over the exponential rain sizes of slope lambda (1/m) frozen by Bigg's volume law: the drops
 * freeze in proportion to D³ n(D), so the fragments are 2.5e13 ∫D⁷n / (ρ_w π/6 ∫D⁶n) = 2.5e13 · 7 / (λ ρ_w π/6).
 * With rime splintering the secondary ice of a convective cloud (Korolev & Leisner 2020): with the Cooper crystals
 * alone the middle of an ordinary storm had 1-6 crystals per litre, against the 10-100 observed.
 */
export function fragmentsPerKg(lambda: number) { return 2.5e13 * 7 / (lambda * 1000 * Math.PI / 6) }
/** Thermal conductivity of air, W/(m K); vapour diffusivity, m2/s; kinematic viscosity, m2/s; Schmidt number. */
export const KA = 2.43e-2, PSI = 2.26e-5, NU = 1.51e-5, SC = .6
// Snow: exponential size distribution with intercept N0s, bulk density RHO_S, fall law V = C D^D_EXP (Lin 1983:
// c = 152.93 cm^0.75/s, d = 0.25, n0s = 0.03 cm^-4, rho_s = 0.1 g/cm3).
export const N0S = 3e6, RHO_S = 100
const C_S = 152.93 * .01 ** .75, D_S = .25
const GAMMA_3D = 2.5493, GAMMA_4D = 8.2850, GAMMA_5D2 = 1.8712 // Γ(3.25), Γ(4.25), Γ(2.625)
/** Cloud ice above this mixing ratio aggregates into snow (Lin 1983), kg/kg. */
export const ICE_AUTOCONVERSION_THRESHOLD = .001

/** Saturation mixing ratio over ice (Alduchov & Eskridge 1996 fit), t in °C, p in Pa; over water at and above 0 °C. */
export function qsatIce(t: number, p: number) {
  if (t >= 0) return qsatP(t, p)
  const es = 611.21 * Math.exp(22.587 * t / (t + 273.86))
  return clamp(EPS * es / Math.max(1000, p - es), 0, .045)
}

/** Crystals per m³ from primary nucleation at tc °C (Cooper 1986, 5 exp(0.304 (T0 - T))), none above NUCLEATION_START, at most MAX_NUCLEATED. */
export function cooperCrystals(tc: number) { return tc >= NUCLEATION_START ? 0 : Math.min(MAX_NUCLEATED, 5 * Math.exp(.304 * -tc)) }

/** Slope of the snow size distribution, 1/m. */
function snowSlope(snow: number, rho: number) { return (Math.PI * RHO_S * N0S / (rho * snow)) ** .25 }

/** Mass-weighted fall speed of snow, m/s: c Γ(4+d)/6 λ^-d sqrt(rho_ground / rho) (~1 m/s at 1 g/m3). */
export function snowFallSpeed(snow: number, rho: number, rhoGround: number) {
  return snow > 1e-9 ? C_S * GAMMA_4D / 6 * snowSlope(snow, rho) ** -D_S * Math.sqrt(rhoGround / rho) : 0
}

/**
 * Saturation adjustment at cell i: cloud water condenses and evaporates at water saturation (L_v) from 0 °C down to
 * -38 °C (supercooled droplets); cloud ice above 0 °C melts into it (L_f). Below -38 °C the droplets freeze at once and
 * the vapour deposits on the ice and sublimates from it at ice saturation (L_s). Between 0 and -38 °C the ice exchanges
 * vapour only through iceProcesses (nucleation, deposition, sublimation). Returns the vapour condensed or deposited
 * (negative: evaporated or sublimated).
 */
export function saturationAdjustMixed(theta: Float32Array, q: Float32Array, cloud: Float32Array, ice: Float32Array, i: number, exner: number, p: number, number?: Float32Array) {
  const heat = LF / (CP * exner)
  if (theta[i] * exner >= T_HOMOGENEOUS) {
    if (ice[i] > 0 && theta[i] * exner > T0) {
      // Never cools the air below 0 °C; the crystals go with their mass.
      const melt = Math.min(ice[i], (theta[i] * exner - T0) * CP / LF)
      if (number) number[i] *= 1 - melt / ice[i]
      ice[i] -= melt; cloud[i] += melt; theta[i] -= heat * melt
    }
    return saturationAdjust(theta, q, cloud, i, exner, p)
  }
  // Each frozen droplet is a crystal.
  if (cloud[i] > 0) { if (number) number[i] += cloud[i] / DROPLET_MASS; ice[i] += cloud[i]; theta[i] += heat * cloud[i]; cloud[i] = 0 }
  let total = 0
  for (let k = 0; k < 2; k++) {
    const tk = theta[i] * exner, qs = qsatIce(tk - T0, p)
    let d = (q[i] - qs) / (1 + LS * LS * qs / (CP * RV * tk * tk))
    if (d < 0) d = Math.max(d, -ice[i])
    if (d === 0) break
    q[i] -= d; ice[i] += d; theta[i] += LS / (CP * exner) * d; total += d
  }
  return total
}

/** Rain below -38 °C freezes at once (homogeneous freezing) into graupel, releasing L_f; warmer, Bigg's freezing in graupelProcesses. */
export function freezeRain(theta: Float32Array, rain: Float32Array, graupel: Float32Array, i: number, exner: number) {
  const r = rain[i]
  if (r <= 0 || theta[i] * exner >= T_HOMOGENEOUS) return
  rain[i] = 0; graupel[i] += r; theta[i] += LF / (CP * exner) * r
}

/** Mean diameter of the cloud-ice crystals, m: n crystals per m³ of qi kg/kg in air of density rho, solid spheres. */
export function crystalSize(qi: number, n: number, rho: number) { return Math.cbrt(6 * rho * qi / (Math.PI * RHO_I * n)) }

/**
 * Size of a crystal of mass m (kg) as a hexagonal plate, m: m = 0.00739 D^2.45 in g and cm (Mitchell 1996). A plate is
 * wider than a sphere of the same mass (~100 µm against 60 at 1e-10 kg): the size the charging per collision uses.
 */
export function plateSize(m: number) { return .01 * (m * 1000 / .00739) ** (1 / 2.45) }

// Growth of one crystal at water saturation, dm/dt = a1 m^a2 in g and g/s (Koenig 1971; the table of the Goddard scheme
// in WRF), by whole degrees from -1 to -31 °C: fastest at -15 °C (dendrites) with a second peak at -5 (needles), slowest
// at -8…-10 and below -20 (columns, thick plates). A sphere of the same mass grows evenly at all temperatures.
const KOENIG_A1 = [.7939e-7, .7841e-6, .3369e-5, .4336e-5, .5285e-5, .3728e-5, .1852e-5, .2991e-6, .4248e-6, .7434e-6, .1812e-5, .4394e-5, .9145e-5, .1725e-4, .3348e-4,
  .1725e-4, .9175e-5, .4412e-5, .2252e-5, .9115e-6, .4876e-6, .3473e-6, .4758e-6, .6306e-6, .8573e-6, .7868e-6, .7192e-6, .6513e-6, .5956e-6, .5333e-6, .4834e-6]
const KOENIG_A2 = [.4006, .4831, .5320, .5307, .5319, .5249, .4888, .3894, .4047, .4318, .4771, .5183, .5463, .5651, .5813,
  .5655, .5478, .5203, .4906, .4447, .4126, .3960, .4149, .4320, .4506, .4483, .4460, .4433, .4413, .4382, .4361]

/** Growth of one crystal of mass m (kg) at water saturation at tc °C, kg/s (Koenig 1971; between the whole degrees by interpolation, -31 °C below). */
export function koenigGrowth(tc: number, m: number) {
  const x = clamp(-tc, 1, 31) - 1, k = Math.min(29, Math.floor(x)), f = x - k, g = m * 1000
  return 1e-3 * ((1 - f) * KOENIG_A1[k] * g ** KOENIG_A2[k] + f * KOENIG_A1[k + 1] * g ** KOENIG_A2[k + 1])
}

/**
 * Cloud ice between 0 and -38 °C at cell i over dt, the source of the ice instead of a share by temperature
 * (Rutledge & Hobbs 1983; the Cooper 1986 number as in Thompson et al. 2008), with `number` the crystals per kg of air:
 * - nucleation: in air supersaturated over ice, crystals are added up to the Cooper number, each of CRYSTAL_MASS;
 * - deposition: each crystal grows at its habit's rate at water saturation (koenigGrowth), scaled by the supersaturation
 *   over ice as a share of water saturation's; in a cloud the vapour is held at water saturation, so the crystals grow
 *   at the droplets' expense (the Bergeron process: the adjustment after evaporates the droplets to make up the
 *   vapour). Never past ice saturation;
 * - sublimation: each crystal (a sphere, capacitance D/2) loses 2 π D (1 - S_i) / (A + B), with A = L_s² / (K_a R_v T²)
 *   and B = 1 / (rho q_si ψ), never more than the ice; sublimating crystals vanish with their mass;
 * - conversion to snow: the cloud ice beyond MAX_CRYSTAL_MASS per crystal has grown into snow (the largest crystals:
 *   the number stays with the many small ones).
 * Every phase change takes or gives its latent heat. Returns the cooling of theta by sublimation, K, for the cold-pool
 * indicator.
 */
export function iceProcesses(theta: Float32Array, q: Float32Array, ice: Float32Array, snow: Float32Array, number: Float32Array, i: number, exner: number, p: number, rho: number, dt: number) {
  const tk = theta[i] * exner, tc = tk - T0
  if (tc >= 0 || tk < T_HOMOGENEOUS) return 0
  const qsi = qsatIce(tc, p), limit = (q[i] - qsi) / (1 + LS * LS * qsi / (CP * RV * tk * tk)), heat = LS / (CP * exner), lacking = cooperCrystals(tc) / rho - number[i]
  let change = 0
  if (limit > 0 && lacking > 0) { change = Math.min(limit, lacking * CRYSTAL_MASS); number[i] += change / CRYSTAL_MASS }
  const qi = ice[i] + change, n = number[i]
  if (qi > 1e-12 && n > 0) {
    if (q[i] > qsi) change += Math.min(n * koenigGrowth(tc, qi / n) * (q[i] - qsi) / (qsatP(tc, p) - qsi) * dt, limit - change)
    else {
      const a = LS * LS / (KA * RV * tk * tk), b = 1 / (rho * qsi * PSI)
      const lost = Math.min(qi, n * 2 * Math.PI * crystalSize(qi, n * rho, rho) * (1 - q[i] / qsi) / (a + b) * dt)
      change -= lost; number[i] *= 1 - lost / qi
    }
  }
  ice[i] += change; q[i] -= change; theta[i] += heat * change
  const excess = ice[i] - number[i] * MAX_CRYSTAL_MASS
  if (excess > 0) { ice[i] -= excess; snow[i] += excess }
  return change < 0 ? -heat * change : 0
}

/** Keeps the crystals between one of the largest mass per ice and one of the nucleated mass (the transport moves mass and number apart a little); none without ice. */
export function settleCrystals(ice: Float32Array, number: Float32Array, i: number) {
  const qi = ice[i]
  number[i] = qi > 1e-12 ? Math.min(qi / CRYSTAL_MASS, Math.max(qi / MAX_CRYSTAL_MASS, number[i])) : 0
}

/**
 * Snow processes at cell i over dt (Lin et al. 1983): below 0 °C cloud ice aggregates into snow (P_saut, P_saci),
 * snow rimes cloud water (P_sacw, freezing it) and grows or sublimates by vapour diffusion (P_sdep); above 0 °C snow
 * melts into rain (P_smlt, with the heat carried by the rimed water) and the water it collects becomes rain. Every
 * phase change takes or gives its latent heat. Returns the cooling of theta, K (melting and sublimation), for the
 * cold-pool indicator.
 */
export function snowProcesses(theta: Float32Array, q: Float32Array, cloud: Float32Array, ice: Float32Array, snow: Float32Array, rain: Float32Array,
  i: number, exner: number, p: number, rho: number, rhoGround: number, dt: number) {
  const tk = theta[i] * exner, tc = tk - T0, qs = snow[i]
  if (tc < 0 && ice[i] > 0) {
    // Aggregation of cloud ice into snow; efficiency exp(0.025 Tc).
    const auto = 1e-3 * Math.exp(.025 * tc) * Math.max(0, ice[i] - ICE_AUTOCONVERSION_THRESHOLD)
    const moved = Math.min(ice[i], auto * dt); ice[i] -= moved; snow[i] += moved
  }
  if (qs <= 1e-9) return 0
  const lambda = snowSlope(qs, rho), fall = Math.sqrt(rhoGround / rho)
  // Collection kernel of snow sweeping out small particles: pi n0s c Γ(3+d) / (4 λ^(3+d)) sqrt(rho_g/rho), 1/s.
  const sweep = Math.PI * N0S * C_S * GAMMA_3D / (4 * lambda ** (3 + D_S)) * fall
  // Ventilated diffusion factor of the distribution, m^-2: n0s [0.78 λ^-2 + 0.31 Sc^(1/3) Γ((d+5)/2) c^0.5 (rho_g/rho)^0.25 ν^-0.5 λ^-(d+5)/2].
  const vent = N0S * (.78 / (lambda * lambda) + .31 * SC ** (1 / 3) * GAMMA_5D2 * Math.sqrt(C_S) * fall ** .5 / Math.sqrt(NU) * lambda ** (-(D_S + 5) / 2))
  let cooling = 0
  if (tc < 0) {
    const saci = Math.min(ice[i], sweep * Math.exp(.025 * tc) * ice[i] * dt); ice[i] -= saci; snow[i] += saci
    const sacw = Math.min(cloud[i], sweep * cloud[i] * dt); cloud[i] -= sacw; snow[i] += sacw
    theta[i] += LF / (CP * exner) * sacw
    const qsi = qsatIce(tc, p), a = LS * LS / (KA * RV * tk * tk), b = 1 / (rho * qsi * PSI)
    const rate = 2 * Math.PI * (q[i] / qsi - 1) * vent / (rho * (a + b))
    // Deposition never past ice saturation; sublimation never more than the snow.
    const dep = rate > 0 ? Math.min(rate * dt, (q[i] - qsi) / (1 + LS * LS * qsi / (CP * RV * tk * tk))) : -Math.min(snow[i], -rate * dt)
    snow[i] += dep; q[i] -= dep; theta[i] += LS / (CP * exner) * dep
    if (dep < 0) cooling -= LS / (CP * exner) * dep
  } else {
    const sacw = Math.min(cloud[i], sweep * cloud[i] * dt); cloud[i] -= sacw; rain[i] += sacw
    const rate = 2 * Math.PI * KA * tc * vent / (rho * LF) + CW * tc / LF * sweep * cloud[i]
    // Never cools the air below 0 °C: L_f melt / c_p <= Tc.
    const melt = Math.min(snow[i], rate * dt, CP * tc / LF)
    snow[i] -= melt; rain[i] += melt; theta[i] -= LF / (CP * exner) * melt; cooling += LF / (CP * exner) * melt
  }
  return cooling
}
