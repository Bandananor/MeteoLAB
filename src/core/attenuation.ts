import { rainKdp } from './polarimetry'

/**
 * Attenuation of the radar beam by precipitation and gases (roadmap E11, step 4; notes .claude/literature/radar-attenuation.md,
 * 03.11.2026). One-way specific attenuation from the rain's KDP, the usual dual-polarisation link: A_H = alpha KDP and
 * A_DP = beta KDP (dB/km, KDP in deg/km at the radar's own wavelength - the model's KDP is for 10.7 cm and scales as
 * 1 / lambda): alpha 0.02 / 0.08 / 0.30 and beta 0.004 / 0.02 / 0.04 for S / C / X (X: Delrieu et al. 2022, AMT 15, 3297;
 * C and S: the defaults of Py-ART, towerpy and wradlib after Bringi & Chandrasekar 2001, Carey et al. 2000 - not read in the
 * originals). Melting graupel and hail (above 0 °C) attenuate as rain of the same mass: an assumption (Borowska et al.
 * 2011 and Ryzhkov et al. 2013 find melting hail attenuates more than rain at C band, by how much the model cannot say);
 * dry snow, graupel and hail - nothing. Gases: ~0.007 / 0.008 / 0.01 dB/km one-way at the ground, falling with height
 * (scale 4 km here; ITU-R P.676 - not verified). The radar sees Z lowered by twice the path-integrated attenuation and
 * ZDR by twice the differential one.
 */
export const ATTENUATION = {
  S: { alpha: .02, beta: .004, gas: .007 },
  C: { alpha: .08, beta: .02, gas: .008 },
  X: { alpha: .30, beta: .04, gas: .01 },
} as const
/** Height scale of the gases' attenuation, m. */
const GAS_SCALE = 4000

/**
 * One-way specific attenuation (dB/km) and differential attenuation (dB/km) at a node: rain and melting graupel and hail
 * mixing ratios (kg/kg) in air of density rho at tc °C, height h (m), for a radar of `band` and wavelength (cm).
 */
export function specificAttenuation(rho: number, rain: number, graupel: number, hail: number, tc: number, h: number, band: 'S' | 'C' | 'X', wavelength: number) {
  const k = ATTENUATION[band], water = rain + (tc > 0 ? graupel + hail : 0)
  const kdp = water > 0 ? rainKdp(rho, water) * 10.7 / wavelength : 0
  return { a: k.alpha * kdp + k.gas * Math.exp(-h / GAS_SCALE), dp: k.beta * kdp }
}
