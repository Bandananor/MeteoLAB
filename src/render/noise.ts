import * as THREE from 'three'
import { mulberry32 } from '../core/math'

/** Size of the noise cube, texels; the octaves' lattice periods in texels (R, G, B). */
export const NOISE_SIZE = 64
const PERIODS = [8, 16, 32] as const
/**
 * Each octave's lattice shifted (texels): nested lattices whose points coincide put a value peak of every octave at the
 * same places, a regular grid the eye finds (the testers' 15.10.2026, seen from above over a whole anvil).
 */
const OFFSETS = [[0, 0, 0], [5, 11, 3], [13, 7, 21]] as const

/**
 * Tileable value noise baked into a 3D texture for the cloud's sub-grid detail: in R, G and B three octaves of lattice
 * period 8, 16 and 32 texels in a 64-texel cube (smoothstep-interpolated random values on the lattice, wrapping at the
 * cube's sides), so the shader gets a whole three-octave fbm or billow from one texture fetch instead of 24 hashes:
 * the noise was most of the cost of the cloud march once the march took fine steps inside the cloud.
 */
export function noiseTexture(seed = 7) {
  const n = NOISE_SIZE, data = new Uint8Array(n * n * n * 4), smooth = (t: number) => t * t * (3 - 2 * t)
  PERIODS.forEach((period, channel) => {
    const cells = n / period, rng = mulberry32(seed + channel), lattice = Float32Array.from({ length: cells ** 3 }, () => rng())
    const at = (x: number, y: number, z: number) => lattice[x % cells + (y % cells) * cells + (z % cells) * cells * cells]
    const [ox, oy, oz] = OFFSETS[channel]
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const fx = (x + ox) / period, fy = (y + oy) / period, fz = (z + oz) / period, ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz)
      const u = smooth(fx - ix), v = smooth(fy - iy), w = smooth(fz - iz)
      const lerp = (a: number, b: number, t: number) => a + (b - a) * t
      const value = lerp(
        lerp(lerp(at(ix, iy, iz), at(ix + 1, iy, iz), u), lerp(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), u), v),
        lerp(lerp(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), u), lerp(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), u), v), w)
      data[(x + y * n + z * n * n) * 4 + channel] = Math.round(value * 255)
    }
  })
  for (let i = 3; i < data.length; i += 4) data[i] = 255
  const t = new THREE.Data3DTexture(data, n, n, n)
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType; t.minFilter = t.magFilter = THREE.LinearFilter
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping; t.unpackAlignment = 1; t.needsUpdate = true
  return t
}
