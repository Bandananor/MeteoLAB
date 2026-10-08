import { graupelFallSpeed, N0G, N0R, RHO_G, RHO_W } from './graupel'
import { hailFallSpeed, N0H, RHO_H } from './hail'
import { N0S, RHO_S, snowFallSpeed } from './ice'
import { fallSpeed } from './microphysics'

// Simulated radar reflectivity (Rayleigh scattering, exponential size distributions with the intercepts and densities of
// the model's own microphysics), as in WRF's calc_dbz (Smith 1984): Z = 720 1e18 (rho q)^1.75 / ((pi rho_x)^1.75 N0^0.75)
// mm6/m3, ice scaled by (rho_x / rho_w)^2 and the dielectric ratio |K_ice|^2 / |K_water|^2 = 0.224 unless it is melting
// (above 0 °C its water coat makes it scatter like water: the bright band).

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
 * tc °C). Rayleigh scattering throughout: for centimetre hail at S band it overstates Z by a few dB (Mie).
 */
export function speciesZ(rho: number, rain: number, snow: number, graupel: number, tc: number, hail = 0) {
  const ice = (rhoX: number) => (rhoX / RHO_W) ** 2 * (tc > 0 ? 1 : ICE_DIELECTRIC)
  return { rain: factor(rho * rain, N0R, RHO_W), snow: factor(rho * snow, N0S, RHO_S) * ice(RHO_S), graupel: factor(rho * graupel, N0G, RHO_G) * ice(RHO_G), hail: factor(rho * hail, N0H, RHO_H) * ice(RHO_H) }
}

/** Radar reflectivity, dBZ, of rain, snow, graupel and hail mixing ratios (kg/kg) in air of density rho at temperature tc (°C). */
export function reflectivity(rho: number, rain: number, snow: number, graupel: number, tc: number, hail = 0) {
  const s = speciesZ(rho, rain, snow, graupel, tc, hail), z = s.rain + s.snow + s.graupel + s.hail
  return z > 0 ? Math.max(DBZ_FLOOR, 10 * Math.log10(z)) : DBZ_FLOOR
}

/**
 * Reflectivity-weighted fall speed of the precipitation, m/s (what a vertically pointing Doppler radar sees on top of
 * the air's motion); rhoGround is the surface air density of the fall-speed laws.
 */
export function reflectivityFallSpeed(rho: number, rhoGround: number, rain: number, snow: number, graupel: number, tc: number, hail = 0) {
  const s = speciesZ(rho, rain, snow, graupel, tc, hail), z = s.rain + s.snow + s.graupel + s.hail
  if (!(z > 0)) return 0
  return (s.rain * fallSpeed(rain, rho, rhoGround) + s.snow * snowFallSpeed(snow, rho, rhoGround) + s.graupel * graupelFallSpeed(graupel, rho) + s.hail * hailFallSpeed(hail, rho)) / z
}
