import { CP, EPS, LV, RV } from './constants'
import { clamp } from './math'

/** Saturation mixing ratio over water (Bolton's Tetens fit), t in °C, p in Pa. */
export function qsatP(t: number, p: number) { const es = 611.2 * Math.exp(17.67 * t / (t + 243.5)); return clamp(EPS * es / Math.max(1000, p - es), 0, .045) }

// Kessler (1969) warm rain as in Klemp & Wilhelmson (1978) and CM1: densities in the formulas are in g/cm3 (0.001 rho).
/** Cloud water above this mixing ratio turns into rain (autoconversion threshold), kg/kg. */
export const AUTOCONVERSION_THRESHOLD = .001
/** Autoconversion rate above the threshold, 1/s. */
export const AUTOCONVERSION_RATE = .001

/** Terminal fall speed of rain, m/s: 36.34 (0.001 rho qr)^0.1364 sqrt(rho_ground / rho). */
export function fallSpeed(rain: number, rho: number, rhoGround: number) {
  return rain > 0 ? 36.34 * (.001 * rho * rain) ** .1364 * Math.sqrt(rhoGround / rho) : 0
}

/**
 * Rain processes at cell i over dt: autoconversion and accretion move cloud water to rain, rain evaporates in
 * subsaturated air (never past saturation). Returns the evaporated rain; the caller applies the latent cooling.
 */
export function rainProcesses(q: Float32Array, cloud: Float32Array, rain: Float32Array, i: number, tk: number, p: number, rho: number, dt: number) {
  const qc = cloud[i], qr = rain[i]
  const rate = AUTOCONVERSION_RATE * Math.max(0, qc - AUTOCONVERSION_THRESHOLD) + (qr > 0 ? 2.2 * qc * qr ** .875 : 0)
  const production = Math.min(qc, rate * dt)
  cloud[i] -= production; rain[i] += production
  const qs = qsatP(tk - 273.15, p)
  if (rain[i] <= 0 || q[i] >= qs) return 0
  const rq = .001 * rho * rain[i], ventilation = 1.6 + 124.9 * rq ** .2046
  const er = (1 - q[i] / qs) * ventilation * rq ** .525 / (.001 * rho * (5.4e5 + 2.55e6 / (p / 100 * qs)))
  const evaporation = Math.min(rain[i], er * dt, (qs - q[i]) / (1 + LV * LV * qs / (CP * RV * tk * tk)))
  rain[i] -= evaporation; q[i] += evaporation
  return evaporation
}

/**
 * Saturation adjustment at cell i: condenses the excess vapour or evaporates cloud water until the air is exactly
 * saturated (or the cloud is gone), releasing or taking the latent heat. Newton steps on q - q_s(T) with
 * dq_s/dT = L q_s / (Rv T^2); two steps leave |q - q_s| below 1e-4 q_s. Returns the condensed mass (negative: evaporated).
 */
export function saturationAdjust(theta: Float32Array, q: Float32Array, cloud: Float32Array, i: number, exner: number, p: number) {
  let total = 0
  for (let k = 0; k < 2; k++) {
    const tk = theta[i] * exner, qs = qsatP(tk - 273.15, p)
    let d = (q[i] - qs) / (1 + LV * LV * qs / (CP * RV * tk * tk))
    if (d < 0) d = Math.max(d, -cloud[i])
    if (d === 0) break
    q[i] -= d; cloud[i] += d; theta[i] += LV / (CP * exner) * d; total += d
  }
  return total
}
