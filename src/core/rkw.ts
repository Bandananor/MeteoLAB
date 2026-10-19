// The RKW balance (Rotunno, Klemp and Weisman 1988; Weisman and Rotunno 2004): a cold pool spreads as a density current
// at speed C, C² = 2 ∫ (-B) dz over its depth, while the low-level shear Δu carries air the other way. With C/Δu near 1
// the updraught at the gust front stands upright and keeps lifting fresh air (long-lived lines); with a stronger cold
// pool the gust front runs ahead and the cells lean back over their own outflow and weaken; with stronger shear they
// lean downshear and the cold pool is too weak to lift air to its LFC on its own.
import { L } from '../i18n'
import { G } from './constants'
import type { Environment } from './environment'
import type { Grid } from './grid'

export interface RkwSource {
  grid: Grid; env: Environment
  theta: ArrayLike<number>; q: ArrayLike<number>
  cloud: ArrayLike<number>; rain: ArrayLike<number>; ice: ArrayLike<number>; snow: ArrayLike<number>; graupel: ArrayLike<number>; hail: ArrayLike<number>
}

/** A column is in the cold pool when its ground air is at least RKW_COLD K colder (θ) than the environment. */
export const RKW_COLD = 1
/** Depth of the low-level shear, m (RKW: 0-2.5 km). */
export const RKW_SHEAR_DEPTH = 2500

export interface ColdPoolBalance {
  /** Cold-pool speed C, m/s: the mean over the cold-pool columns, and the strongest column. */ c: number; cMax: number
  /** Mean depth of the cold pool (where its buoyancy turns positive), m. */ depth: number
  /** Environmental wind difference 0-2.5 km, m/s (the whole vector: the line's orientation is not known). */ deltaU: number
  /** C / Δu. */ ratio: number
  /** Share of the domain's columns in the cold pool. */ area: number
}

/** The cold pool against the low-level shear, or null without a cold pool. */
export function coldPoolBalance(m: RkwSource): ColdPoolBalance | null {
  const { nz, layer, zs, hz } = m.grid, e = m.env
  let sum = 0, max = 0, depthSum = 0, n = 0
  for (let c = 0; c < layer; c++) {
    if (m.theta[c] - e.theta[0] > -RKW_COLD) continue
    let integral = 0, depth = 0
    for (let k = 0, i = c; k < nz; k++, i += layer) {
      const thv0 = e.theta[k] * (1 + .61 * e.q[k])
      const b = G * (m.theta[i] * (1 + .61 * m.q[i]) / thv0 - 1 - m.cloud[i] - m.rain[i] - m.ice[i] - m.snow[i] - m.graupel[i] - m.hail[i])
      if (b >= 0) break
      // The ground node owns half a layer (hz[0]); the cold pool's top is where the buoyancy turns positive.
      integral -= b * hz[k]; depth = zs[k] + hz[k] / 2
    }
    const speed = Math.sqrt(2 * integral)
    sum += speed; max = Math.max(max, speed); depthSum += depth; n++
  }
  if (!n) return null
  const [u0, v0] = e.windUV(0), [u1, v1] = e.windUV(RKW_SHEAR_DEPTH), deltaU = Math.hypot(u1 - u0, v1 - v0), c = sum / n
  return { c, cMax: max, depth: depthSum / n, deltaU, ratio: c / Math.max(deltaU, .1), area: n / layer }
}

/**
 * The air of the undisturbed environment at the ground is this percentile of the ground node's θv over the domain (the
 * outflow and the rain-cooled air take up a minority of it; a percentile follows the day's heating, which the initial
 * profile does not).
 */
export const OUTFLOW_WARM = .75
/** How far from the low-level rotation the outflow under it is looked for, m (the rotation's column and its neighbours). */
export const OUTFLOW_NEAR = 2000

export interface OutflowDeficit {
  /** θv of the environment at the ground minus that of each ground column, K, at least 0. */ deficit: Float32Array
  /** θv of the environment at the ground, K. */ warm: number
  /** The largest deficit, K. */ max: number
}

/**
 * The true cold of the outflow (2.8): the ground air's virtual potential temperature θv = θ (1 + 0.61 q) below that of
 * the environment, as the RFD's θv′ is measured (Markowski et al. 2002), instead of the cold-pool indicator, which
 * gathers the cooling the air has had and can be half or twice the real difference.
 */
export function outflowDeficit(m: Pick<RkwSource, 'grid' | 'theta' | 'q'>): OutflowDeficit {
  const { layer } = m.grid, thv = new Float32Array(layer)
  for (let c = 0; c < layer; c++) thv[c] = m.theta[c] * (1 + .61 * m.q[c])
  const warm = Float32Array.from(thv).sort()[Math.floor((layer - 1) * OUTFLOW_WARM)], deficit = new Float32Array(layer)
  let max = 0
  for (let c = 0; c < layer; c++) { deficit[c] = Math.max(0, warm - thv[c]); max = Math.max(max, deficit[c]) }
  return { deficit, warm, max }
}

/** The largest deficit within `radius` (m) of the ground column `c`, across the periodic edges. */
export function deficitNear(d: OutflowDeficit, grid: Grid, c: number, radius = OUTFLOW_NEAR) {
  const { nx, ny, dx, dy } = grid, x0 = c % nx, y0 = Math.floor(c / nx), rx = Math.floor(radius / dx), ry = Math.floor(radius / dy)
  let max = 0
  for (let j = -ry; j <= ry; j++) for (let i = -rx; i <= rx; i++) {
    if ((i * dx) ** 2 + (j * dy) ** 2 > radius ** 2) continue
    max = Math.max(max, d.deficit[(x0 + i + nx) % nx + nx * ((y0 + j + ny) % ny)])
  }
  return max
}

/** What the balance means, in a few words. */
export function describeBalance(b: ColdPoolBalance) {
  if (b.ratio > 1.5) return L('купол сильнее сдвига: фронт порывов убегает вперёд, ячейки заваливаются назад над оттоком и слабеют', 'the cold pool is stronger than the shear: the gust front runs ahead, the cells lean back over the outflow and weaken')
  if (b.ratio >= .7) return L('купол и сдвиг уравновешены: поток у фронта порывов стоит прямо, новые ячейки растут на нём — так живут линии шквалов', 'the cold pool and the shear are balanced: the updraught at the gust front stands upright and new cells grow on it — this is how squall lines live')
  return L('сдвиг сильнее купола: ячейки наклонены по сдвигу, купол слишком слаб, чтобы сам поднимать воздух', 'the shear is stronger than the cold pool: the cells lean with the shear, the pool is too weak to lift the air by itself')
}
