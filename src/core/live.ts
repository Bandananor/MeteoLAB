// The live sounding: the environment as it is now in the running model, not as it started. Averaged over the quiet
// columns (no cloud or precipitation anywhere in the column, no cold pool at the ground), so it shows the air the
// storms feed on — warmed and moistened by the sun, cooled by a night inversion — rather than the storms themselves.
// It is an Environment like the starting one, so every parcel, index and diagram works on it unchanged.
import type { SimConfig } from './config'
import { KAPPA } from './constants'
import { Environment } from './environment'
import type { Grid } from './grid'
import { qsatP } from './microphysics'

/** What the live sounding reads from a model (the running one or the UI's mirror of it). */
export interface LiveSource {
  grid: Grid; config: SimConfig; env: Environment; frame: readonly [number, number]
  theta: ArrayLike<number>; q: ArrayLike<number>; u: ArrayLike<number>; v: ArrayLike<number>; cold: ArrayLike<number>
  cloud: ArrayLike<number>; ice: ArrayLike<number>; rain: ArrayLike<number>; snow: ArrayLike<number>; graupel: ArrayLike<number>; hail: ArrayLike<number>
}

/** A column is quiet with less condensate than this at every level (kg/kg) and a cold pool weaker than LIVE_COLD (K). */
export const LIVE_CONDENSATE = 1e-5, LIVE_COLD = .5
/** Below this share of quiet columns (a domain full of storms and outflow) the sounding averages every column. */
export const LIVE_MIN_SHARE = .05

export interface LiveSounding {
  env: Environment
  /** Share of the domain's columns that are quiet. */
  quiet: number
  /** Too few quiet columns (under LIVE_MIN_SHARE): the sounding averages the whole domain, storms included. */
  all: boolean
}

export function liveSounding(m: LiveSource): LiveSounding {
  const { nx, ny, nz, layer, zs } = m.grid, quiet = new Uint8Array(layer)
  let count = 0
  for (let c = 0; c < layer; c++) {
    if (m.cold[c] >= LIVE_COLD) continue
    let calm = true
    for (let k = 0, i = c; k < nz && calm; k++, i += layer) calm = m.cloud[i] + m.ice[i] + m.rain[i] + m.snow[i] + m.graupel[i] + m.hail[i] < LIVE_CONDENSATE
    if (calm) { quiet[c] = 1; count++ }
  }
  const all = count < LIVE_MIN_SHARE * nx * ny, used = all ? layer : count
  const mean = (field: ArrayLike<number>, extra = 0) => {
    const out = new Float64Array(nz)
    for (let k = 0; k < nz; k++) { let s = 0; for (let c = 0, i = k * layer; c < layer; c++, i++) if (all || quiet[c]) s += field[i]; out[k] = s / used + extra }
    return out
  }
  const theta = mean(m.theta), q = mean(m.q), u = mean(m.u, m.frame[0]), v = mean(m.v, m.frame[1])
  // Linear in height between the model levels, constant above the top.
  const at = (f: Float64Array, z: number) => {
    if (z <= 0) return f[0]
    if (z >= zs[nz - 1]) return f[nz - 1]
    let k = 1; while (zs[k] < z) k++
    const w = (z - zs[k - 1]) / (zs[k] - zs[k - 1]); return f[k - 1] + (f[k] - f[k - 1]) * w
  }
  const base = m.env
  const env = new Environment(m.config, m.grid, {
    theta: z => at(theta, z), qv: z => at(q, z), wind: z => [at(u, z), at(v, z)],
    // Only for completeness (qv wins): the relative humidity at the starting pressure.
    rh: z => { const p = base.pressureAt(z); return at(q, z) / qsatP(at(theta, z) * (p / 100000) ** KAPPA - 273.15, p) },
  })
  return { env, quiet: count / layer, all }
}
