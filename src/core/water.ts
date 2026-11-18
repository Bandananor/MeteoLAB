import { LV } from './constants'
import type { AtmosphereModel } from './model'

// The domain's water budget (3.0 block Ж, step 3; for lessons): where the water the storm moved has gone. The model
// counts the flows as it steps (AtmosphereModel.water: the microphysics' condensation and deposition, what it gave back to
// vapour, rain's share of that, the ground's evaporation); the reservoirs are summed from the fields here. In a periodic
// domain nothing leaves through the edges, so the reservoirs' change matches the flows up to the transport's small
// errors and the pulls towards a profile (relaxed edges, zones, fronts, the sponge), shown as the remainder.

export type WaterSource = Pick<AtmosphereModel, 'grid' | 'env' | 'q' | 'cloud' | 'ice' | 'rain' | 'snow' | 'graupel' | 'hail' | 'precipitation' | 'water' | 'added'>

export interface WaterBudget {
  /** The reservoirs' sum at the start, kg (AtmosphereModel.water.start). */
  start: number
  /** Flows since the start, kg: vapour turned into cloud and ice; vapour given back (of it rain's evaporation); the ground's evaporation; vapour put in by hand. */
  condensed: number; evaporated: number; rainEvaporated: number; surface: number; added: number
  /** Reservoirs now, kg: vapour above the environment's profile (negative: drier); cloud water and ice; rain, snow, graupel and hail aloft; precipitation on the ground. */
  vapour: number; condensate: number; aloft: number; ground: number
  /** Precipitation efficiency: on the ground / condensed (0 before any condensation). */
  efficiency: number
  /** Latent heat released, J: L (condensed - evaporated); deposition counted with L of vaporisation (a lower bound). */
  latent: number
  /** What the flows do not explain, kg: (start + surface + added) - (vapour + condensate + aloft + ground); the pulls and the transport's errors. */
  remainder: number
}

/** The reservoirs (kg): vapour above the environment's profile, condensate, precipitation aloft and on the ground. */
function reservoirs(m: Omit<WaterSource, 'water' | 'added'>) {
  const { nx, ny, nz, dx, dy, hz, layer } = m.grid, rho = m.env.rho, qEnv = m.env.q
  let vapour = 0, condensate = 0, aloft = 0
  for (let z = 0; z < nz; z++) {
    const mass = rho[z] * dx * dy * hz[z], q0 = qEnv[z]
    let v = 0, c = 0, a = 0
    for (let i = z * layer, e = i + layer; i < e; i++) { v += m.q[i] - q0; c += m.cloud[i] + m.ice[i]; a += m.rain[i] + m.snow[i] + m.graupel[i] + m.hail[i] }
    vapour += v * mass; condensate += c * mass; aloft += a * mass
  }
  let ground = 0
  for (let c = 0; c < nx * ny; c++) ground += m.precipitation[c]
  ground *= dx * dy
  return { vapour, condensate, aloft, ground }
}

/** The reservoirs' sum (kg): what the model keeps as its start. */
export function waterReservoirs(m: Omit<WaterSource, 'water' | 'added'>) { const r = reservoirs(m); return r.vapour + r.condensate + r.aloft + r.ground }

/** The budget of a model (or the page's mirror of it) now. */
export function waterBudget(m: WaterSource): WaterBudget {
  const { vapour, condensate, aloft, ground } = reservoirs(m), w = m.water, added = m.added.vapour
  return {
    ...w, added, vapour, condensate, aloft, ground,
    efficiency: w.condensed > 0 ? ground / w.condensed : 0,
    latent: LV * (w.condensed - w.evaporated),
    remainder: w.start + w.surface + added - (vapour + condensate + aloft + ground),
  }
}
