import { beamHeightOver } from './ppi'

/**
 * Ground clutter and receiver noise of the simulated radar (notes .claude/literature/radar-profiles.md, 03.11.2026).
 * The model's ground is flat and bare, so the clutter is a fixed random field of targets tied to the radar (by range gate
 * and degree of azimuth): a gate is contaminated where a target stands above the lower edge of the beam on the 4/3-Earth
 * path (Lang et al., AMS 14.14), filling the part of the beam below its top - so at 0.5° mostly within the first 20-40 km
 * and at the higher tilts only next to the radar. Its echo: a median of CLUTTER.median dBZ with a tail to CLUTTER.max
 * (Lang et al.: up to 45 dBZ in clear air, mountains > 65 - Dixon et al., AMS 8B.7), zero velocity, rho_hv 0.5-0.85 and a
 * noisy ZDR (Dixon et al.: texture of ZDR > 2.4 dB marks clutter). The clutter filter (CMD/GMAP; the DMRL-C suppresses >= 50
 * dB, the LEMZ brochure) takes CLUTTER.suppression dB off it. Receiver noise: the minimum detectable reflectivity
 * Z_min(r) = CLUTTER.noise + 20 lg r (km) plus a signal-to-noise threshold (WSR-88D ~ -7.5 dBZ at 50 km, Ice & Daniel 2019);
 * weaker echo is not seen. This project's choices: the target heights - a smooth random field over PATCH m squares (towns, woods,
 * hills: clutter lies in patches, not gate by gate), cubed so tall patches are few, up to CLUTTER.targets m - their density
 * within a patch, the spread of the echo and the sidelobe clutter next to the radar.
 */
export const CLUTTER = {
  /** Median and spread (dBZ) of a target's echo, its largest; share of the gates with a target; tallest target, m. */
  median: 25, spread: 12, max: 65, density: .6, targets: 150,
  /** Range (m) of the sidelobe clutter at any tilt and how much weaker it is, dB. */
  sidelobeRange: 2000, sidelobe: 25,
  /** rho_hv range and ZDR spread (dB) of clutter. */
  rho: [.5, .85] as const, zdr: 4,
  /** Suppression of the clutter filter, dB. */
  suppression: 50,
  /** Z_min at 1 km and the signal-to-noise threshold, dB. */
  noise: -41.5, snr: 2,
}
/** Range gate and azimuth step of the clutter field, m and degrees. */
const GATE = 250, STEP = 1
/** Size of the patches of the target field on the ground, m. */
const PATCH = 3000

/** Smooth random field in [0, 1) over the ground around the radar (bilinear between the corners of PATCH squares). */
function patches(range: number, azimuth: number) {
  const a = azimuth * Math.PI / 180, fx = range * Math.sin(a) / PATCH, fy = range * Math.cos(a) / PATCH, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0
  const at = (x: number, y: number) => hash(x, y, 7)
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
}

/** A deterministic number in [0, 1) for a gate, an azimuth and a channel. */
function hash(gate: number, azimuth: number, channel: number) {
  let h = (gate * 73856093) ^ (azimuth * 19349663) ^ (channel * 83492791)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

export interface Clutter { /** dBZ (-Infinity: none). */ dbz: number; /** Linear ZDR. */ zdr: number; rho: number }
const NONE: Clutter = { dbz: -Infinity, zdr: 1, rho: 1 }

/** Clutter at `range` (m) and `azimuth` (degrees) for a beam of `beam` degrees at `tilt`, with or without the filter. */
export function clutterAt(range: number, azimuth: number, tilt: number, beam: number, filtered: boolean): Clutter {
  const gate = Math.floor(range / GATE), az = Math.floor(((azimuth % 360) + 360) % 360 / STEP)
  if (hash(gate, az, 1) >= CLUTTER.density) return NONE
  const top = CLUTTER.targets * patches(range, azimuth) ** 3 * (.5 + .5 * hash(gate, az, 2)), lower = beamHeightOver(range, tilt - beam / 2), upper = beamHeightOver(range, tilt + beam / 2)
  // Box-Muller from two more channels: the target's own echo.
  const g = Math.sqrt(-2 * Math.log(1 - hash(gate, az, 3))) * Math.cos(2 * Math.PI * hash(gate, az, 4))
  let dbz = Math.min(CLUTTER.max, Math.max(0, CLUTTER.median + CLUTTER.spread * g))
  if (top > lower) dbz += 10 * Math.log10(Math.min(1, (top - lower) / Math.max(1, upper - lower)))
  else if (range < CLUTTER.sidelobeRange) dbz -= CLUTTER.sidelobe
  else return NONE
  if (filtered) dbz -= CLUTTER.suppression
  const rho = CLUTTER.rho[0] + (CLUTTER.rho[1] - CLUTTER.rho[0]) * hash(gate, az, 5), zdr = 10 ** (CLUTTER.zdr * (2 * hash(gate, az, 6) - 1) / 10)
  return { dbz, zdr, rho }
}

/** The weakest echo (dBZ) the radar sees at `range` (m): the noise floor plus the threshold. */
export const noiseFloor = (range: number) => CLUTTER.noise + 20 * Math.log10(Math.max(range, 100) / 1000) + CLUTTER.snr
