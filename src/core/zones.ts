// Zones of the environment on the map (2.4): polygons fixed to the ground, each with its own air near the ground —
// warmer or cooler, moister or drier than the profile — so a storm crossing them meets the CAPE and CIN of each. The
// model keeps each zone's air by a gentle pull (large-scale forcing, as for the stationary front); outside the zones
// nothing is touched, and the storm's outflow spreads freely. Inside a zone buoyancy is measured against the zone's own
// air (its own environment); where that air leaves the zone it is warmer or colder than the air around and rises or
// sinks: zones make breezes on their borders (a warm 10 km zone, +3 K: ~7 m/s), as coasts and cities do — physics,
// and a place where storms start. Without a storm a zone keeps ~80 % of its warmth and ~60 % of its moisture.
import type { Environment, EnvironmentProfile } from './environment'
import type { Grid } from './grid'

/** One zone: a polygon on the ground and how its air near the ground differs from the profile. */
export interface ZoneConfig {
  /** Corners, km from the domain's starting corner (west, south), on the ground; the domain is periodic. */
  points: [number, number][]
  /** Temperature at the ground, K warmer (+) or cooler (-) than the profile; fading out to 0 at ZONE_DEPTH. */
  temperature: number
  /** Water vapour at the ground, g/kg more (+) or less (-); fading out the same way. */
  moisture: number
}

/**
 * Depth over which a zone's difference fades out, m; half-width of the blurred edge, m; time scale of the pull, s
 * (15 min: with 30 the breeze and the wind flushed out more than half of the zone's warmth in 20 min).
 */
export const ZONE_DEPTH = 1500, ZONE_EDGE = 2000, ZONE_TIME = 900

/** How much of a zone's ground difference applies at height alt, m: 1 at the ground, falling linearly to 0 at ZONE_DEPTH. */
export const zoneShape = (alt: number) => alt >= ZONE_DEPTH ? 0 : 1 - alt / ZONE_DEPTH

/** Signed distance (m) from point (x, y) to the polygon (m): negative inside. */
function signedDistance(points: [number, number][], x: number, y: number) {
  let inside = false, d2 = Infinity
  for (let a = 0, b = points.length - 1; a < points.length; b = a++) {
    const [xa, ya] = points[a], [xb, yb] = points[b]
    if ((ya > y) !== (yb > y) && x < xa + (xb - xa) * (y - ya) / (yb - ya)) inside = !inside
    const ex = xb - xa, ey = yb - ya, len2 = ex * ex + ey * ey, t = len2 > 0 ? Math.max(0, Math.min(1, ((x - xa) * ex + (y - ya) * ey) / len2)) : 0
    d2 = Math.min(d2, (x - xa - t * ex) ** 2 + (y - ya - t * ey) ** 2)
  }
  return inside ? -Math.sqrt(d2) : Math.sqrt(d2)
}

/**
 * The zones on the ground columns (nx × ny, row 0 the southern edge): the share of the column a zone covers (1 well
 * inside, 0 well outside, a smooth step ZONE_EDGE either side of the border) and the ground differences there — a
 * later zone over an earlier one replaces it by its share. Returns null without zones.
 */
export function zoneMaps(grid: Grid, zones: readonly ZoneConfig[] | undefined) {
  if (!zones?.length) return null
  const { nx, ny, dx, dy } = grid, share = new Float32Array(nx * ny), theta = new Float32Array(nx * ny), vapour = new Float32Array(nx * ny)
  for (const zone of zones) {
    if (zone.points.length < 3) continue
    const points = zone.points.map(([x, y]) => [x * 1000, y * 1000] as [number, number])
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = x + nx * y, d = signedDistance(points, x * dx, y * dy)
      const s = d <= -ZONE_EDGE ? 1 : d >= ZONE_EDGE ? 0 : .5 - .5 * Math.sin(Math.PI / 2 * d / ZONE_EDGE)
      if (s <= 0) continue
      theta[i] += s * (zone.temperature - theta[i]); vapour[i] += s * (zone.moisture / 1000 - vapour[i]); share[i] += s * (1 - share[i])
    }
  }
  return { share, theta, vapour }
}

/**
 * The environment inside a zone, for its numbers before the run (CAPE, CIN): the profile `env` with the zone's
 * differences near the ground (the same shape as in the model).
 */
export function zoneProfile(env: Pick<Environment, 'thetaEnv' | 'qEnv' | 'windUV' | 'p'>, zone: Pick<ZoneConfig, 'temperature' | 'moisture'>): EnvironmentProfile {
  // Exner function at the height, from the hydrostatic pressure of the environment near the ground (enough below 1.5 km).
  const exner = (z: number) => (1 - z / 44_330) ** (5.255 * .2857)
  return {
    theta: z => env.thetaEnv(z) + zone.temperature * zoneShape(z) / exner(z),
    qv: z => Math.max(0, env.qEnv(z) + zone.moisture / 1000 * zoneShape(z)),
    rh: () => 0,
    wind: z => env.windUV(z),
    surfacePressure: env.p[0],
  }
}
