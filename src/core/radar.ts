import { graupelFallSpeed, N0G, N0R, RHO_G, RHO_W } from './graupel'
import { hailFallSpeed, N0H, RHO_H } from './hail'
import { N0S, RHO_S, snowFallSpeed } from './ice'
import { fallSpeed } from './microphysics'
import { type Complex, mieRatioTable, porousIce } from './mie'

// Simulated radar reflectivity (Rayleigh scattering, exponential size distributions with the intercepts and densities of
// the model's own microphysics), as in WRF's calc_dbz (Smith 1984): Z = 720 1e18 (rho q)^1.75 / ((pi rho_x)^1.75 N0^0.75)
// mm6/m3, ice scaled by (rho_x / rho_w)^2 and the dielectric ratio |K_ice|^2 / |K_water|^2 = 0.224 unless it is melting
// (above 0 °C its water coat makes it scatter like water: the bright band). For a radar of a given band rain, graupel and
// hail scatter by Mie instead (mie.ts): the Rayleigh factor times the Mie-to-Rayleigh ratio of the same exponential
// distribution of spheres - notes .claude/literature/radar-mie-hail.md (03.11.2026).

/** The radar a reflectivity is for: its band and wavelength, cm (absent - Rayleigh, the model's own reflectivity). */
export interface RadarBand { band: 'S' | 'C' | 'X'; wavelength: number }

/**
 * Refractive indices by band. Water (Liebe et al. 1991 as tabulated in pytmatrix refractive.py; 111 / 53.5 / 33.3 mm):
 * rain at 10 °C, melting graupel and hail at 0 °C. Solid ice (Mätzler 2006: n 1.786 at 0 °C, eps'' 4.8e-4 / 6.2e-4 / 8.9e-4,
 * k = eps'' / 2n), mixed with air by Maxwell Garnett to the species' density.
 */
export const REFRACTIVE: Record<RadarBand['band'], { rain: Complex; melting: Complex; ice: Complex }> = {
  S: { rain: [9.019, .887], melting: [9.075, 1.253], ice: [1.786, 1.3e-4] },
  C: { rain: [8.601, 1.687], melting: [8.328, 2.217], ice: [1.786, 1.7e-4] },
  X: { rain: [7.942, 2.332], melting: [7.351, 2.785], ice: [1.786, 2.5e-4] },
}
type Ratio = (slope: number) => number
interface Ratios { rain: Ratio; graupel: Ratio; hail: Ratio; melting: Ratio }
const ratios = new Map<string, Ratios>()
let lastRadar: RadarBand | undefined, lastRatios: Ratios | undefined
/** The Mie-to-Rayleigh ratios of a radar, made on first use (a few tens of ms). */
function mieRatios(radar: RadarBand): Ratios {
  // Called for every node of a PPI: the same radar object as last time skips the lookup.
  if (radar === lastRadar && lastRatios) return lastRatios
  const { band, wavelength } = radar, key = band + wavelength
  let r = ratios.get(key)
  if (!r) {
    const m = REFRACTIVE[band]
    r = { rain: mieRatioTable(m.rain, wavelength), graupel: mieRatioTable(porousIce(m.ice, RHO_G), wavelength), hail: mieRatioTable(porousIce(m.ice, RHO_H), wavelength), melting: mieRatioTable(m.melting, wavelength) }
    ratios.set(key, r)
  }
  lastRadar = radar; lastRatios = r
  return r
}
/** Slope of an exponential distribution with intercept n0 (m^-4) and particle density rhoX holding rhoQ kg/m3, m^-1. */
export const distributionSlope = (rhoQ: number, n0: number, rhoX: number) => (Math.PI * rhoX * n0 / rhoQ) ** .25
/**
 * Slope of the same particles melted into drops of their mass, m^-1: D_w = D (rhoX / rho_w)^(1/3), so the slope grows by
 * (rho_w / rhoX)^(1/3) and the intercept likewise (meltedIntercept). Melting graupel and hail scatter and attenuate as these
 * water spheres - the Mie form of the Rayleigh rule above, which gives melting ice the water dielectric and its own mass.
 */
