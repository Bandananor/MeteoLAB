import { CP, EPS, LV, RV } from './constants'
import { clamp } from './math'
import { qsatP } from './microphysics'

// Ice microphysics, stage 1 (2026-09-29): cloud ice and snow, single-moment, after
// Lin, Farley & Orville (1983) with the mixed-phase saturation adjustment of Tao, Simpson & McCumber (1989).
// Graupel and hail are stage 2. SI units throughout; the Lin constants are converted from cgs.

/** Latent heat of fusion and of sublimation, J/kg. */
export const LF = 3.34e5, LS = LV + LF
export const T0 = 273.15, T_HOMOGENEOUS = 233.15, CW = 4187
/** Thermal conductivity of air, W/(m K); vapour diffusivity, m2/s; kinematic viscosity, m2/s; Schmidt number. */
export const KA = 2.43e-2, PSI = 2.26e-5, NU = 1.51e-5, SC = .6
// Snow: exponential size distribution with intercept N0s, bulk density RHO_S, fall law V = C D^D_EXP (Lin 1983:
// c = 152.93 cm^0.75/s, d = 0.25, n0s = 0.03 cm^-4, rho_s = 0.1 g/cm3).
const N0S = 3e6, RHO_S = 100, C_S = 152.93 * .01 ** .75, D_S = .25
const GAMMA_3D = 2.5493, GAMMA_4D = 8.2850, GAMMA_5D2 = 1.8712 // Γ(3.25), Γ(4.25), Γ(2.625)
/** Cloud ice above this mixing ratio aggregates into snow (Lin 1983), kg/kg. */
export const ICE_AUTOCONVERSION_THRESHOLD = .001

/** Saturation mixing ratio over ice (Alduchov & Eskridge 1996 fit), t in °C, p in Pa; over water at and above 0 °C. */
export function qsatIce(t: number, p: number) {
  if (t >= 0) return qsatP(t, p)
  const es = 611.21 * Math.exp(22.587 * t / (t + 273.86))
  return clamp(EPS * es / Math.max(1000, p - es), 0, .045)
}

/** Share of the cloud condensate that is ice: 0 at 0 °C and above, 1 at -40 °C (homogeneous freezing) and below. */
export function iceFraction(tk: number) { return clamp((T0 - tk) / (T0 - T_HOMOGENEOUS), 0, 1) }

/** Slope of the snow size distribution, 1/m. */
function snowSlope(snow: number, rho: number) { return (Math.PI * RHO_S * N0S / (rho * snow)) ** .25 }

/** Mass-weighted fall speed of snow, m/s: c Γ(4+d)/6 λ^-d sqrt(rho_ground / rho) (~1 m/s at 1 g/m3). */
export function snowFallSpeed(snow: number, rho: number, rhoGround: number) {
  return snow > 1e-9 ? C_S * GAMMA_4D / 6 * snowSlope(snow, rho) ** -D_S * Math.sqrt(rhoGround / rho) : 0
}

/**
 * Mixed-phase saturation adjustment at cell i (Tao et al. 1989): the vapour is brought to the saturation mixing ratio
 * of the mixture, (1 - f) q_s,water + f q_s,ice with f = iceFraction(T); condensate appears as cloud water (L_v) and
 * evaporates from cloud water and ice in proportion (L_v and L_s). Then the cloud condensate is split between water
 * and ice by f, freezing (or melting) the difference with L_f. Returns the vapour condensed (negative: evaporated).
 */
export function saturationAdjustMixed(theta: Float32Array, q: Float32Array, cloud: Float32Array, ice: Float32Array, i: number, exner: number, p: number) {
  let total = 0
  // The partition inside the loop: the heat of fusion of new ice changes T, f and the saturation value in turn.
  for (let k = 0; k < 3; k++) {
    partitionCondensate(theta, cloud, ice, i, exner)
    const tk = theta[i] * exner, t = tk - 273.15, f = iceFraction(tk)
    const qs = (1 - f) * qsatP(t, p) + f * qsatIce(t, p), l = (1 - f) * LV + f * LS
    let d = (q[i] - qs) / (1 + l * l * qs / (CP * RV * tk * tk))
    const condensate = cloud[i] + ice[i]
    if (d < 0) d = Math.max(d, -condensate)
    // Nothing to condense or evaporate (clear, subsaturated air): the partition above already settled the condensate.
    if (d === 0) break
    if (d > 0) { cloud[i] += d; theta[i] += LV / (CP * exner) * d }
    else {
      const fromIce = condensate > 0 ? d * ice[i] / condensate : 0, fromCloud = d - fromIce
      cloud[i] += fromCloud; ice[i] += fromIce; theta[i] += (LV * fromCloud + LS * fromIce) / (CP * exner)
    }
    q[i] -= d; total += d
  }
  partitionCondensate(theta, cloud, ice, i, exner)
  return total
}

/** Rain below -40 °C freezes at once (homogeneous freezing) into snow, releasing L_f; graupel is stage 2. */
export function freezeRain(theta: Float32Array, rain: Float32Array, snow: Float32Array, i: number, exner: number) {
  const r = rain[i]
  if (r <= 0 || theta[i] * exner >= T_HOMOGENEOUS) return
  rain[i] = 0; snow[i] += r; theta[i] += LF / (CP * exner) * r
}

/** Splits the cloud condensate into water and ice by iceFraction(T), with the heat of fusion; returns the mass frozen. */
export function partitionCondensate(theta: Float32Array, cloud: Float32Array, ice: Float32Array, i: number, exner: number) {
  const target = iceFraction(theta[i] * exner) * (cloud[i] + ice[i]), frozen = target - ice[i]
  if (frozen === 0) return 0
  ice[i] += frozen; cloud[i] -= frozen; theta[i] += LF / (CP * exner) * frozen
  return frozen
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
