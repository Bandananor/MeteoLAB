export type SurfaceType = 'grass' | 'dry' | 'water' | 'urban'

export interface SimConfig {
  surfaceTemp: number; lapseLow: number; lapseMid: number; lapseUpper: number; tropopause: number; stratoWarming: number
  rhSurface: number; rhLow: number; rhMid: number; rhUpper: number
  wind0: number; wind3: number; wind6: number; wind10: number; windDir0: number; windDir3: number; windDir6: number; windDir10: number
  /** Optional wind nodes at 0.5 and 1 km (speed, direction) for a curved low-level hodograph; absent nodes are skipped. */
  wind05?: number; wind1?: number; windDir05?: number; windDir1?: number
  /**
   * Optional capping inversion (the lid over a "loaded gun" boundary layer): base height, km, and the temperature rise
   * across it, K (0 or absent = no cap). Above the inversion the extra warmth fades out over 2 km, giving the steep
   * lapse rate of an elevated mixed layer.
   */
  capHeight?: number; capStrength?: number
  /** Optional depth of a well-mixed moist boundary layer, km: the surface mixing ratio holds up to it (0 or absent = off). */
  moistLayer?: number
  /** Microphysics; overrides AtmosphereModel.microphysics (default with ice) when set (the UI switch). */
  microphysics?: 'warm' | 'ice'
  /** Transport scheme; overrides AtmosphereModel.transport (default WENO) when set (the UI switch). */
  transport?: 'semi-lagrangian' | 'weno'
  /** An analytic environment instead of the slider profile: 'weisman-klemp' (WK82 sounding, 16 g/kg, quarter-circle hodograph, one thermal). */
  profile?: 'weisman-klemp'
  latitude: number; turbulence: number; hour: number; solarMax: number; soilMoisture: number; surfaceType: SurfaceType
  speed: number; seed: number; bubble: number
}

/**
 * Surface properties: shortwave albedo; share of the available energy that goes into sensible heat when the surface is
 * fully wet (`sensible`); moisture availability at 45 % soil moisture (`evap`, water is always fully wet); share of the
 * net radiation stored in the ground or water (`storage`); aerodynamic roughness length (`roughness`, m).
 */
export const SURFACES: Record<SurfaceType, { albedo: number; sensible: number; evap: number; storage: number; roughness: number }> = {
  grass: { albedo: .2, sensible: .42, evap: .75, storage: .1, roughness: .03 },
  dry: { albedo: .3, sensible: .72, evap: .15, storage: .15, roughness: .01 },
  water: { albedo: .08, sensible: .18, evap: 1, storage: .5, roughness: .0002 },
  urban: { albedo: .16, sensible: .78, evap: .08, storage: .3, roughness: 1 },
}
