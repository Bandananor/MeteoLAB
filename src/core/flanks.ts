// The supercell's two downdraughts (2.8), as in the conceptual model of Lemon & Doswell (1979): the forward-flank
// downdraught (FFD) under the precipitation core ahead of the updraught, driven by the rain's loading and evaporation,
// and the rear-flank downdraught (RFD) behind it, which wraps around the mesocyclone; each spreads its outflow along the
// ground, and their edges are the forward- and rear-flank gust fronts. The model has both downdraughts (the dynamics make
// them); this names them: the downdraught columns near a mesocyclone split by where they lie along the storm's motion.
import type { Grid } from './grid'
import type { AtmosphereModel } from './model'
import type { OutflowDeficit } from './rkw'

/** A column is in a downdraught when its air sinks faster than this (m/s) somewhere between FLANK_LAYER's heights (m). */
export const FLANK_DOWN = 2
export const FLANK_LAYER = [500, 3000] as const
/** Downdraughts are looked for within this distance of the mesocyclone, m. */
export const FLANK_REACH = 15_000
/**
 * The FFD: downdraught columns more than RFD_AHEAD (m) ahead of the mesocyclone along the storm's motion, or on its
 * forward and left side (from FFD_RIGHT° right of the heading to FFD_LEFT° left of it), where the rain falls downshear and
 * the precipitation core curls around the updraught's left flank; the RFD: the rest within RFD_REACH (m) — behind and
 * on the right, where it wraps around the mesocyclone. Further off behind (old outflow) is neither. The sector by
 * tests/bench/flanks.ts: with only the distance ahead, the left-abeam downdraught under the core's 70-200 mm/h came out
 * an RFD to the north-west of the mesocyclone in the classic and WK supercells' mature stage.
 */
export const RFD_AHEAD = 2000, RFD_REACH = 8000, FFD_LEFT = 100, FFD_RIGHT = 30

export interface Flank {
  /** The flank's ground columns (x + nx y). */ columns: number[]
  /** The strongest sinking, m/s (positive), and the outflow's largest θv deficit at the ground under it, K. */ down: number; cold: number
  /** The heaviest rain reaching the ground under it, mm/h. */ rain: number
  /** Where it is: the mean offset from the mesocyclone, m, along the storm's motion and to its left. */ along: number; left: number
}

export interface StormFlanks {
  ffd: Flank | null; rfd: Flank | null
  /** The mesocyclone's ground column, and the storm's heading over the ground (a unit vector, east and north). */ centre: number; heading: readonly [number, number]
}

/** Whether a point `along` m ahead of the mesocyclone and `left` m to its left is on the forward flank (see FFD_LEFT). */
export function forwardFlank(along: number, left: number) {
  if (along > RFD_AHEAD) return true
  if (!along && !left) return false
  const angle = Math.atan2(left, along) * 180 / Math.PI
  return angle <= FFD_LEFT && angle >= -FFD_RIGHT
}

type FlankSource = Pick<AtmosphereModel, 'grid' | 'w' | 'uhColumn'>

/** The column of the largest UH (2-5 km) within `reach` (m) of (x, y), m from the domain corner, across the periodic edges. */
export function mesocycloneColumn(m: Pick<AtmosphereModel, 'grid' | 'uhColumn'>, x: number, y: number, reach = 8000) {
  const { nx, ny, dx, dy } = m.grid, cx = Math.round(x / dx), cy = Math.round(y / dy), rx = Math.ceil(reach / dx), ry = Math.ceil(reach / dy)
  let best = mod(cx, nx) + nx * mod(cy, ny), most = -Infinity
  for (let j = -ry; j <= ry; j++) for (let i = -rx; i <= rx; i++) {
    if ((i * dx) ** 2 + (j * dy) ** 2 > reach ** 2) continue
    const c = mod(cx + i, nx) + nx * mod(cy + j, ny)
    if (m.uhColumn[c] > most) { most = m.uhColumn[c]; best = c }
  }
  return best
}

/**
 * The FFD and RFD around the mesocyclone at ground column `centre`, for a storm moving along (mu, mv) (any length; over
 * the ground); `rain` the rain reaching the ground per column (mm/h), `outflow` the outflow's deficit (rkw.ts).
 */
export function stormFlanks(m: FlankSource, centre: number, mu: number, mv: number, rain: ArrayLike<number>, outflow: OutflowDeficit): StormFlanks {
  const { nx, ny, dx, dy, zs, layer } = m.grid, speed = Math.hypot(mu, mv) || 1, ex = mu / speed, ey = mv / speed
  const k0 = zs.findIndex(z => z >= FLANK_LAYER[0]), k1 = zs.findLastIndex(z => z <= FLANK_LAYER[1])
  const x0 = centre % nx, y0 = Math.floor(centre / nx), rx = Math.ceil(FLANK_REACH / dx), ry = Math.ceil(FLANK_REACH / dy)
  const make = (): Flank => ({ columns: [], down: 0, cold: 0, rain: 0, along: 0, left: 0 })
  const ffd = make(), rfd = make()
  for (let j = -ry; j <= ry; j++) for (let i = -rx; i <= rx; i++) {
    const ox = i * dx, oy = j * dy, r = Math.hypot(ox, oy)
    if (r > FLANK_REACH) continue
    const c = mod(x0 + i, nx) + nx * mod(y0 + j, ny)
    let down = 0
    for (let k = k0; k <= k1; k++) down = Math.max(down, -m.w[c + k * layer])
    if (down < FLANK_DOWN) continue
    const along = ox * ex + oy * ey, left = -ox * ey + oy * ex
    const f = forwardFlank(along, left) ? ffd : r <= RFD_REACH ? rfd : null
    if (!f) continue
    f.columns.push(c); f.down = Math.max(f.down, down); f.cold = Math.max(f.cold, outflow.deficit[c]); f.rain = Math.max(f.rain, rain[c])
    f.along += along; f.left += left
  }
  const done = (f: Flank) => { if (!f.columns.length) return null; f.along /= f.columns.length; f.left /= f.columns.length; return f }
  return { ffd: done(ffd), rfd: done(rfd), centre, heading: [ex, ey] }
}

/** The grid's columns as a mask: 1 in the FFD, 2 in the RFD, 0 elsewhere. */
export function flankMask(grid: Grid, f: StormFlanks, out = new Uint8Array(grid.layer)) {
  for (const c of f.ffd?.columns ?? []) out[c] = 1
  for (const c of f.rfd?.columns ?? []) out[c] = 2
  return out
}

const mod = (a: number, n: number) => ((a % n) + n) % n
