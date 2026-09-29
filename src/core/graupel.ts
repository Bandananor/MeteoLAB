import { CP, G, RV } from './constants'
import { CW, KA, LF, LS, NU, PSI, qsatIce, SC, T0 } from './ice'

// Ice microphysics, stage 2 (2026-09-29, not yet wired into the model): graupel after Lin, Farley & Orville (1983).
// Exponential size distribution with intercept N0G and density RHO_G; fall law V = (4 g rho_g D / (3 C_D rho))^0.5.
const N0G = 4e4, RHO_G = 400, CD = .6
// Rain distribution of the Lin scheme (for the freezing of rain) and the Bigg (1953) freezing constants B', A'.
const N0R = 8e6, RHO_W = 1000, BIGG_B = 100, BIGG_A = .66
const GAMMA_45 = 11.6317, GAMMA_35 = 3.3234, GAMMA_275 = 1.6084 // Γ(4.5), Γ(3.5), Γ(2.75)
/** Snow above this mixing ratio turns into graupel as it rimes (Lin 1983), kg/kg. */
export const SNOW_TO_GRAUPEL_THRESHOLD = 6e-4

/** Slope of the graupel size distribution, 1/m. */
function graupelSlope(graupel: number, rho: number) { return (Math.PI * RHO_G * N0G / (rho * graupel)) ** .25 }
/** Coefficient a of the fall law V = a D^0.5, m^0.5/s. */
function fallCoefficient(rho: number) { return Math.sqrt(4 * G * RHO_G / (3 * CD * rho)) }

/** Mass-weighted fall speed of graupel, m/s: a Γ(4.5)/6 λ^-0.5 (~8 m/s at 1 g/m3). */
export function graupelFallSpeed(graupel: number, rho: number) {
  return graupel > 1e-9 ? fallCoefficient(rho) * GAMMA_45 / 6 * graupelSlope(graupel, rho) ** -.5 : 0
}

/**
 * Graupel processes at cell i over dt (Lin et al. 1983). Below 0 °C: rain freezes into graupel (P_gfr, Bigg's
 * stochastic freezing, fast below about -15 °C), rimed snow turns into graupel (P_gaut), graupel sweeps out cloud water
 * and rain (freezing them, P_gacw, P_gacr), cloud ice (P_gaci, efficiency 0.1) and snow (P_gacs, efficiency
 * exp(0.09 Tc)), and sublimates in air subsaturated over ice (P_gsub). Above 0 °C graupel melts into rain (P_gmlt, with
 * the heat carried by the water it collects), and the water it collects is shed as rain. Collection of rain and snow
 * uses the same sweep-out kernel as cloud water (the relative fall speed is not resolved). Returns the cooling of
 * theta, K (melting and sublimation), for the cold-pool indicator.
 */
export function graupelProcesses(theta: Float32Array, q: Float32Array, cloud: Float32Array, ice: Float32Array, snow: Float32Array, rain: Float32Array,
  graupel: Float32Array, i: number, exner: number, p: number, rho: number, dt: number) {
  const tk = theta[i] * exner, tc = tk - T0, heat = 1 / (CP * exner)
  let cooling = 0
  if (tc < 0) {
    if (rain[i] > 1e-9) {
      const lambdaR = (Math.PI * RHO_W * N0R / (rho * rain[i])) ** .25
      const rate = 20 * Math.PI * Math.PI * BIGG_B * N0R * RHO_W / rho * (Math.exp(-BIGG_A * tc) - 1) / lambdaR ** 7
      const frozen = Math.min(rain[i], rate * dt); rain[i] -= frozen; graupel[i] += frozen; theta[i] += LF * heat * frozen
    }
    const auto = Math.min(snow[i], 1e-3 * Math.exp(.09 * tc) * Math.max(0, snow[i] - SNOW_TO_GRAUPEL_THRESHOLD) * dt)
    snow[i] -= auto; graupel[i] += auto
  }
  const qg = graupel[i]
  if (qg <= 1e-9) return 0
  const lambda = graupelSlope(qg, rho), a = fallCoefficient(rho)
  // Sweep-out kernel pi n0g a Γ(3.5) / (4 λ^3.5), 1/s, and the ventilated diffusion factor n0g [0.78 λ^-2 + ...], m^-2.
  const sweep = Math.PI * N0G * a * GAMMA_35 / (4 * lambda ** 3.5)
  const vent = N0G * (.78 / (lambda * lambda) + .31 * SC ** (1 / 3) * GAMMA_275 * Math.sqrt(a / NU) * lambda ** -2.75)
  if (tc < 0) {
    const gacw = Math.min(cloud[i], sweep * cloud[i] * dt), gacr = Math.min(rain[i], sweep * rain[i] * dt)
    const gaci = Math.min(ice[i], sweep * .1 * ice[i] * dt), gacs = Math.min(snow[i], sweep * Math.exp(.09 * tc) * snow[i] * dt)
    cloud[i] -= gacw; rain[i] -= gacr; ice[i] -= gaci; snow[i] -= gacs; graupel[i] += gacw + gacr + gaci + gacs
    theta[i] += LF * heat * (gacw + gacr)
    const qsi = qsatIce(tc, p)
    if (q[i] < qsi) {
      const aa = LS * LS / (KA * RV * tk * tk), b = 1 / (rho * qsi * PSI)
      const sub = Math.min(graupel[i], 2 * Math.PI * (1 - q[i] / qsi) * vent / (rho * (aa + b)) * dt, (qsi - q[i]) / (1 + LS * LS * qsi / (CP * RV * tk * tk)))
      graupel[i] -= sub; q[i] += sub; theta[i] -= LS * heat * sub; cooling += LS * heat * sub
    }
  } else {
    const gacw = Math.min(cloud[i], sweep * cloud[i] * dt); cloud[i] -= gacw; rain[i] += gacw
    const rate = 2 * Math.PI * KA * tc * vent / (rho * LF) + CW * tc / LF * sweep * (cloud[i] + rain[i])
    // Never cools the air below 0 °C.
    const melt = Math.min(graupel[i], rate * dt, CP * tc / LF)
    graupel[i] -= melt; rain[i] += melt; theta[i] -= LF * heat * melt; cooling += LF * heat * melt
  }
  return cooling
}
