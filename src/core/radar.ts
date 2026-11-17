import { graupelFallSpeed, N0G, N0R, RHO_G, RHO_W } from './graupel'
import { hailFallSpeed, N0H, RHO_H } from './hail'
import { N0S, RHO_S, snowFallSpeed } from './ice'
import { fallSpeed } from './microphysics'
import { dnOf, fallSpeedZ, meanVolume, RAIN_MIN } from './rain2m'
import { boundedIceNumber, characteristic, densityOf, gammaFn, GRAUPEL_2M, HAIL_2M, type IceClass, meanVolumeOf, momentSpeed } from './ice2m'

/**
 * The second moments at a node (two-moment microphysics, per kg of air): drops; graupel and hail particles and their
 * volume. A plain number is the drop number alone (two-moment rain only). Absent: one-moment, fixed intercepts.
 */
export interface Moments { rainNumber?: number; graupelNumber?: number; graupelVolume?: number; hailNumber?: number; hailVolume?: number }
/** The fields of the second moments (any of them may be absent). */
export interface MomentFields { rainNumber?: ArrayLike<number>; graupelNumber?: ArrayLike<number>; graupelVolume?: ArrayLike<number>; hailNumber?: ArrayLike<number>; hailVolume?: ArrayLike<number> }
const atNode: Moments = {}
/** The moments at node i (one object reused: read it before the next call). */
export function momentsAt(f: MomentFields, i: number): Moments {
  atNode.rainNumber = f.rainNumber?.[i]; atNode.graupelNumber = f.graupelNumber?.[i]; atNode.graupelVolume = f.graupelVolume?.[i]; atNode.hailNumber = f.hailNumber?.[i]; atNode.hailVolume = f.hailVolume?.[i]
  return atNode
}
const momentsOf = (m?: Moments | number): Moments | undefined => typeof m === 'number' ? { rainNumber: m } : m

/**
 * A two-moment ice class's Rayleigh reflectivity factor (mm6/m3, before the dielectric and density factors) and its
 * slope 1/Dn (m^-1): N Dn^6 Γ(7+α) / Γ(1+α) of the gamma distribution, and its density. Null without the class.
 */
function iceZ(c: IceClass, rho: number, q: number, n?: number, vol?: number) {
  if (!(q > 1e-12) || !(n !== undefined && n > 0)) return null
  const v = vol ?? 0, rhoX = densityOf(c, q, v), nb = boundedIceNumber(c, q, n, v), dn = characteristic(c, meanVolumeOf(c, q, nb, rhoX))
  return { z: 1e18 * rho * nb * dn ** 6 * gammaFn(7 + c.alpha) / gammaFn(1 + c.alpha), slope: 1 / dn, rhoX, q, nb, vol: v }
}
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

/**
 * The intercept (m^-4) of rain with `number` drops per kg (two-moment rain, rain2m.ts: exponential, N0 = rho N / Dn), or
 * Marshall-Palmer's without a number (one-moment rain).
 */
export function rainIntercept2m(rho: number, rain: number, number?: number) {
  return number !== undefined && number > 0 && rain > RAIN_MIN ? rho * number / dnOf(meanVolume(rain, number)) : N0R
}

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
export function speciesZ(rho: number, rain: number, snow: number, graupel: number, tc: number, hail = 0, radar?: RadarBand, moments?: Moments | number) {
  const m = momentsOf(moments), ice = (rhoX: number) => (rhoX / RHO_W) ** 2 * (tc > 0 ? 1 : ICE_DIELECTRIC), n0r = rainIntercept2m(rho, rain, m?.rainNumber)
  // Two-moment graupel and hail: their own gamma distributions and densities (ice2m.ts).
  const g2 = iceZ(GRAUPEL_2M, rho, graupel, m?.graupelNumber, m?.graupelVolume), h2 = iceZ(HAIL_2M, rho, hail, m?.hailNumber, m?.hailVolume)
  const z = { rain: factor(rho * rain, n0r, RHO_W), snow: factor(rho * snow, N0S, RHO_S) * ice(RHO_S),
    graupel: g2 ? g2.z * ice(g2.rhoX) : factor(rho * graupel, N0G, RHO_G) * ice(RHO_G), hail: h2 ? h2.z * ice(h2.rhoX) : factor(rho * hail, N0H, RHO_H) * ice(RHO_H) }
  if (radar) {
    const r = mieRatios(radar)
    if (z.rain > 0) z.rain *= r.rain(distributionSlope(rho * rain, n0r, RHO_W))
    // Two-moment: the Mie ratio of the class's tables at the slope 1/Dn (melted: as drops of the particles' mass); the
    // tables are for exponential distributions of 400 and 900 kg/m3, an approximation for other densities and hail's α 1.
    const melted = (x: { slope: number; rhoX: number }) => x.slope * Math.cbrt(RHO_W / x.rhoX)
    if (z.graupel > 0) z.graupel *= tc > 0 ? r.melting(g2 ? melted(g2) : meltedSlope(rho * graupel, N0G, RHO_G)) : r.graupel(g2 ? g2.slope : distributionSlope(rho * graupel, N0G, RHO_G))
    if (z.hail > 0) z.hail *= tc > 0 ? r.melting(h2 ? melted(h2) : meltedSlope(rho * hail, N0H, RHO_H)) : r.hail(h2 ? h2.slope : distributionSlope(rho * hail, N0H, RHO_H))
  }
  return z
}

/**
 * Radar reflectivity, dBZ, of rain, snow, graupel and hail mixing ratios (kg/kg) in air of density rho at temperature tc
 * (°C); `rainNumber`: drops per kg of two-moment rain (absent or 0: Marshall-Palmer).
 */
export function reflectivity(rho: number, rain: number, snow: number, graupel: number, tc: number, hail = 0, radar?: RadarBand, moments?: Moments | number) {
  const s = speciesZ(rho, rain, snow, graupel, tc, hail, radar, moments), z = s.rain + s.snow + s.graupel + s.hail
  return z > 0 ? Math.max(DBZ_FLOOR, 10 * Math.log10(z)) : DBZ_FLOOR
}

/**
 * Reflectivity-weighted fall speed of the precipitation, m/s (what a vertically pointing Doppler radar sees on top of
 * the air's motion); rhoGround is the surface air density of the fall-speed laws.
 */
export function reflectivityFallSpeed(rho: number, rhoGround: number, rain: number, snow: number, graupel: number, tc: number, hail = 0, radar?: RadarBand, moments?: Moments | number) {
  const m = momentsOf(moments), s = speciesZ(rho, rain, snow, graupel, tc, hail, radar, m), z = s.rain + s.snow + s.graupel + s.hail
  if (!(z > 0)) return 0
  const rainSpeed = m?.rainNumber !== undefined && m.rainNumber > 0 ? fallSpeedZ(rain, m.rainNumber, rho) : fallSpeed(rain, rho, rhoGround)
  const graupelSpeed = m?.graupelNumber ? momentSpeed(GRAUPEL_2M, graupel, m.graupelNumber, m.graupelVolume ?? 0, rho, 6) : graupelFallSpeed(graupel, rho)
  const hailSpeed = m?.hailNumber ? momentSpeed(HAIL_2M, hail, m.hailNumber, m.hailVolume ?? 0, rho, 6) : hailFallSpeed(hail, rho)
  return (s.rain * rainSpeed + s.snow * snowFallSpeed(snow, rho, rhoGround) + s.graupel * graupelSpeed + s.hail * hailSpeed) / z
}
