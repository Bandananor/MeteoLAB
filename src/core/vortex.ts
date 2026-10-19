// The mesocyclone in three dimensions (2.8): the centre of the cyclonic rotation level by level, followed up and down
// from the strongest UH 2-5 km, so the view can draw it as a column — how deep it reaches, how it tilts with the shear,
// whether it touches the ground (a low-level mesocyclone) — instead of one ring at 3.5 km.
import type { AtmosphereModel } from './model'

/** A level belongs to the column while its strongest cyclonic vorticity near the centre is at least this, s-1. */
export const VORTEX_ZETA = .006
/** The centre moves at most this many columns from one level to the next. */
const VORTEX_STEP = 2
/** Followed up to this height, m. */
export const VORTEX_TOP = 10_000

export interface VortexLevel {
  /** Height, m; the centre, m from the domain corner (unwrapped from the start column: may leave the domain). */ z: number; x: number; y: number
  /** Vertical vorticity at the centre, s-1, and the radius of the area above half of it, m. */ zeta: number; radius: number
}

/** The rotating column through the ground column `start` (the strongest UH 2-5 km), bottom up; empty when it does not rotate there. */
export function vortexColumn(m: Pick<AtmosphereModel, 'grid' | 'zeta'>, start: number): VortexLevel[] {
  const { nx, ny, zs, dx, dy } = m.grid, mid = zs.findIndex(z => z >= 3000), top = zs.findLastIndex(z => z <= VORTEX_TOP)
  const level = (k: number, cx: number, cy: number): VortexLevel | null => {
    let best = -Infinity, bx = cx, by = cy
    for (let j = -VORTEX_STEP; j <= VORTEX_STEP; j++) for (let i = -VORTEX_STEP; i <= VORTEX_STEP; i++) {
      const z = m.zeta(mod(cx + i, nx), mod(cy + j, ny), k)
      if (z > best) { best = z; bx = cx + i; by = cy + j }
    }
    if (best < VORTEX_ZETA) return null
    let n = 0
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) if (m.zeta(mod(bx + i, nx), mod(by + j, ny), k) >= best / 2) n++
    return { z: zs[k], x: bx * dx, y: by * dy, zeta: best, radius: Math.sqrt(n * dx * dy / Math.PI) }
  }
  const x0 = start % nx, y0 = Math.floor(start / nx), first = level(mid, x0, y0)
  if (!first) return []
  const out = [first]
  for (let k = mid + 1, p = first; k <= top; k++) { const l = level(k, Math.round(p.x / dx), Math.round(p.y / dy)); if (!l) break; out.push(l); p = l }
  // Downwards to the lowest level above the ground node (w and ζ there are the surface layer's).
  for (let k = mid - 1, p = first; k >= 1; k--) { const l = level(k, Math.round(p.x / dx), Math.round(p.y / dy)); if (!l) break; out.unshift(l); p = l }
  return out
}

const mod = (a: number, n: number) => ((a % n) + n) % n
