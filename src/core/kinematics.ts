import type { Environment } from './environment'
import type { ParcelIndices } from './sounding'

export interface StormIndices {
  /** Bunkers right-mover motion (u, v), m/s. */ rightMover: readonly [number, number]
  /** Bunkers left-mover motion (u, v), m/s. */ leftMover: readonly [number, number]
  /** Storm-relative helicity for the right mover, m2/s2. */ srh01: number; srh03: number
  /** Bulk wind difference 0-6 km, m/s. */ shear06: number
  /** Supercell composite parameter (MUCAPE, SRH 0-3 km, bulk shear 0-6 km). */ scp: number
  /** Significant tornado parameter, fixed layer (SBCAPE, SB LCL, SRH 0-1 km, bulk shear 0-6 km). */ stp: number
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

/** Storm-relative helicity of the layer 0..top for a storm moving at (cu, cv): -sum over layers of (V - c) x dV. */
function helicity(env: Environment, top: number, cu: number, cv: number) {
  let srh = 0, [u0, v0] = env.windUV(0)
  for (let z = STEP; z <= top + 1e-6; z += STEP) {
    const [u1, v1] = env.windUV(z)
    srh += (u1 - cu) * (v0 - cv) - (u0 - cu) * (v1 - cv); u0 = u1; v0 = v1
  }
  return srh
}

/**
 * Supercell indices of the environment's hodograph, as in MetPy: Bunkers storm motion (ID method: 0-6 km mean wind
 * plus 7.5 m/s across the shear between the 0-0.5 and 5.5-6 km means), SRH for the right mover, SCP and fixed-layer STP.
 */
export function stormIndices(env: Environment, parcels: ParcelIndices): StormIndices {
  const [mu, mv] = meanWind(env, 0, 6000), [tu, tv] = meanWind(env, 0, 500), [hu, hv] = meanWind(env, 5500, 6000)
  const su = hu - tu, sv = hv - tv, s = Math.hypot(su, sv) || 1
  const rightMover = [mu + 7.5 * sv / s, mv - 7.5 * su / s] as const, leftMover = [mu - 7.5 * sv / s, mv + 7.5 * su / s] as const
  const srh01 = helicity(env, 1000, ...rightMover), srh03 = helicity(env, 3000, ...rightMover)
  const [u0, v0] = env.windUV(0), [u6, v6] = env.windUV(6000), shear06 = Math.hypot(u6 - u0, v6 - v0)
  // SCP: the shear term is 0 below 10 m/s and capped at 1 above 20 m/s.
  const scp = parcels.mu.cape / 1000 * (srh03 / 50) * (shear06 < 10 ? 0 : Math.min(1, shear06 / 20))
  // STP: LCL term 1 below 1 km and 0 above 2 km; shear term 0 below 12.5 m/s and capped at 1.5 above 30 m/s.
  const lcl = (parcels.sb.lcl ?? 99) * 1000
  const stp = parcels.sb.cape / 1500 * clamp((2000 - lcl) / 1000, 0, 1) * (srh01 / 150) * (shear06 < 12.5 ? 0 : Math.min(1.5, shear06 / 20))
  return { rightMover, leftMover, srh01, srh03, shear06, scp, stp }
}
