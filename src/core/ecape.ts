import { CP, G, LV } from './constants'
import type { Environment } from './environment'

/**
 * Entraining CAPE by the analytic formula of Peters et al. (2023, JAS 80, 2165; preprint arXiv:2301.04712, eq. 55 of its
 * recipe — ECAPE_A, with the environment's kinetic energy): the CAPE an updraught of the width the storm-relative inflow
 * can feed keeps after mixing with the air around it. Constants of the recipe and the `ecape` package: k² 0.18, α 0.8,
 * Pr 1/3, σ 1.6, L_mix 120 m (the authors' own scripts take σ 1.1, L 250 m). Notes: .claude/literature/ecape.md.
 */
export const ECAPE_SIGMA = 1.6
export const ECAPE_MIX_LENGTH = 120
const K2 = .18, ALPHA = .8, PRANDTL = 1 / 3, DZ = 25

export interface Ecape {
  /** Entraining CAPE, J/kg. */ ecape: number
  /** ECAPE / CAPE: about 0.5-1 in supercell environments, 0.2-0.3 in weak shear. */ ratio: number
  /** The mean storm-relative wind speed 0-1 km, m/s. */ inflow: number
  /** NCAPE, J/kg: the buoyancy dilution by the environment's dryness (the running mean moist static energy below). */ ncape: number
}

/** Mean of |V - c| over 0-1 km (the mean of the speeds, not the speed of the mean), m/s. */
export function stormRelativeInflow(env: Environment, cu: number, cv: number, top = 1000) {
  let sum = 0, n = 0
  for (let z = 0; z <= top; z += DZ) { const [u, v] = env.windUV(z); sum += Math.hypot(u - cu, v - cv); n++ }
  return sum / n
}

/**
 * NCAPE between the LFC and the EL (m): -∫ g / (cp T0) (h̄ - h*) dz, h̄ the mean moist static energy from the ground to z,
 * h* the saturated one at z (over water); at least 0.
 */
export function ncape(env: Environment, lfc: number, el: number) {
  const h = (z: number) => { const t = env.temperatureEnv(z); return CP * (t + 273.15) + LV * env.qEnv(z) + G * z }
  let integral = 0, hSum = 0, hPrev = h(0)
  for (let z = DZ; z <= el; z += DZ) {
    const hz = h(z); hSum += (hPrev + hz) / 2 * DZ; hPrev = hz
    if (z < lfc) continue
    const t = env.temperatureEnv(z), hStar = CP * (t + 273.15) + LV * env.qsat(t, z) + G * z
    integral += -G / (CP * (t + 273.15)) * (hSum / z - hStar) * DZ
  }
  return Math.max(0, integral)
}

/** ECAPE / CAPE (eq. 55) from the normalized inflow vt = V_SR / sqrt(2 CAPE), Ñ = NCAPE / CAPE and ψ. */
export function ecapeRatio(vt: number, nt: number, psi: number) {
  const v2 = Math.max(vt * vt, 1e-8), r = psi / v2
  return v2 + (-1 - psi - r * nt + Math.sqrt((1 + psi + r * nt) ** 2 + 4 * r * (1 - psi * nt))) / (2 * r)
}

/** ψ of the formula for an EL at height (m) above the ground. */
export const ecapePsi = (el: number) => K2 * ALPHA * ALPHA * Math.PI * Math.PI * ECAPE_MIX_LENGTH / (4 * PRANDTL * ECAPE_SIGMA * ECAPE_SIGMA * el)

/**
 * ECAPE of a parcel (the most unstable, as the recipe's CM1 check and the `ecape` package) for a storm moving at (cu, cv)
 * (the Bunkers right mover). lfc and el in km, as ParcelIndex; no LFC or no CAPE gives 0. Without an EL the column's top
 * stands for it.
 */
export function entrainingCape(env: Environment, cape: number, lfc: number | null, el: number | null, height: number, cu: number, cv: number): Ecape {
  const inflow = stormRelativeInflow(env, cu, cv)
  if (!(cape > 1) || lfc === null) return { ecape: 0, ratio: 0, inflow, ncape: 0 }
  const top = (el ?? height / 1000) * 1000, n = ncape(env, lfc * 1000, top)
  const ratio = Math.max(0, ecapeRatio(inflow / Math.sqrt(2 * cape), n / cape, ecapePsi(top)))
  return { ecape: ratio * cape, ratio, inflow, ncape: n }
}
