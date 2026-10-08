import { CP, G, LV, RV } from './constants'
import { N0G, RHO_G } from './graupel'
import { CW, KA, LF, LS, NU, PSI, qsatIce, SC, T0 } from './ice'
import { qsatP } from './microphysics'

// Ice microphysics, stage 3 (2026-10-08): hail as its own class, after the hail of Lin, Farley & Orville (1983):
// solid ice (RHO_H), exponential sizes with intercept N0H, fall law V = (4 g rho_h D / (3 C_D rho))^0.5 — at the
// same mass ~1.35x as fast as graupel ((900 / 400)^0.375), and faster still as hail cores hold more mass. Hail is born from graupel in wet growth: when graupel sweeps out more
// supercooled water than the heat it can lose (conduction and evaporation from a 0 °C surface) can freeze, its surface
// turns wet and it grows into dense hail (as in three-ice schemes: Ferrier 1994, Milbrandt & Yau 2005). Hail itself
// grows dry or wet (in wet growth it freezes what it can and sheds the rest as rain), sublimates and melts.
export const N0H = 4e4, RHO_H = 900
const CD = .6, CI = 2106
const GAMMA_45 = 11.6317, GAMMA_35 = 3.3234, GAMMA_275 = 1.6084 // Γ(4.5), Γ(3.5), Γ(2.75)
/** Graupel in wet growth turns into hail on this time scale, s. */
export const HAIL_CONVERSION_TIME = 60
/** The "largest hailstone": the size exceeded by one stone in this volume, m3 (a fixed-intercept scheme has no tail of its own). */
export const HAIL_SAMPLE_VOLUME = 10

/** Slope of an exponential size distribution of mass content rho q (intercept n0, particle density rhoX), 1/m. */
const slope = (q: number, rho: number, n0: number, rhoX: number) => (Math.PI * rhoX * n0 / (rho * q)) ** .25
/** Coefficient a of the fall law V = a D^0.5 of a particle of density rhoX, m^0.5/s. */
const fallCoefficient = (rho: number, rhoX: number) => Math.sqrt(4 * G * rhoX / (3 * CD * rho))
/** Sweep-out kernel pi n0 a Γ(3.5) / (4 λ^3.5), 1/s: the share of a field collected per second (efficiency 1). */
const sweep = (lambda: number, a: number, n0: number) => Math.PI * n0 * a * GAMMA_35 / (4 * lambda ** 3.5)
/** Ventilated diffusion factor n0 [0.78 λ^-2 + 0.31 Sc^1/3 Γ(2.75) (a/ν)^0.5 λ^-2.75], m^-2. */
const ventilation = (lambda: number, a: number, n0: number) => n0 * (.78 / (lambda * lambda) + .31 * SC ** (1 / 3) * GAMMA_275 * Math.sqrt(a / NU) * lambda ** -2.75)

/** Mass-weighted fall speed of hail, m/s: a Γ(4.5)/6 λ^-0.5 (~12 m/s at 1 g/m3, ~16 at 5 g/m3 near the ground). */
export function hailFallSpeed(hail: number, rho: number) {
  return hail > 1e-9 ? fallCoefficient(rho, RHO_H) * GAMMA_45 / 6 * slope(hail, rho, N0H, RHO_H) ** -.5 : 0
}

/** Diameter of the largest hailstones, m: one stone in HAIL_SAMPLE_VOLUME is larger (N0/λ e^(-λD) = 1/V). */
export function hailMaxDiameter(hail: number, rho: number) {
  if (!(hail > 1e-9)) return 0
  const lambda = slope(hail, rho, N0H, RHO_H)
  return Math.max(0, Math.log(N0H * HAIL_SAMPLE_VOLUME / lambda) / lambda)
}

/**
 * Wet-growth rate (Lin 1983, eq. 43), kg/kg/s: the most collected water a particle population can freeze, limited by the
 * heat its 0 °C surface loses to the colder air by conduction and evaporation, each kilogram of collected water giving
 * L_f - c_w |T_c|; collected ice (iceRate) needs no freezing and adds its own cooling.
 */
function wetGrowth(lambda: number, a: number, n0: number, tc: number, qv: number, p: number, rho: number, iceRate: number) {
  const heat = KA * -tc + LV * PSI * rho * (qsatP(0, p) - qv)
  return Math.max(0, 2 * Math.PI * ventilation(lambda, a, n0) * heat / (rho * (LF + CW * tc))) + iceRate * (1 - CI * tc / (LF + CW * tc))
}

