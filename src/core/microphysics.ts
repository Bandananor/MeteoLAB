import { CP, EPS, LV, RV } from './constants'
import { clamp } from './math'

/** Saturation mixing ratio over water (Bolton's Tetens fit), t in °C, p in Pa. */
export function qsatP(t: number, p: number) { const es = 611.2 * Math.exp(17.67 * t / (t + 243.5)); return clamp(EPS * es / Math.max(1000, p - es), 0, .045) }

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
