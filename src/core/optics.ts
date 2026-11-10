import { clamp } from './math'

// The condensate in visible light, one set for the model's cloud shadows (model.ts updateShade) and the satellite's
// visible channel (satellite.ts). Until 10.11.2026 the satellite had its own numbers (ice 55, snow 5, rain 1.5, graupel 1
// m2/kg and the plain two-stream reflectance tau / (tau + 13.3)), so a cloud the satellite showed did not shade the
// ground as it looked.

/**
 * Visible mass extinction of the condensate, m2/kg (roadmap B10): 3 / (2 rho_particle r_e) — cloud water 150 (r_e 10 um;
 * Chou-Suarez and Slingo give 158-159), ice 80 (r_e ~30 um, Chou-Suarez / Ebert & Curry), snow 10 (Fu's 6-16 for r_e
 * 250-100 um), rain 3 (Chou 1999), graupel 4 (geometric optics, 400 kg/m3, r_e 1 mm), hail 0.3 (900 kg/m3, r_e 5 mm;
 * the shadows took graupel's 4 for it until 10.11.2026).
 */
export const EXTINCTION = { cloud: 150, ice: 80, snow: 10, rain: 3, graupel: 4, hail: .3 }
/** Asymmetry factor of the cloud's scattering (delta-Eddington scales it, see sunlightThrough). */
export const ASYMMETRY = .85

/**
 * The share of the sunlight (direct and diffuse) a non-absorbing cloud lets through: the delta-Eddington two-stream
 * solution for single-scattering albedo 1 (Joseph, Wiscombe & Weinman 1976; Meador & Weaver 1980, eq. 24), vertical
 * optical depth tau, the sun's zenith cosine mu. An anvil of tau 10 lets ~60 % through with the sun high, a
 * cumulonimbus core (tau 200-1000) 1-5 % — WRF's Dudhia (1989) tables give 5-8 % for 1-10 kg/m2 of water.
 */
export function sunlightThrough(tau: number, mu: number) {
  if (tau <= 0) return 1
  const f = ASYMMETRY * ASYMMETRY, g = ASYMMETRY / (1 + ASYMMETRY), t = (1 - f) * tau
  const g1 = .75 * (1 - g), g3 = (2 - 3 * g * mu) / 4
  return clamp(1 - (g1 * t + (g3 - g1 * mu) * (1 - Math.exp(-t / mu))) / (1 + g1 * t))
}

/** Reflectance of a cloud of optical depth tau under a sun of zenith cosine mu: what it does not let through (no absorption). */
export const cloudReflectance = (tau: number, mu = 1) => 1 - sunlightThrough(tau, mu)
