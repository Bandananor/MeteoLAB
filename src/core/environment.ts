import type { SimConfig } from './config'
import { EPS, G, KAPPA, RD } from './constants'
import type { Grid } from './grid'
import { lerp, lerpAngle, mod } from './math'
import { qsatP } from './microphysics'

const SURFACE_PRESSURE = 101325, PRESSURE_STEP = 10
/** The inversion of the capping layer is CAP_DEPTH thick; above it the extra warmth fades out over CAP_FADE (an elevated mixed layer). */
const CAP_DEPTH = 300, CAP_FADE = 2000

/**
 * An analytic environment (for idealised test cases such as Weisman-Klemp) that replaces the slider profile:
 * potential temperature, relative humidity (WMO, r = RH r_s) and wind (u east, v north, m/s) as functions of height.
 */
export interface EnvironmentProfile {
  theta(z: number): number
  rh(z: number): number
  wind(z: number): readonly [number, number]
  /** Upper limit of the vapour mixing ratio, kg/kg (the Weisman-Klemp boundary layer is capped at 14 g/kg). */
  qvMax?: number
}

/** The horizontally uniform environment (base state) the model starts from and relaxes towards. */
export class Environment {
  /** Base state at each model level; the environment only changes on restart. */
  readonly p: Float64Array; readonly exner: Float64Array; readonly theta: Float64Array
  readonly q: Float64Array; readonly u: Float64Array; readonly v: Float64Array
  /** Air density of the base state, kg/m3. */
  readonly rho: Float64Array
  private readonly config: SimConfig
  private readonly profile?: EnvironmentProfile
  /** ln p every PRESSURE_STEP metres from the ground, integrated hydrostatically. */
  private readonly lnP: Float64Array

  constructor(config: SimConfig, grid: Grid, profile?: EnvironmentProfile) {
    this.config = config; this.profile = profile
    this.lnP = this.integrateHydrostatic(grid.height + 2000)
    const f = () => new Float64Array(grid.nz)
    this.p = f(); this.exner = f(); this.theta = f(); this.q = f(); this.u = f(); this.v = f(); this.rho = f()
    for (let z = 0; z < grid.nz; z++) {
      const alt = z * grid.dz, [u, v] = this.windUV(alt)
      this.p[z] = this.pressureAt(alt); this.exner[z] = (this.p[z] / 100000) ** KAPPA
      this.theta[z] = this.thetaEnv(alt); this.q[z] = this.qEnv(alt); this.u[z] = u; this.v[z] = v
      this.rho[z] = this.p[z] / (RD * this.theta[z] * this.exner[z] * (1 + .61 * this.q[z]))
    }
  }

  /**
   * dp/dz = -p g / (Rd Tv) with Tv = T (1 + 0.61 q) of the environment itself, so pressure, temperature
   * and humidity of the base state are consistent (the old p0 exp(-z/8 km) was 20 % off at 15 km).
   */
  private integrateHydrostatic(top: number) {
    const n = Math.ceil(top / PRESSURE_STEP) + 1, lnP = new Float64Array(n)
    lnP[0] = Math.log(SURFACE_PRESSURE)
    const tv = (z: number, p: number) => { const t = this.temperatureAt(z, p), q = this.mixingRatio(z, t, p); return (t + 273.15) * (1 + .61 * q) }
    for (let k = 0; k + 1 < n; k++) {
      const z = k * PRESSURE_STEP, p = Math.exp(lnP[k])
      lnP[k + 1] = lnP[k] - G * PRESSURE_STEP / (RD * .5 * (tv(z, p) + tv(z + PRESSURE_STEP, p)))
    }
    return lnP
  }

  pressureAt(z: number) {
    const lnP = this.lnP, x = Math.max(0, z) / PRESSURE_STEP, k = Math.min(Math.floor(x), lnP.length - 2)
    return Math.exp(lnP[k] + (lnP[k + 1] - lnP[k]) * (x - k))
  }

  temperatureEnv(z: number) { return this.profile ? this.temperatureAt(z, this.pressureAt(z)) : this.sliderTemperature(z) }

  /** Temperature at height z and pressure p, °C (the pressure matters only for a profile given in theta). */
  private temperatureAt(z: number, p: number) { return this.profile ? this.profile.theta(z) * (p / 100000) ** KAPPA - 273.15 : this.sliderTemperature(z) }

