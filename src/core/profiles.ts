import type { SimConfig } from './config'
import { CP, G } from './constants'
import type { EnvironmentProfile } from './environment'
import { type SoundingLevel, soundingProfile } from './soundingfile'

/**
 * The environment a configuration asks for instead of the slider profile, or undefined for the sliders: a loaded
 * sounding (up to `height`, the domain's top, plus the 2 km the base state is integrated above it) or Weisman-Klemp.
 */
export function environmentProfile(config: SimConfig, height: number): EnvironmentProfile | undefined {
  if (config.sounding) return soundingProfile(config.sounding, height + 2000).profile
  return config.profile === 'weisman-klemp' ? weismanKlemp({ qvMax: .016, ...config.weismanKlemp }) : undefined
}

/**
 * An idealised sounding of elevated thundersnow (13.11.2026, tests/bench/winter.ts and .bench/winter): a near-isothermal
 * cold layer at the ground (-2 °C, -0.5 K/km, to 0.8 km), a frontal inversion up to a warm nose that stays below 0 °C
 * (-1 °C at 1.5 km, so the snow does not melt), and above it moist air (95 %) with 8 K/km up to a 9 km tropopause. The
 * wind veers from a north-easterly 8 m/s at the ground to a south-westerly 30 m/s at 3 km — warm advection over the cold
 * dome. Its own parcels: SB CAPE 0, MU CAPE ~160 J/kg from 1.8 km, EL ~6.3 km, the -10 °C level at 2.8 km (winter
 * lightning needs it above ~1.4-1.8 km, Kitagawa & Michimoto 1994, abstract). Levels every 250 m to 16 km, hydrostatic.
 */
export function elevatedSnowSounding(): SoundingLevel[] {
  const t0 = -2, cold = .8, nose = -1, base = 1.5, lapse = 8, rh = 95, trop = 9, low = [8, 60], aloft = [30, 230]
  const tAt = (km: number) => {
    if (km <= cold) return t0 - .5 * km
    const top = t0 - .5 * cold
    if (km <= base) return top + (nose - top) * (km - cold) / (base - cold)
    if (km <= trop) return nose - lapse * (km - base)
    return nose - lapse * (trop - base) + (km - trop)
  }
  const rhAt = (km: number) => km <= cold ? 92 : km <= base ? 85 : km <= 6 ? rh : km <= trop ? 60 : 20
  const es = (t: number) => 611.2 * Math.exp(17.67 * t / (t + 243.5))
  const levels: SoundingLevel[] = []
  let p = 100000
  for (let z = 0; z <= 16000; z += 250) {
    const km = z / 1000, t = tAt(km), e = es(t) * rhAt(km) / 100, x = Math.log(e / 611.2), f = Math.min(1, km / 3)
    const speed = low[0] + (aloft[0] - low[0]) * f, dir = (low[1] + (aloft[1] - low[1]) * f) * Math.PI / 180
    levels.push({ p, z, t, td: 243.5 * x / (17.67 - x), u: -speed * Math.sin(dir), v: -speed * Math.cos(dir) })
    p *= Math.exp(-G * 250 / (287 * (t + 273.15 - .8125)))
  }
  return levels
}

export interface WeismanKlempOptions {
  /** Radius of the quarter-circle hodograph over the lowest 2 km, m/s. */ radius?: number
  /** Westerly wind at 6 km (constant above), m/s; the shear from 2 to 6 km is straight. */ u6?: number
  /** Boundary-layer mixing-ratio cap, kg/kg. */ qvMax?: number
  /**
   * Depth of a unidirectional shear instead of the quarter circle, m: the westerly wind grows linearly from 0 at the
   * ground to u6 at this height, constant above (Weisman 1993's bow echoes: 20 m/s over 2.5 or 5 km). Absent = the
   * quarter circle and the 2-6 km shear.
   */ depth?: number
}

/**
 * Weisman & Klemp (1982) sounding: theta = 300 + 43 (z/12 km)^1.25 K below the 12 km tropopause (213 K there, isothermal
 * above), RH = 1 - 0.75 (z/12 km)^1.25, vapour capped at 14 g/kg (CAPE ~2200 J/kg). Wind: the quarter-circle hodograph
 * of Weisman & Klemp (1984), turning 90° clockwise over the lowest 2 km, then a straight westerly shear to 6 km.
 */
export function weismanKlemp({ radius = 8, u6 = 30, qvMax = .014, depth }: WeismanKlempOptions = {}): EnvironmentProfile {
  const ztr = 12_000, thetaTr = 343, tTr = 213
  return {
    theta: z => z <= ztr ? 300 + (thetaTr - 300) * (z / ztr) ** 1.25 : thetaTr * Math.exp(G * (z - ztr) / (CP * tTr)),
    rh: z => z <= ztr ? 1 - .75 * (z / ztr) ** 1.25 : .25,
    wind: z => {
      if (depth) return [u6 * Math.min(1, z / depth), 0]
      if (z < 2000) { const a = Math.PI / 2 * z / 2000; return [radius - radius * Math.cos(a), radius * Math.sin(a)] }
      return [radius + (u6 - radius) * Math.min(1, (z - 2000) / 4000), radius]
    },
    qvMax,
  }
}