/**
 * Hail processes at cell i over dt. Below 0 °C: graupel in wet growth turns into hail (1/HAIL_CONVERSION_TIME); hail
 * sweeps out cloud water, rain, cloud ice and snow (ice efficiency 0.1, snow exp(0.09 Tc); both 1 when wet) — all of it
 * freezes in dry growth; in wet growth hail grows at the wet-growth rate and sheds the unfrozen water as rain; hail
 * sublimates in air subsaturated over ice. Above 0 °C it melts into rain (with the heat of the water it collects) and
 * sheds the cloud water it collects. Returns the cooling of theta, K (melting and sublimation), for the cold-pool indicator.
 */
export function hailProcesses(theta: Float32Array, q: Float32Array, cloud: Float32Array, ice: Float32Array, snow: Float32Array, rain: Float32Array,
  graupel: Float32Array, hail: Float32Array, i: number, exner: number, p: number, rho: number, dt: number) {
  const tk = theta[i] * exner, tc = tk - T0, heat = 1 / (CP * exner)
  let cooling = 0
  if (tc < 0 && graupel[i] > 1e-9) {
    const lambda = slope(graupel[i], rho, N0G, RHO_G), a = fallCoefficient(rho, RHO_G), k = sweep(lambda, a, N0G)
    const dry = k * (cloud[i] + rain[i] + .1 * ice[i] + Math.exp(.09 * tc) * snow[i])
    if (dry > wetGrowth(lambda, a, N0G, tc, q[i], p, rho, k * (ice[i] + snow[i]))) {
      const turned = graupel[i] * (1 - Math.exp(-dt / HAIL_CONVERSION_TIME)); graupel[i] -= turned; hail[i] += turned
    }
  }
  const qh = hail[i]
  if (qh <= 1e-9) return 0
  const lambda = slope(qh, rho, N0H, RHO_H), a = fallCoefficient(rho, RHO_H), k = sweep(lambda, a, N0H), vent = ventilation(lambda, a, N0H)
  if (tc < 0) {
    const hacw = Math.min(cloud[i], k * cloud[i] * dt), hacr = Math.min(rain[i], k * rain[i] * dt), liquid = hacw + hacr
    let haci = Math.min(ice[i], k * .1 * ice[i] * dt), hacs = Math.min(snow[i], k * Math.exp(.09 * tc) * snow[i] * dt), frozen = liquid
    const wet = wetGrowth(lambda, a, N0H, tc, q[i], p, rho, k * (ice[i] + snow[i])) * dt
    if (liquid + haci + hacs > wet) {
      // Wet: ice and snow stick (efficiency 1); only what the surface can freeze stays, the rest is shed as rain.
      haci = Math.min(ice[i], k * ice[i] * dt); hacs = Math.min(snow[i], k * snow[i] * dt)
      frozen = Math.min(liquid, Math.max(0, wet - haci - hacs))
    }
    cloud[i] -= hacw; rain[i] += liquid - frozen - hacr; ice[i] -= haci; snow[i] -= hacs; hail[i] += frozen + haci + hacs
    theta[i] += LF * heat * frozen
    const qsi = qsatIce(tc, p)
    if (q[i] < qsi) {
      const aa = LS * LS / (KA * RV * tk * tk), b = 1 / (rho * qsi * PSI)
      const sub = Math.min(hail[i], 2 * Math.PI * (1 - q[i] / qsi) * vent / (rho * (aa + b)) * dt, (qsi - q[i]) / (1 + LS * LS * qsi / (CP * RV * tk * tk)))
      hail[i] -= sub; q[i] += sub; theta[i] -= LS * heat * sub; cooling += LS * heat * sub
    }
  } else {
    const hacw = Math.min(cloud[i], k * cloud[i] * dt); cloud[i] -= hacw; rain[i] += hacw
    const rate = 2 * Math.PI * KA * tc * vent / (rho * LF) + CW * tc / LF * k * (cloud[i] + rain[i])
    // Never cools the air below 0 °C.
    const melt = Math.min(hail[i], rate * dt, CP * tc / LF)
    hail[i] -= melt; rain[i] += melt; theta[i] -= LF * heat * melt; cooling += LF * heat * melt
  }
  return cooling
}