export const meltedSlope = (rhoQ: number, n0: number, rhoX: number) => distributionSlope(rhoQ, n0, rhoX) * Math.cbrt(RHO_W / rhoX)
/** Intercept of the melted distribution, m^-4 (meltedSlope). */
export const meltedIntercept = (n0: number, rhoX: number) => n0 * Math.cbrt(RHO_W / rhoX)

/** Dielectric factor of ice relative to water. */
const ICE_DIELECTRIC = .224
/** Reflectivity shown for air without precipitation, dBZ (the radar's noise floor). */
export const DBZ_FLOOR = -20

/** Equivalent reflectivity factor of one species, mm6/m3: mass per volume rhoQ (kg/m3), intercept n0 (m^-4), density rhoX. */
function factor(rhoQ: number, n0: number, rhoX: number) {
  return rhoQ > 0 ? 720e18 * (rhoQ / (Math.PI * rhoX)) ** 1.75 / n0 ** .75 : 0
}

/**
 * Reflectivity factor of rain, snow, graupel and hail separately, mm6/m3 (mixing ratios kg/kg, density rho, temperature
 * tc °C). Rayleigh scattering without `radar`; with it rain, graupel and hail scatter by Mie at its wavelength (melting
 * graupel and hail as drops of their mass, meltedSlope - a rough stand-in for a water-coated sphere; snow stays Rayleigh).
 */
export function speciesZ(rho: number, rain: number, snow: number, graupel: number, tc: number, hail = 0, radar?: RadarBand) {
  const ice = (rhoX: number) => (rhoX / RHO_W) ** 2 * (tc > 0 ? 1 : ICE_DIELECTRIC)
  const z = { rain: factor(rho * rain, N0R, RHO_W), snow: factor(rho * snow, N0S, RHO_S) * ice(RHO_S), graupel: factor(rho * graupel, N0G, RHO_G) * ice(RHO_G), hail: factor(rho * hail, N0H, RHO_H) * ice(RHO_H) }
  if (radar) {
    const r = mieRatios(radar)
    if (z.rain > 0) z.rain *= r.rain(distributionSlope(rho * rain, N0R, RHO_W))
    if (z.graupel > 0) z.graupel *= tc > 0 ? r.melting(meltedSlope(rho * graupel, N0G, RHO_G)) : r.graupel(distributionSlope(rho * graupel, N0G, RHO_G))
    if (z.hail > 0) z.hail *= tc > 0 ? r.melting(meltedSlope(rho * hail, N0H, RHO_H)) : r.hail(distributionSlope(rho * hail, N0H, RHO_H))
  }
  return z
}

/** Radar reflectivity, dBZ, of rain, snow, graupel and hail mixing ratios (kg/kg) in air of density rho at temperature tc (°C). */
export function reflectivity(rho: number, rain: number, snow: number, graupel: number, tc: number, hail = 0, radar?: RadarBand) {
  const s = speciesZ(rho, rain, snow, graupel, tc, hail, radar), z = s.rain + s.snow + s.graupel + s.hail
  return z > 0 ? Math.max(DBZ_FLOOR, 10 * Math.log10(z)) : DBZ_FLOOR
}

/**
 * Reflectivity-weighted fall speed of the precipitation, m/s (what a vertically pointing Doppler radar sees on top of
 * the air's motion); rhoGround is the surface air density of the fall-speed laws.
 */
export function reflectivityFallSpeed(rho: number, rhoGround: number, rain: number, snow: number, graupel: number, tc: number, hail = 0, radar?: RadarBand) {
  const s = speciesZ(rho, rain, snow, graupel, tc, hail, radar), z = s.rain + s.snow + s.graupel + s.hail
  if (!(z > 0)) return 0
  return (s.rain * fallSpeed(rain, rho, rhoGround) + s.snow * snowFallSpeed(snow, rho, rhoGround) + s.graupel * graupelFallSpeed(graupel, rho) + s.hail * hailFallSpeed(hail, rho)) / z
}