  /** Lapse-rate profile plus the capping inversion (if any): the air warms by capStrength across CAP_DEPTH at capHeight. */
  private sliderTemperature(z: number) {
    const c = this.config, strength = c.capStrength ?? 0
    if (!(strength > 0)) return this.lapseTemperature(z)
    const base = (c.capHeight ?? 1.5) * 1000, top = base + CAP_DEPTH
    const bump = strength + this.lapseTemperature(base) - this.lapseTemperature(top)
    const f = z <= base ? 0 : z < top ? (z - base) / CAP_DEPTH : Math.max(0, 1 - (z - top) / CAP_FADE)
    return this.lapseTemperature(z) + bump * f
  }

  private lapseTemperature(z: number) {
    const c = this.config, tp = c.tropopause * 1000, t3 = c.surfaceTemp - c.lapseLow * 3, t8 = t3 - c.lapseMid * 5
    if (z <= 3000) return c.surfaceTemp - c.lapseLow * z / 1000
    if (z <= 8000) return t3 - c.lapseMid * (z - 3000) / 1000
    const ttp = t8 - c.lapseUpper * (tp - 8000) / 1000
    if (z <= tp) return t8 - c.lapseUpper * (z - 8000) / 1000
    return ttp + c.stratoWarming * (z - tp) / 1000
  }

  thetaEnv(z: number) { return (this.temperatureEnv(z) + 273.15) * (100000 / this.pressureAt(z)) ** KAPPA }

  qsat(t: number, z: number) { return this.qsatP(t, this.pressureAt(z)) }
  qsatP(t: number, p: number) { return qsatP(t, p) }

  rhEnv(z: number) {
    if (this.profile) return this.profile.rh(z)
    const c = this.config, tp = c.tropopause * 1000
    if (z < 1500) return lerp(c.rhSurface, c.rhLow, z / 1500) / 100
    if (z < 5000) return lerp(c.rhLow, c.rhMid, (z - 1500) / 3500) / 100
    if (z < tp) return lerp(c.rhMid, c.rhUpper, (z - 5000) / Math.max(1000, tp - 5000)) / 100
    return c.rhUpper / 100 * .7
  }

  qEnv(z: number) { return this.mixingRatio(z, this.temperatureEnv(z), this.pressureAt(z)) }

  /** Vapour mixing ratio of air at height z with temperature t (°C) and pressure p: RH r_s, capped by the profile. */
  mixingRatio(z: number, t: number, p: number) {
    const r = Math.min(this.rhEnv(z) * this.qsatP(t, p), this.profile?.qvMax ?? Infinity), top = (this.config.moistLayer ?? 0) * 1000
    if (this.profile || z >= top) return r
    // Well-mixed boundary layer: the surface mixing ratio holds up to its top (never supersaturated).
    const surface = this.config.rhSurface / 100 * this.qsatP(this.config.surfaceTemp, SURFACE_PRESSURE)
    return Math.min(Math.max(r, surface), this.qsatP(t, p))
  }

  /** Wind nodes (height m, speed m/s, direction °) of the slider profile; the 0.5 and 1 km nodes are optional. */
  private windNodes(): [number, number, number][] {
    const c = this.config, nodes: [number, number, number][] = [[0, c.wind0, c.windDir0]]
    if (c.wind05 !== undefined && c.windDir05 !== undefined) nodes.push([500, c.wind05, c.windDir05])
    if (c.wind1 !== undefined && c.windDir1 !== undefined) nodes.push([1000, c.wind1, c.windDir1])
    nodes.push([3000, c.wind3, c.windDir3], [6000, c.wind6, c.windDir6], [10000, c.wind10, c.windDir10])
    return nodes
  }

  // Linear in speed, shorter arc in direction, between consecutive nodes; constant above the top node.
  private windAt(z: number, component: 1 | 2) {
    const nodes = this.windNodes(), interpolate = component === 1 ? lerp : lerpAngle
    for (let k = 1; k < nodes.length; k++) if (z < nodes[k][0]) { const a = nodes[k - 1], b = nodes[k]; return interpolate(a[component], b[component], (z - a[0]) / (b[0] - a[0])) }
    const top = nodes[nodes.length - 1][component]
    return component === 1 ? top : mod(top, 360)
  }

  windScalar(z: number) { return this.windAt(z, 1) }

  /** Direction the wind blows from, turning along the shorter arc between the nodes (350° to 10° passes north). */
  windDirection(z: number) { return this.windAt(z, 2) }

  /** Wind components (u eastward, v northward) from the meteorological speed/direction profile. */
  windUV(z: number) {
    if (this.profile) return this.profile.wind(z)
    const s = this.windScalar(z), a = (270 - this.windDirection(z)) * Math.PI / 180; return [s * Math.cos(a), s * Math.sin(a)] as const
  }

  dewpoint(q: number, z: number) { const e = Math.max(1, q * this.pressureAt(z) / (EPS + q)), l = Math.log(e / 611.2); return 243.5 * l / (17.67 - l) }
}
