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
  /**
   * The domain moves with the storm (default, absent = true): the model works in a frame moving at domainMotion(env), so
   * the storm stays inside instead of leaving on one side and coming back on the other into its own cold pool.
   */
  followStorm?: boolean
  /** Domain size (absent = 'standard'): 48 x 36 km, or 96 x 72 km at the same resolution (about 4x slower). */
  domain?: 'standard' | 'large'
  latitude: number; turbulence: number; hour: number; solarMax: number; soilMoisture: number; surfaceType: SurfaceType
  speed: number; seed: number; bubble: number
  /** Horizontal e-folding radius of the starting thermals, km (absent = 4.2: a broad thermal, ~8 km across). */
  bubbleRadius?: number
  /**
   * A maintained stationary front (K; 0 or absent = none): north of the domain's middle line, from the western edge to
   * 60 % of the width (it ends there over ~3 km), the air near the ground is kept this much colder (fading out by 1.5 km, a 3 km transition), by relaxation with a 30 min time scale on the cold
   * side only — large-scale forcing standing in for the synoptic flow that holds a real front in place. The storm's own
   * outflow still spreads freely. The front ends inside the domain so the cells that train along it leave its end and
   * decay there, not in the side zone (with a front through the whole domain the rain piled up at the eastern zone). Replaces the starting thermals by a row of weak ones on the warm side of the front.
   */
  front?: number
  /**
   * Side boundaries (absent = 'periodic'): what leaves on one side comes back on the other; or 'relaxed': in a 12 km
   * zone along the domain's edges the air is pulled back to the environment (theta — with the front, if any —, vapour and wind to the profile,
   * w, cloud and precipitation to zero), so the storm takes in fresh environmental air instead of its own outflow and
   * anvil coming round — for long runs of large systems (the quasi-stationary MCS).
   */
  edges?: 'periodic' | 'relaxed'
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
