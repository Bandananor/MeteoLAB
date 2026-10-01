import { levelAt } from './grid'
import type { AtmosphereModel } from './model'
import { DBZ_FLOOR, reflectivity } from './radar'

/** Elevation angles of a NEXRAD volume scan (VCP 12/212), degrees. */
export const RADAR_TILTS = [.5, .9, 1.3, 1.8, 2.4, 3.1, 4, 5.1, 6.4, 8, 10, 12.5, 15.6, 19.5] as const

/** Effective Earth radius for standard refraction (4/3 of 6371 km), m. */
const EARTH = 4 / 3 * 6_371_000

/** Height of the beam centre above the radar, m, at slant range r (m) and elevation (degrees): the 4/3-Earth model. */
export function beamHeight(range: number, elevation: number) {
  const s = Math.sin(elevation * Math.PI / 180)
  return Math.sqrt(range * range + EARTH * EARTH + 2 * range * EARTH * s) - EARTH
}

/**
 * Plan position indicator: reflectivity (dBZ) of the beam at one elevation over a w x h raster covering the domain
 * (pixel (0, 0) at the north-west corner). The geometry (grid coordinates of each pixel's beam) is precomputed per
 * radar site and tilt; `sample` reads the model's current fields.
 */
export class PPI {
  readonly w: number; readonly h: number
  readonly dbz: Float32Array
  private readonly gx: Float32Array; private readonly gy: Float32Array; private readonly gz: Float32Array
  readonly model: AtmosphereModel
  site = { x: 0, y: 0 }; tilt: number = RADAR_TILTS[0]

  constructor(model: AtmosphereModel, w: number, h: number) {
    this.model = model; this.w = w; this.h = h
    this.dbz = new Float32Array(w * h); this.gx = new Float32Array(w * h); this.gy = new Float32Array(w * h); this.gz = new Float32Array(w * h)
    this.site = { x: model.grid.width / 2, y: model.grid.depth / 2 }
    this.layout()
  }

  /** Ground position (m from the domain's south-west corner) of a pixel centre. */
  ground(px: number, py: number) { const { width, depth } = this.model.grid; return { x: (px + .5) / this.w * width, y: depth - (py + .5) / this.h * depth } }

  /** Range (m), azimuth (degrees clockwise from north) and beam height (m) at a ground point. */
  beamAt(x: number, y: number) {
    const dx = x - this.site.x, dy = y - this.site.y, range = Math.hypot(dx, dy)
    return { range, azimuth: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360, height: beamHeight(range, this.tilt) }
  }

  /** Recomputes the beam geometry after the site or the tilt changed. */
  layout() {
    const { dx, dy } = this.model.grid
    for (let py = 0, i = 0; py < this.h; py++) for (let px = 0; px < this.w; px++, i++) {
      const g = this.ground(px, py), b = this.beamAt(g.x, g.y)
      this.gx[i] = g.x / dx; this.gy[i] = g.y / dy; this.gz[i] = b.height > this.model.grid.height ? -1 : levelAt(this.model.grid, b.height)
    }
  }

  /** Samples the current fields along the beam into dbz (DBZ_FLOOR above the model top). */
  sample() {
    const m = this.model, e = m.env, { nz } = m.grid
    for (let i = 0; i < this.dbz.length; i++) {
      const gz = this.gz[i]
      if (gz < 0) { this.dbz[i] = DBZ_FLOOR; continue }
      const x = this.gx[i], y = this.gy[i], k = Math.min(Math.floor(gz), nz - 2), f = gz - k
      const rho = e.rho[k] + f * (e.rho[k + 1] - e.rho[k]), exner = e.exner[k] + f * (e.exner[k + 1] - e.exner[k])
      this.dbz[i] = reflectivity(rho, m.sample(m.rain, x, y, gz), m.sample(m.snow, x, y, gz), m.sample(m.graupel, x, y, gz), m.sample(m.theta, x, y, gz) * exner - 273.15)
    }
  }
}
