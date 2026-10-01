import { N0G, N0R, RHO_G, RHO_W } from './graupel'
import { N0S, RHO_S } from './ice'

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

/** Radar reflectivity, dBZ, of rain, snow and graupel mixing ratios (kg/kg) in air of density rho at temperature tc (°C). */
export function reflectivity(rho: number, rain: number, snow: number, graupel: number, tc: number) {
  const ice = (rhoX: number) => (rhoX / RHO_W) ** 2 * (tc > 0 ? 1 : ICE_DIELECTRIC)
  const z = factor(rho * rain, N0R, RHO_W) + factor(rho * snow, N0S, RHO_S) * ice(RHO_S) + factor(rho * graupel, N0G, RHO_G) * ice(RHO_G)
  return z > 0 ? Math.max(DBZ_FLOOR, 10 * Math.log10(z)) : DBZ_FLOOR
}
