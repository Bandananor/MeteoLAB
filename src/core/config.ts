export type SurfaceType = 'grass' | 'dry' | 'water' | 'urban'

export interface SimConfig {
  surfaceTemp: number; lapseLow: number; lapseMid: number; lapseUpper: number; tropopause: number; stratoWarming: number
  rhSurface: number; rhLow: number; rhMid: number; rhUpper: number
  wind0: number; wind3: number; wind6: number; wind10: number; windDir0: number; windDir3: number; windDir6: number; windDir10: number
  latitude: number; turbulence: number; hour: number; solarMax: number; soilMoisture: number; surfaceType: SurfaceType
  speed: number; seed: number; bubble: number
}

/**
 * Surface properties: shortwave albedo; share of the available energy that goes into sensible heat when the surface is
 * fully wet (`sensible`); moisture availability at 45 % soil moisture (`evap`, water is always fully wet); share of the
 * net radiation stored in the ground or water (`storage`).
 */
export const SURFACES: Record<SurfaceType, { albedo: number; sensible: number; evap: number; storage: number }> = {
  grass: { albedo: .2, sensible: .42, evap: .75, storage: .1 },
  dry: { albedo: .3, sensible: .72, evap: .15, storage: .15 },
  water: { albedo: .08, sensible: .18, evap: 1, storage: .5 },
  urban: { albedo: .16, sensible: .78, evap: .08, storage: .3 },
}
