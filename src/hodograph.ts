// The hodograph editor: the wind nodes of the sliders (0, 0.5, 1, 3, 6, 10 km) dragged on the hodograph, and the same
// handles on a loaded sounding, where a drag shifts the wind of the layer between the neighbouring nodes.
import { KAPPA, qsatP, type SimConfig, type SoundingLevel } from './core'

type WindKey = 'wind0' | 'wind05' | 'wind1' | 'wind3' | 'wind6' | 'wind10'
type DirKey = 'windDir0' | 'windDir05' | 'windDir1' | 'windDir3' | 'windDir6' | 'windDir10'
/** Heights of the handles, m, with the slider keys of each. */
export const HODOGRAPH_NODES: readonly { z: number; speed: WindKey; dir: DirKey }[] = [
  { z: 0, speed: 'wind0', dir: 'windDir0' }, { z: 500, speed: 'wind05', dir: 'windDir05' }, { z: 1000, speed: 'wind1', dir: 'windDir1' },
  { z: 3000, speed: 'wind3', dir: 'windDir3' }, { z: 6000, speed: 'wind6', dir: 'windDir6' }, { z: 10_000, speed: 'wind10', dir: 'windDir10' },
]
/** Above the top handle a sounding's correction fades out by this height, m (the sliders hold the 10 km wind above). */
const FADE_TOP = 13_000

/** Speed (m/s) and the direction the wind blows from (°, meteorological) of the components u (east) and v (north). */
export function speedDirection(u: number, v: number) {
  const speed = Math.hypot(u, v)
  return { speed, dir: speed < 1e-9 ? 0 : ((270 - Math.atan2(v, u) * 180 / Math.PI) % 360 + 360) % 360 }
}

/** The slider values that put handle `k` at (u, v): speed to 0.1 m/s up to `maxSpeed`, direction to 1°. */
export function sliderNode(k: number, u: number, v: number, maxSpeed: number): Partial<SimConfig> {
  const node = HODOGRAPH_NODES[k], { speed, dir } = speedDirection(u, v)
  return { [node.speed]: Math.round(Math.min(maxSpeed, speed) * 10) / 10, [node.dir]: Math.round(dir) % 360 }
}

/** Weight of handle `k`'s correction at height z: 1 at the handle, falling linearly to 0 at the neighbouring handles. */
export function nodeWeight(k: number, z: number) {
  const at = HODOGRAPH_NODES[k].z, below = k > 0 ? HODOGRAPH_NODES[k - 1].z : at, above = k + 1 < HODOGRAPH_NODES.length ? HODOGRAPH_NODES[k + 1].z : FADE_TOP
  if (z <= at) return k === 0 ? 1 : Math.max(0, (z - below) / (at - below))
  return Math.max(0, (above - z) / (above - at))
}

/**
 * The sounding with handle `k`'s wind moved by (du, dv): every level's wind shifted by nodeWeight times it, so the
 * hodograph bends between the neighbouring handles and the rest stays. Levels are first added at the handle's height and
 * where its correction ends, when there are none (as the model interpolates: θ, q_v and the wind linearly in height):
 * the handle lands exactly where it was dropped, and nothing past the neighbouring handles moves. Levels
 * without wind keep none: the model fills them from their shifted neighbours.
 */
export function nudgeSounding(levels: readonly SoundingLevel[], k: number, du: number, dv: number): SoundingLevel[] {
  const ends = [k > 0 ? HODOGRAPH_NODES[k - 1].z : -1, HODOGRAPH_NODES[k].z, k + 1 < HODOGRAPH_NODES.length ? HODOGRAPH_NODES[k + 1].z : FADE_TOP]
  const out = ends.reduce<SoundingLevel[]>((l, z) => withLevelAt(l, z), [...levels])
  return out.map(l => {
    const w = nodeWeight(k, l.z)
    return w === 0 || l.u === null || l.v === null ? l : { ...l, u: l.u + w * du, v: l.v + w * dv }
  })
}

/** A level's mixing ratio as soundingProfile takes it: from the file, or saturated at the dew point (at most at the temperature). */
const vapour = (l: SoundingLevel) => l.qv ?? (l.td === null ? null : qsatP(Math.min(l.td, l.t), l.p))

/** The levels with one at height z (within the data and not already there), linear in z, pressure in its logarithm. */
function withLevelAt(levels: readonly SoundingLevel[], z: number): SoundingLevel[] {
  const above = levels.findIndex(l => l.z >= z)
  if (above <= 0 || Math.abs(levels[above].z - z) < 1) return [...levels]
  const a = levels[above - 1], b = levels[above], f = (z - a.z) / (b.z - a.z), mix = (x: number, y: number) => x + (y - x) * f
  // The wind from the nearest levels that have it, as the model fills gaps.
  const windBelow = [...levels.slice(0, above)].reverse().find(l => l.u !== null && l.v !== null), windAbove = levels.slice(above).find(l => l.u !== null && l.v !== null)
  const wind = (c: 'u' | 'v') => {
    if (!windBelow || !windAbove) return (windBelow ?? windAbove)?.[c] ?? null
    return windBelow[c]! + (windAbove[c]! - windBelow[c]!) * (z - windBelow.z) / (windAbove.z - windBelow.z)
  }
  // Potential temperature, as the model interpolates it, at the pressure between the two in its logarithm.
  const p = Math.exp(mix(Math.log(a.p), Math.log(b.p))), theta = (l: SoundingLevel) => (l.t + 273.15) * (1e5 / l.p) ** KAPPA
  const level: SoundingLevel = {
    p, z, t: mix(theta(a), theta(b)) * (p / 1e5) ** KAPPA - 273.15, td: a.td === null || b.td === null ? null : mix(a.td, b.td), u: wind('u'), v: wind('v'),
    // Vapour as the model has it between the two levels (it interpolates the mixing ratio, not the dew point).
    ...(vapour(a) !== null && vapour(b) !== null ? { qv: mix(vapour(a)!, vapour(b)!) } : {}),
  }
  return [...levels.slice(0, above), level, ...levels.slice(above)]
}
