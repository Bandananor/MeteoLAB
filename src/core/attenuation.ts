import { N0G, RHO_G } from './graupel'
import { N0H, RHO_H } from './hail'
import { mieExtinctionTable, porousIce } from './mie'
import { rainKdp } from './polarimetry'
import { distributionSlope, meltedIntercept, meltedSlope, REFRACTIVE } from './radar'

/**
 * Attenuation of the radar beam by precipitation and gases (roadmap E11, steps 4 and 6; notes
 * .claude/literature/radar-attenuation.md and radar-mie-hail.md). Rain: one-way specific attenuation from its KDP, the
 * usual dual-polarisation link: A_H = alpha KDP and A_DP = beta KDP (dB/km, KDP in deg/km at the radar's own wavelength -
 * the model's KDP is for 10.7 cm and scales as 1 / lambda): alpha 0.02 / 0.08 / 0.30 and beta 0.004 / 0.02 / 0.04 for
 * S / C / X (X: Delrieu et al. 2022, AMT 15, 3297; C and S: the defaults of Py-ART, towerpy and wradlib after Bringi &
 * Chandrasekar 2001, Carey et al. 2000 - not read in the originals). Graupel and hail: the Mie extinction of their
 * exponential distributions of spheres (mie.ts; absorption and scattering - large dry hail at X attenuates by scattering),
 * dry as ice mixed with air, melting (above 0 °C) as drops of their mass like their reflectivity (radar.ts meltedSlope);
 * their differential attenuation - spheres have none - is for melting ice still that of rain of the same mass (an
 * assumption: oblate melting hail does attenuate differentially at C band, Borowska et al. 2011). Gases: ~0.007 / 0.008 /
 * 0.01 dB/km one-way at the ground, falling with height (scale 4 km here; ITU-R P.676 - not verified). The radar sees Z
 * lowered by twice the path-integrated attenuation and ZDR by twice the differential one.
 */
export const ATTENUATION = {
  S: { alpha: .02, beta: .004, gas: .007 },
  C: { alpha: .08, beta: .02, gas: .008 },
  X: { alpha: .30, beta: .04, gas: .01 },
} as const
/** Height scale of the gases' attenuation, m. */
const GAS_SCALE = 4000
/** dB per neper times metres per km: N0 (m^-4) times the extinction integral (m³) is in m^-1. */
const DB_KM = 10 * Math.LOG10E * 1000

type Table = (slope: number) => number
const tables = new Map<string, { graupel: Table; hail: Table; melting: Table }>()
/** The Mie extinction integrals of a radar's band, made on first use. */
function extinction(band: 'S' | 'C' | 'X', wavelength: number) {
  const key = band + wavelength
  let t = tables.get(key)
  if (!t) {
    const m = REFRACTIVE[band]
    t = { graupel: mieExtinctionTable(porousIce(m.ice, RHO_G), wavelength), hail: mieExtinctionTable(porousIce(m.ice, RHO_H), wavelength), melting: mieExtinctionTable(m.melting, wavelength) }
    tables.set(key, t)
  }
  return t
}

/**
 * One-way specific attenuation (dB/km) and differential attenuation (dB/km) at a node: rain, graupel and hail mixing
 * ratios (kg/kg) in air of density rho at tc °C, height h (m), for a radar of `band` and wavelength (cm).
 */
export function specificAttenuation(rho: number, rain: number, graupel: number, hail: number, tc: number, h: number, band: 'S' | 'C' | 'X', wavelength: number) {
  const k = ATTENUATION[band], scale = 10.7 / wavelength
  let a = k.gas * Math.exp(-h / GAS_SCALE), dp = 0
  if (rain > 0) { const kdp = rainKdp(rho, rain) * scale; a += k.alpha * kdp; dp += k.beta * kdp }
  if (graupel > 0 || hail > 0) {
    const t = extinction(band, wavelength), melting = tc > 0
    if (graupel > 0) a += DB_KM * (melting ? meltedIntercept(N0G, RHO_G) * t.melting(meltedSlope(rho * graupel, N0G, RHO_G)) : N0G * t.graupel(distributionSlope(rho * graupel, N0G, RHO_G)))
    if (hail > 0) a += DB_KM * (melting ? meltedIntercept(N0H, RHO_H) * t.melting(meltedSlope(rho * hail, N0H, RHO_H)) : N0H * t.hail(distributionSlope(rho * hail, N0H, RHO_H)))
    if (melting) dp += k.beta * rainKdp(rho, graupel + hail) * scale
  }
  return { a, dp }
}
