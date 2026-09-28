import type { SimConfig } from './config'
import { EPS, G, KAPPA, RD } from './constants'
import type { Grid } from './grid'
import { lerp, lerpAngle, mod } from './math'
import { qsatP } from './microphysics'

const SURFACE_PRESSURE = 101325, PRESSURE_STEP = 10

/** The horizontally uniform environment (base state) the model starts from and relaxes towards. */
export class Environment {
  /** Base state at each model level; the environment only changes on restart. */
  readonly p: Float64Array; readonly exner: Float64Array; readonly theta: Float64Array
  readonly q: Float64Array; readonly u: Float64Array; readonly v: Float64Array
  /** Air density of the base state, kg/m3. */
  readonly rho: Float64Array
  private readonly config: SimConfig
  /** ln p every PRESSURE_STEP metres from the ground, integrated hydrostatically. */
  private readonly lnP: Float64Array

  constructor(config: SimConfig, grid: Grid) {
    this.config = config
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
    const tv = (z: number, p: number) => { const t = this.temperatureEnv(z), q = this.rhEnv(z) * this.qsatP(t, p); return (t + 273.15) * (1 + .61 * q) }
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

  temperatureEnv(z: number) {
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
    const c = this.config, tp = c.tropopause * 1000
    if (z < 1500) return lerp(c.rhSurface, c.rhLow, z / 1500) / 100
    if (z < 5000) return lerp(c.rhLow, c.rhMid, (z - 1500) / 3500) / 100
    if (z < tp) return lerp(c.rhMid, c.rhUpper, (z - 5000) / Math.max(1000, tp - 5000)) / 100
    return c.rhUpper / 100 * .7
  }

  qEnv(z: number) { return this.rhEnv(z) * this.qsat(this.temperatureEnv(z), z) }

  windScalar(z: number) {
    const c = this.config
    if (z < 3000) return lerp(c.wind0, c.wind3, z / 3000)
    if (z < 6000) return lerp(c.wind3, c.wind6, (z - 3000) / 3000)
    if (z < 10000) return lerp(c.wind6, c.wind10, (z - 6000) / 4000)
    return c.wind10
  }

  /** Direction the wind blows from, turning along the shorter arc between the nodes (350° to 10° passes north). */
  windDirection(z: number) {
    const c = this.config
    if (z < 3000) return lerpAngle(c.windDir0, c.windDir3, z / 3000)
    if (z < 6000) return lerpAngle(c.windDir3, c.windDir6, (z - 3000) / 3000)
    if (z < 10000) return lerpAngle(c.windDir6, c.windDir10, (z - 6000) / 4000)
    return mod(c.windDir10, 360)
  }

  /** Wind components (u eastward, v northward) from the meteorological speed/direction profile. */
  windUV(z: number) { const s = this.windScalar(z), a = (270 - this.windDirection(z)) * Math.PI / 180; return [s * Math.cos(a), s * Math.sin(a)] as const }

  dewpoint(q: number, z: number) { const e = Math.max(1, q * this.pressureAt(z) / (EPS + q)), l = Math.log(e / 611.2); return 243.5 * l / (17.67 - l) }
}
