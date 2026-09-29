import { SURFACES, type SimConfig } from './config'
import { clamp } from './math'
import { insolation } from './solar'

/**
 * Neutral drag coefficient (kappa / ln(z_ref / z0))^2 of the ground node: z_ref is the middle of the half layer the
 * ground node owns (dz / 4, ~160 m on the default grid), z0 the surface roughness.
 */
export function dragCoefficient(config: SimConfig, dz: number) { return (.4 / Math.log(dz / 4 / SURFACES[config.surfaceType].roughness)) ** 2 }

/** Net longwave loss of a sunlit surface, W/m2 (fixed; night-time cooling is not modelled). */
export const LONGWAVE_LOSS = 90

export interface SurfaceFluxes {
  /** Shortwave absorbed by the surface, W/m2. */ absorbed: number
  /** Net radiation minus ground storage, shared between the two turbulent fluxes, W/m2. */ available: number
  /** Sensible heat flux H, W/m2. */ sensible: number
  /** Latent heat flux LE, W/m2. */ latent: number
}

/**
 * Surface energy balance: absorbed = LONGWAVE_LOSS + storage + H + LE. The evaporative fraction is the wet-surface
 * share (1 - sensible) times the moisture availability, and whatever does not evaporate heats the air.
 */
export function surfaceFluxes(config: SimConfig, time: number): SurfaceFluxes {
  const s = SURFACES[config.surfaceType], absorbed = insolation(config, time) * (1 - s.albedo)
  const available = Math.max(0, absorbed - LONGWAVE_LOSS) * (1 - s.storage)
  const moisture = config.surfaceType === 'water' ? 1 : clamp(s.evap * config.soilMoisture / 45)
  const latent = available * (1 - s.sensible) * moisture
  return { absorbed, available, sensible: available - latent, latent }
}
