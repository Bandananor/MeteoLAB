import type { Environment } from './environment'
import { effectiveLayer, heightOf, type ParcelIndices } from './sounding'

/** An effective layer of one level still has this depth for its SRH, m. */
const EFFECTIVE_STEP_MIN = 100

export interface StormIndices {
  /** Bunkers right-mover motion (u, v), m/s. */ rightMover: readonly [number, number]
  /** Bunkers left-mover motion (u, v), m/s. */ leftMover: readonly [number, number]
  /** Storm-relative helicity for the right mover, m2/s2. */ srh01: number; srh03: number
  /** Bulk wind difference 0-6 km, m/s. */ shear06: number
  /** Supercell composite parameter (MUCAPE, SRH 0-3 km, bulk shear 0-6 km). */ scp: number
  /** Significant tornado parameter, fixed layer (SBCAPE, SB LCL, SRH 0-1 km, bulk shear 0-6 km). */ stp: number
  /** Significant hail parameter (MUCAPE, the MU parcel's mixing ratio, 700-500 hPa lapse rate, T at 500 hPa, bulk shear 0-6 km). */ ship: number
  /** Temperature lapse rate between 700 and 500 hPa, °C/km. */ lapse75: number
  /** Derecho composite parameter (DCAPE, MUCAPE, bulk shear and mean wind 0-6 km). */ dcp: number
  /**
   * The effective inflow layer (sounding.ts effectiveLayer), base and top m, with its SRH (m²/s², the right mover) and
   * the effective bulk shear (m/s, from its base to half the MU parcel's EL), as SPC; null without one (no storms to feed).
   */
  effective: { base: number; top: number; srh: number; shear: number } | null
}

/**
 * Derecho composite parameter (Evans & Doswell 2001, as SPC): DCAPE / 980 J/kg × MUCAPE / 2000 J/kg × 0-6 km shear / 20 kt ×
 * 0-6 km mean wind / 16 kt. Above 2 — cold pools strong enough and a flow fast enough for a long-lived wind storm (a
 * derecho or a bow echo) once storms organize into a line; it says nothing of whether they will.
 */
export const derechoParameter = (dcape: number, muCape: number, shear06: number, meanWind06: number) => dcape / 980 * (muCape / 2000) * (shear06 / 10.29) * (meanWind06 / 8.23)

/**
 * Significant hail parameter, SPC's version 1.1 (Johnson & Sugden 2014): MUCAPE (J/kg) × the MU parcel's mixing ratio
 * (g/kg, within 11-13.6) × the 700-500 hPa lapse rate (°C/km) × -T500 (°C, at least 5.5) × 0-6 km shear (m/s, within
 * 7-27) / 42 000 000, scaled down by MUCAPE below 1300 J/kg, the lapse rate below 5.8 °C/km and the freezing level
 * below 2400 m. Above 1 — hail of 5 cm and larger becomes likely (the tester's 2023 day of 7-8 cm stones: ~3).
 */
export function hailParameter(muCape: number, muMixing: number, lapse75: number, t500: number, shear06: number, freezing: number) {
  let ship = muCape * clamp(muMixing * 1000, 11, 13.6) * lapse75 * -Math.min(t500, -5.5) * clamp(shear06, 7, 27) / 42e6
  if (muCape < 1300) ship *= muCape / 1300
  if (lapse75 < 5.8) ship *= lapse75 / 5.8
  if (freezing < 2400) ship *= Math.max(0, freezing) / 2400
  return Math.max(0, ship)
}

const STEP = 10
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))

/** Pressure-weighted mean wind between z0 and z1 (m), trapezoidal in pressure, as MetPy's weighted_continuous_average. */
function meanWind(env: Environment, z0: number, z1: number) {
  let u = 0, v = 0, weight = 0, [ua, va] = env.windUV(z0), pa = env.pressureAt(z0)
  for (let z = z0 + STEP; z <= z1 + 1e-6; z += STEP) {
    const [ub, vb] = env.windUV(z), pb = env.pressureAt(z), dp = pa - pb
    u += (ua + ub) / 2 * dp; v += (va + vb) / 2 * dp; weight += dp; ua = ub; va = vb; pa = pb
  }
  return [u / weight, v / weight] as const
}

/** Storm-relative helicity of the layer bottom..top (m) for a storm moving at (cu, cv): -sum over layers of (V - c) x dV. */
function helicity(env: Environment, top: number, cu: number, cv: number, bottom = 0) {
  let srh = 0, [u0, v0] = env.windUV(bottom)
  for (let z = bottom + STEP; z <= top + 1e-6; z += STEP) {
    const [u1, v1] = env.windUV(z)
    srh += (u1 - cu) * (v0 - cv) - (u0 - cu) * (v1 - cv); u0 = u1; v0 = v1
  }
  return srh
}

