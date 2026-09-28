export const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp(t)
export const mod = (x: number, n: number) => ((x % n) + n) % n
/** Interpolates an angle in degrees along the shorter arc; the result is in [0, 360). */
export const lerpAngle = (a: number, b: number, t: number) => mod(a + (mod(b - a + 180, 360) - 180) * clamp(t), 360)

export function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
