export type SurfaceType = 'grass' | 'dry' | 'water' | 'urban'

export interface SimConfig {
  surfaceTemp: number; lapseLow: number; lapseMid: number; lapseUpper: number; tropopause: number; stratoWarming: number
  rhSurface: number; rhLow: number; rhMid: number; rhUpper: number; entrainment: number
  wind0: number; wind3: number; wind6: number; wind10: number; windDir0: number; windDir3: number; windDir6: number; windDir10: number
  latitude: number; turbulence: number; hour: number; solarMax: number; soilMoisture: number; surfaceType: SurfaceType
  precipEfficiency: number; evaporation: number; coldPoolStrength: number; speed: number; seed: number; bubble: number
}

export const SURFACES: Record<SurfaceType, { albedo: number; sensible: number; evap: number; inertia: number }> = {
  grass: { albedo: .2, sensible: .42, evap: .75, inertia: .65 },
  dry: { albedo: .3, sensible: .72, evap: .15, inertia: .45 },
  water: { albedo: .08, sensible: .18, evap: 1.25, inertia: 1.8 },
  urban: { albedo: .16, sensible: .78, evap: .08, inertia: .8 },
}