/** Bunkers right and left movers (ID method) and the 0-6 km pressure-weighted mean wind, m/s. */
export function stormMotion(env: Environment) {
  const [mu, mv] = meanWind(env, 0, 6000), [tu, tv] = meanWind(env, 0, 500), [hu, hv] = meanWind(env, 5500, 6000)
  const su = hu - tu, sv = hv - tv, s = Math.hypot(su, sv) || 1
  return { rightMover: [mu + 7.5 * sv / s, mv - 7.5 * su / s] as const, leftMover: [mu - 7.5 * sv / s, mv + 7.5 * su / s] as const, meanWind: [mu, mv] as const }
}

/** Bulk shear 0-6 km above which the domain follows the Bunkers right mover instead of the mean wind, m/s. */
export const FOLLOW_SUPERCELL_SHEAR = 15

/**
 * Velocity of the storm-following domain (u, v, m/s): the Bunkers right mover in supercell shear (0-6 km bulk shear at
 * least FOLLOW_SUPERCELL_SHEAR), otherwise the 0-6 km mean wind, with which ordinary and multicell storms drift.
 */
export function domainMotion(env: Environment) {
  const m = stormMotion(env), [u0, v0] = env.windUV(0), [u6, v6] = env.windUV(6000)
  return Math.hypot(u6 - u0, v6 - v0) >= FOLLOW_SUPERCELL_SHEAR ? m.rightMover : m.meanWind
}

/**
 * Supercell indices of the environment's hodograph, as in MetPy: Bunkers storm motion (ID method: 0-6 km mean wind
 * plus 7.5 m/s across the shear between the 0-0.5 and 5.5-6 km means), SRH for the right mover, SCP and fixed-layer STP.
 */
export function stormIndices(env: Environment, parcels: ParcelIndices): StormIndices {
  const { rightMover, leftMover } = stormMotion(env)
  const srh01 = helicity(env, 1000, ...rightMover), srh03 = helicity(env, 3000, ...rightMover)
  const [u0, v0] = env.windUV(0), [u6, v6] = env.windUV(6000), shear06 = Math.hypot(u6 - u0, v6 - v0)
  // SCP: the shear term is 0 below 10 m/s and capped at 1 above 20 m/s.
  const scp = parcels.mu.cape / 1000 * (srh03 / 50) * (shear06 < 10 ? 0 : Math.min(1, shear06 / 20))
  // STP: LCL term 1 below 1 km and 0 above 2 km; shear term 0 below 12.5 m/s and capped at 1.5 above 30 m/s.
  const lcl = (parcels.sb.lcl ?? 99) * 1000
  const stp = parcels.sb.cape / 1500 * clamp((2000 - lcl) / 1000, 0, 1) * (srh01 / 150) * (shear06 < 12.5 ? 0 : Math.min(1.5, shear06 / 20))
  // SHIP: the environment's 700 and 500 hPa levels and its freezing level (the first height at or below 0 °C).
  const height = 20_000, z7 = heightOf(env, 70000, height), z5 = heightOf(env, 50000, height), t5 = env.temperatureEnv(z5)
  const lapse75 = (env.temperatureEnv(z7) - t5) / ((z5 - z7) / 1000)
  let freezing = 0; while (freezing < height && env.temperatureEnv(freezing) > 0) freezing += 10
  const ship = hailParameter(parcels.mu.cape, env.qEnv(parcels.mu.start * 1000), lapse75, t5, shear06, freezing)
  const dcp = derechoParameter(parcels.dcape, parcels.mu.cape, shear06, Math.hypot(...meanWind(env, 0, 6000)))
  const layer = effectiveLayer(env, height), el = (parcels.mu.el ?? 0) * 1000
  let effective: StormIndices['effective'] = null
  if (layer) {
    const top = Math.max(layer.top, layer.base + EFFECTIVE_STEP_MIN), [ub, vb] = env.windUV(layer.base), [ut, vt] = env.windUV(Math.max(layer.base, layer.base + (el - layer.base) / 2))
    effective = { ...layer, srh: helicity(env, top, ...rightMover, layer.base), shear: el > layer.base ? Math.hypot(ut - ub, vt - vb) : 0 }
  }
  return { rightMover, leftMover, srh01, srh03, shear06, scp, stp, ship, lapse75, dcp, effective }
}
