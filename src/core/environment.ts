import type { SimConfig } from './config'
import { EPS, KAPPA } from './constants'
import type { Grid } from './grid'
import { clamp, lerp } from './math'

/** The horizontally uniform environment (base state) the model starts from and relaxes towards. */
export class Environment {
  /** Base state at each model level; the environment only changes on restart. */
  readonly p: Float64Array; readonly exner: Float64Array; readonly theta: Float64Array
  readonly q: Float64Array; readonly u: Float64Array; readonly v: Float64Array
  private readonly config: SimConfig

  constructor(config: SimConfig, grid: Grid) {
    this.config = config
    const f = () => new Float64Array(grid.nz)
    this.p = f(); this.exner = f(); this.theta = f(); this.q = f(); this.u = f(); this.v = f()
    for (let z = 0; z < grid.nz; z++) {
      const alt = z * grid.dz, [u, v] = this.windUV(alt)
      this.p[z] = this.pressureAt(alt); this.exner[z] = (this.p[z] / 100000) ** KAPPA
      this.theta[z] = this.thetaEnv(alt); this.q[z] = this.qEnv(alt); this.u[z] = u; this.v[z] = v
    }
  }

  pressureAt(z: number) { return 101325 * Math.exp(-z / 8000) }

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
  qsatP(t: number, p: number) { const es = 611.2 * Math.exp(17.67 * t / (t + 243.5)); return clamp(.622 * es / Math.max(1000, p - es), 0, .045) }

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

  windDirection(z: number) {
    const c = this.config
    if (z < 3000) return lerp(c.windDir0, c.windDir3, z / 3000)
    if (z < 6000) return lerp(c.windDir3, c.windDir6, (z - 3000) / 3000)
    if (z < 10000) return lerp(c.windDir6, c.windDir10, (z - 6000) / 4000)
    return c.windDir10
  }

  /** Wind components (u eastward, v northward) from the meteorological speed/direction profile. */
  windUV(z: number) { const s = this.windScalar(z), a = (270 - this.windDirection(z)) * Math.PI / 180; return [s * Math.cos(a), s * Math.sin(a)] as const }

  dewpoint(q: number, z: number) { const e = Math.max(1, q * this.pressureAt(z) / (EPS + q)), l = Math.log(e / 611.2); return 243.5 * l / (17.67 - l) }
}
