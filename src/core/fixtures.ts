// Shared configurations and helpers for the core tests.
import type { SimConfig } from './config'
import type { AtmosphereModel } from './model'

export const SUMMER_DAY: SimConfig = {
  surfaceTemp: 30, lapseLow: 8.4, lapseMid: 7.2, lapseUpper: 6.5, tropopause: 11, stratoWarming: 1.2,
  rhSurface: 72, rhLow: 60, rhMid: 42, rhUpper: 28,
  wind0: 2, wind3: 10, wind6: 20, wind10: 28, windDir0: 160, windDir3: 185, windDir6: 215, windDir10: 235,
  latitude: 45, turbulence: .55, hour: 13.5, solarMax: 1000, soilMoisture: 45, surfaceType: 'grass',
  speed: 8, seed: 42, bubble: 1,
}

export const SUPERCELL: SimConfig = {
  ...SUMMER_DAY, surfaceTemp: 29, rhSurface: 72, rhLow: 60, rhMid: 38, rhUpper: 30, lapseLow: 7.2, lapseMid: 6.8, lapseUpper: 6.5,
  bubble: 1.8, wind0: 6, wind3: 12, wind6: 20, wind10: 28, windDir0: 140, windDir3: 200, windDir6: 240, windDir10: 255,
}

/** Conditionally unstable but convection-free without a trigger: a moderate CAPE profile with a cap. */
export const CAPPED: SimConfig = { ...SUMMER_DAY, surfaceTemp: 28, rhSurface: 62, rhLow: 50, rhMid: 40, rhUpper: 30, lapseLow: 6.0, lapseMid: 7.5, lapseUpper: 6.5 }

/** Stable, unsaturated, sunless and without a bubble: nothing should happen above the ground. */
export const QUIET: SimConfig = {
  ...SUMMER_DAY, lapseLow: 6, lapseMid: 6, lapseUpper: 6, rhSurface: 50, rhLow: 40, rhMid: 30, rhUpper: 20,
  solarMax: 0, bubble: 0,
}

export function run(model: AtmosphereModel, seconds: number) {
  for (let k = 0; k < seconds; k++) { model.step(1); model.time += 1 }
}

/** Horizontal mean of a field at level z. */
export function levelMean(model: AtmosphereModel, field: Float32Array, z: number) {
  const { layer } = model.grid
  let sum = 0
  for (let i = z * layer; i < (z + 1) * layer; i++) sum += field[i]
  return sum / layer
}

/**
 * Total water (vapour + cloud + rain) in the air plus the rain that has reached the ground, kg per m2 of ground:
 * mixing ratios weighted by the base-state density, which the anelastic flow conserves.
 */
export function totalWater(model: AtmosphereModel) {
  const { nz, layer } = model.grid, rho = model.env.rho
  let total = 0
  for (let z = 0; z < nz; z++) {
    const weight = model.grid.hz[z] * rho[z]
    let level = 0
    for (let i = z * layer; i < (z + 1) * layer; i++) level += model.q[i] + model.cloud[i] + model.ice[i] + model.rain[i] + model.snow[i] + model.graupel[i]
    total += weight * level / layer
  }
  let fallen = 0
  for (let i = 0; i < layer; i++) fallen += model.precipitation[i]
  return total + fallen / layer
}
