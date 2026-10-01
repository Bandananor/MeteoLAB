import { levelAt } from './grid'
import type { AtmosphereModel } from './model'
import { DBZ_FLOOR, reflectivity, reflectivityFallSpeed } from './radar'

/** Elevation angles of a NEXRAD volume scan (VCP 12/212), degrees. */
export const RADAR_TILTS = [.5, .9, 1.3, 1.8, 2.4, 3.1, 4, 5.1, 6.4, 8, 10, 12.5, 15.6, 19.5] as const

/** Effective Earth radius for standard refraction (4/3 of 6371 km), m. */
const EARTH = 4 / 3 * 6_371_000

/** Height of the beam centre above the radar, m, at slant range r (m) and elevation (degrees): the 4/3-Earth model. */
export function beamHeight(range: number, elevation: number) {
  const s = Math.sin(elevation * Math.PI / 180)
  return Math.sqrt(range * range + EARTH * EARTH + 2 * range * EARTH * s) - EARTH
}

/** Echo needed for a Doppler velocity estimate, dBZ: without scatterers the radar measures nothing. */
export const VELOCITY_MIN_DBZ = 5

/**
 * Plan position indicator over a w x h raster covering the domain (pixel (0, 0) at the north-west corner): reflectivity
 * (dBZ) and Doppler radial velocity (m/s, positive away from the radar) of the beam at one elevation, and the composite
 * reflectivity, the maximum over the whole volume scan (all RADAR_TILTS). The beam's ground track (grid x, y, azimuth)
 * is computed per radar site, its grid level per tilt (cached). `sample` and `composite` first compute reflectivity and
 * the precipitation's fall speed at the model nodes, then interpolate them along the beams. With `stormMotion` the
 * velocity is storm-relative (SRV): the storm's own motion, which masks a mesocyclone's couplet, is subtracted.
 */
export class PPI {
  readonly w: number; readonly h: number
  readonly dbz: Float32Array; readonly velocity: Float32Array; readonly compositeDbz: Float32Array
  private readonly gx: Float32Array; private readonly gy: Float32Array; private readonly sinAz: Float32Array; private readonly cosAz: Float32Array
  /** Grid level of the beam per tilt (-1 above the model top), for the current site. */
  private readonly levels = new Map<number, Float32Array>()
  /** Reflectivity (dBZ) and reflectivity-weighted fall speed (m/s) at the model nodes, refreshed by prepare(). */
  private readonly nodeDbz: Float32Array; private readonly nodeFall: Float32Array
  readonly model: AtmosphereModel
  site = { x: 0, y: 0 }; tilt: number = RADAR_TILTS[0]
  /** Storm motion (u, v, m/s) to subtract from the radial velocity (storm-relative velocity), or null (base velocity). */
  stormMotion: readonly [number, number] | null = null

  constructor(model: AtmosphereModel, w: number, h: number) {
    this.model = model; this.w = w; this.h = h
    const n = w * h, f = () => new Float32Array(n)
    this.dbz = f(); this.velocity = f(); this.compositeDbz = f(); this.gx = f(); this.gy = f(); this.sinAz = f(); this.cosAz = f()
    this.nodeDbz = new Float32Array(model.grid.n); this.nodeFall = new Float32Array(model.grid.n)
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

  /** Recomputes the beam's ground track after the site changed (the per-tilt levels are recomputed on demand). */
  layout() {
    const { dx, dy } = this.model.grid
    this.levels.clear()
    for (let py = 0, i = 0; py < this.h; py++) for (let px = 0; px < this.w; px++, i++) {
      const g = this.ground(px, py), ex = g.x - this.site.x, ny = g.y - this.site.y, range = Math.hypot(ex, ny)
      this.gx[i] = g.x / dx; this.gy[i] = g.y / dy
      this.sinAz[i] = range > 0 ? ex / range : 0; this.cosAz[i] = range > 0 ? ny / range : 0
    }
  }

  private levelsFor(tilt: number) {
    let gz = this.levels.get(tilt)
    if (gz) return gz
    const grid = this.model.grid
    gz = new Float32Array(this.w * this.h)
    for (let py = 0, i = 0; py < this.h; py++) for (let px = 0; px < this.w; px++, i++) {
      const g = this.ground(px, py), height = beamHeight(Math.hypot(g.x - this.site.x, g.y - this.site.y), tilt)
      gz[i] = height > grid.height ? -1 : levelAt(grid, height)
    }
    this.levels.set(tilt, gz)
    return gz
  }

  /** Reflectivity and fall speed of the precipitation at every model node, from the current fields. */
  private prepare() {
    const m = this.model, e = m.env, { nz, layer } = m.grid, rhoGround = e.rho[0]
    for (let z = 0, i = 0; z < nz; z++) {
      const rho = e.rho[z], exner = e.exner[z]
      for (let end = i + layer; i < end; i++) {
        const rain = m.rain[i], snow = m.snow[i], graupel = m.graupel[i]
        if (rain <= 0 && snow <= 0 && graupel <= 0) { this.nodeDbz[i] = DBZ_FLOOR; this.nodeFall[i] = 0; continue }
        const tc = m.theta[i] * exner - 273.15
        this.nodeDbz[i] = reflectivity(rho, rain, snow, graupel, tc); this.nodeFall[i] = reflectivityFallSpeed(rho, rhoGround, rain, snow, graupel, tc)
      }
    }
  }

  /**
   * Reflectivity and radial velocity of the current tilt: (u sin az + v cos az) cos el + (w - V_t) sin el, with V_t the
   * reflectivity-weighted fall speed (minus the storm motion's radial part for SRV); no velocity (NaN) where the echo is
   * below VELOCITY_MIN_DBZ.
   */
  sample() {
    this.prepare()
    const m = this.model, gz = this.levelsFor(this.tilt), el = this.tilt * Math.PI / 180, ce = Math.cos(el), se = Math.sin(el)
    const [su, sv] = this.stormMotion ?? [0, 0]
    for (let i = 0; i < this.dbz.length; i++) {
      const z = gz[i]
      if (z < 0) { this.dbz[i] = DBZ_FLOOR; this.velocity[i] = NaN; continue }
      const x = this.gx[i], y = this.gy[i], d = m.sample(this.nodeDbz, x, y, z)
      this.dbz[i] = d
      if (d < VELOCITY_MIN_DBZ) { this.velocity[i] = NaN; continue }
      this.velocity[i] = ((m.sample(m.u, x, y, z) - su) * this.sinAz[i] + (m.sample(m.v, x, y, z) - sv) * this.cosAz[i]) * ce + (m.sample(m.w, x, y, z) - m.sample(this.nodeFall, x, y, z)) * se
    }
  }

  /** Composite reflectivity: the strongest echo of the volume scan over each pixel. */
  composite() {
    this.prepare()
    const out = this.compositeDbz, m = this.model
    out.fill(DBZ_FLOOR)
    for (const tilt of RADAR_TILTS) {
      const gz = this.levelsFor(tilt)
      for (let i = 0; i < out.length; i++) { const z = gz[i]; if (z >= 0) { const d = m.sample(this.nodeDbz, this.gx[i], this.gy[i], z); if (d > out[i]) out[i] = d } }
    }
  }
}
