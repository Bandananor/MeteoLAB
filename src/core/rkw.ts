// The RKW balance (Rotunno, Klemp and Weisman 1988; Weisman and Rotunno 2004): a cold pool spreads as a density current
// at speed C, C² = 2 ∫ (-B) dz over its depth, while the low-level shear Δu carries air the other way. With C/Δu near 1
// the updraught at the gust front stands upright and keeps lifting fresh air (long-lived lines); with a stronger cold
// pool the gust front runs ahead and the cells lean back over their own outflow and weaken; with stronger shear they
// lean downshear and the cold pool is too weak to lift air to its LFC on its own.
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

/** What the balance means, in a few words. */
export function describeBalance(b: ColdPoolBalance) {
  if (b.ratio > 1.5) return 'купол сильнее сдвига: фронт порывов убегает вперёд, ячейки заваливаются назад над оттоком и слабеют'
  if (b.ratio >= .7) return 'купол и сдвиг уравновешены: поток у фронта порывов стоит прямо, новые ячейки растут на нём — так живут линии шквалов'
  return 'сдвиг сильнее купола: ячейки наклонены по сдвигу, купол слишком слаб, чтобы сам поднимать воздух'
}
