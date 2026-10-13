// A moving front (2.5): the boundary between two air masses, the colder one a wedge under the warmer. A cold front
// pushes its wedge forward and lifts the warm air ahead of it — the density current the model already makes of a
// storm's outflow; a warm front is a gentle wedge of cold air retreating ahead of it, the warm air gliding up over it.
// The front is set on the ground (km from the domain's centre at the start, a heading, a speed) with the contrast of
// the air masses, the depth of the cold air and the slope of the frontal surface; it works over any environment,
// a loaded sounding too. The model keeps the cold air mass where the front puts it (large-scale forcing, as for the
// zones): inside the cold air it is pulled to its colder profile; behind a warm front, back to the warm air.
import { G } from './constants'

export interface FrontConfig {
  /** Cold: the cold air comes behind the front, under the warm; warm: the cold air is ahead and retreats. */
  kind: 'cold' | 'warm'
  /** How much colder the cold air is near the ground, K (the potential temperature deficit, constant up to the frontal surface). */
  contrast: number
  /** Depth of the cold air where it is deepest, km. */
  depth: number
  /** Slope of the frontal surface: it rises 1 km over this many km (cold fronts ~50-100, warm ~100-300). */
  slope: number
  /** Speed over the ground, m/s, and the heading it moves to, degrees (90: towards the east). */
  speed: number
  heading: number
  /** Where the front is at the start: km from the domain's centre along the heading (negative: behind the centre). */
  start: number
}

/** Over this height the frontal surface is blurred, m (half the jump on each side). */
export const FRONT_BLUR = 250
/** Behind a warm front the air is pulled back to the warm air over this distance, km. */
export const WARM_BAND = 15
/** Time scale of the pull, s (as for the zones). */
export const FRONTAL_TIME = 900

/** Unit vector of the heading (east, north). */
export const headingVector = (heading: number) => [Math.sin(heading * Math.PI / 180), Math.cos(heading * Math.PI / 180)] as const

/**
 * Distance of a ground point from the front's surface line along its heading, km: positive ahead of it. `x`, `y` are
 * ground coordinates, m, from the domain's starting corner; the domain is `width` × `depth` m; `time` the model time, s.
 */
export function frontDistance(f: FrontConfig, x: number, y: number, time: number, width: number, depth: number) {
  const [nx, ny] = headingVector(f.heading), along = (x - width / 2) * nx + (y - depth / 2) * ny
  return along / 1000 - f.start - f.speed * time / 1000
}

/**
 * Depth of the cold air over a point at distance `s` (km, frontDistance), km. A warm front is a thin wedge growing by
 * 1/slope from the line. A cold front has a head: friction holds back the air at the ground, and its nose stands
 * almost upright to COLD_NOSE of the depth within NOSE_WIDTH of the line; behind it the surface rises by the slope.
 */
export function coldDepth(f: FrontConfig, s: number) {
  const into = f.kind === 'cold' ? -s : s
  if (into <= 0) return 0
  return Math.min(f.depth, f.kind === 'cold' ? COLD_NOSE * f.depth * Math.min(1, into / NOSE_WIDTH) + into / f.slope : into / f.slope)
}

/** The cold front's head: its height as a share of the cold air's depth, and the distance it rises over, km. */
export const COLD_NOSE = .5, NOSE_WIDTH = 2

/** How much colder the air is at height `z` (m) over a point at distance `s`, K: the contrast below the surface, blurred over FRONT_BLUR. */
export function frontalDeficit(f: FrontConfig, s: number, z: number) {
  const h = coldDepth(f, s) * 1000
  if (h <= 0) return 0
  const t = (h - z) / FRONT_BLUR
  return f.contrast * (t >= 1 ? 1 : t <= -1 ? 0 : .5 + .5 * Math.sin(Math.PI / 2 * t))
}

/**
 * The cold air's water vapour as a share of the environment's, for a deficit of `deficit` K: saturation falls ~7 % per
 * K (Clausius-Clapeyron), so the cold air mass keeps the environment's relative humidity — a lower dew point, as a real
 * one, not the warm air's moisture cooled into a saturated slab (the first version made a fog bank of it).
 */
export const coldMoisture = (deficit: number) => Math.exp(-.068 * deficit)

/**
 * The speed the cold air would advance at by itself, m/s: a density current, c = 0.7 √(g' h) (Benjamin 1968; g' =
 * g Δθ/θ) — shown beside the speed set for the front, which the forcing keeps.
 */
export const densityCurrentSpeed = (f: Pick<FrontConfig, 'contrast' | 'depth'>, theta = 300) => .7 * Math.sqrt(G * f.contrast / theta * f.depth * 1000)
