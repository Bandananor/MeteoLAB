import { CP, G } from './constants'
import type { EnvironmentProfile } from './environment'

export interface WeismanKlempOptions {
  /** Radius of the quarter-circle hodograph over the lowest 2 km, m/s. */ radius?: number
  /** Westerly wind at 6 km (constant above), m/s; the shear from 2 to 6 km is straight. */ u6?: number
  /** Boundary-layer mixing-ratio cap, kg/kg. */ qvMax?: number
}

/**
 * Weisman & Klemp (1982) sounding: theta = 300 + 43 (z/12 km)^1.25 K below the 12 km tropopause (213 K there, isothermal
 * above), RH = 1 - 0.75 (z/12 km)^1.25, vapour capped at 14 g/kg (CAPE ~2200 J/kg). Wind: the quarter-circle hodograph
 * of Weisman & Klemp (1984), turning 90° clockwise over the lowest 2 km, then a straight westerly shear to 6 km.
 */
export function weismanKlemp({ radius = 8, u6 = 30, qvMax = .014 }: WeismanKlempOptions = {}): EnvironmentProfile {
  const ztr = 12_000, thetaTr = 343, tTr = 213
  return {
    theta: z => z <= ztr ? 300 + (thetaTr - 300) * (z / ztr) ** 1.25 : thetaTr * Math.exp(G * (z - ztr) / (CP * tTr)),
    rh: z => z <= ztr ? 1 - .75 * (z / ztr) ** 1.25 : .25,
    wind: z => {
      if (z < 2000) { const a = Math.PI / 2 * z / 2000; return [radius - radius * Math.cos(a), radius * Math.sin(a)] }
      return [radius + (u6 - radius) * Math.min(1, (z - 2000) / 4000), radius]
    },
    qvMax,
  }
}
