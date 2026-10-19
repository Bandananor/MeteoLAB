import { heightAt, levelAt } from './grid'
import type { AtmosphereModel } from './model'
import { dualPol } from './polarimetry'
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
/** Echo needed for the dual-polarisation products, dBZ (weaker echo is too noisy for ZDR and rho_hv on a real radar). */
export const DUAL_MIN_DBZ = 10

/**
 * Plan position indicator over a w x h raster covering the domain (pixel (0, 0) at the north-west corner): reflectivity
 * (dBZ) and Doppler radial velocity (m/s, positive away from the radar) of the beam at one elevation, and the composite
 * reflectivity, the maximum over the whole volume scan (all RADAR_TILTS). The beam's ground track (grid x, y, azimuth)
 * is computed per radar site, its grid level per tilt (cached). `sample` and `composite` first compute reflectivity and
 * the precipitation's fall speed at the model nodes, then interpolate them along the beams. With `stormMotion` the
 * velocity is storm-relative (SRV): the storm's own motion, which masks a mesocyclone's couplet, is subtracted.
 * The raster, the site and every position are fixed to the ground: when the model domain follows the storm
 * (AtmosphereModel.frame), the storm moves across the screen as past a real radar. With `dual` set, `sample` and
 * `section` also give the dual-polarisation products (polarimetry.ts): ZDR (dB), rho_hv and KDP (deg/km), NaN below
 * DUAL_MIN_DBZ.
 */
/** The echo top's reflectivity, dBZ (NWS enhanced echo tops), and the reflectivity VIL counts at most, dBZ (hail above it). */
export const ECHO_TOP_DBZ = 18, VIL_MAX_DBZ = 56

export class PPI {
  readonly w: number; readonly h: number
  readonly dbz: Float32Array; readonly velocity: Float32Array; readonly compositeDbz: Float32Array
  readonly zdr: Float32Array; readonly rho: Float32Array; readonly kdp: Float32Array
  /** From the whole volume scan with composite(): vertically integrated liquid (kg/m²) and the echo top (km, 0: none). */
  readonly vil: Float32Array; readonly echoTop: Float32Array
  /** 1 where even the highest tilt still has ECHO_TOP_DBZ: the echo top is above it (the cone of silence), a lower bound. */
  readonly echoTopped: Uint8Array
  /** The maximum expected size of hail (MESH, mm) from the volume scan, with composite(). */
  readonly mesh: Float32Array
  private readonly gx: Float32Array; private readonly gy: Float32Array; private readonly sinAz: Float32Array; private readonly cosAz: Float32Array
  /** Grid level of the beam per tilt (-1 above the model top), for the current site. */
  private readonly levels = new Map<number, Float32Array>()
  /** Reflectivity (dBZ) and reflectivity-weighted fall speed (m/s) at the model nodes, refreshed by prepare(). */
  private readonly nodeDbz: Float32Array; private readonly nodeFall: Float32Array
  /** ZDR, rho_hv and KDP at the model nodes (prepared only with `dual`; without precipitation 0, 1 and 0). */
  private readonly nodeZdr: Float32Array; private readonly nodeRho: Float32Array; private readonly nodeKdp: Float32Array
  readonly model: AtmosphereModel
  site = { x: 0, y: 0 }; tilt: number = RADAR_TILTS[0]
  /** Storm motion (u, v, m/s) to subtract from the radial velocity (storm-relative velocity), or null (base velocity). */
  stormMotion: readonly [number, number] | null = null
  /** Whether prepare(), sample() and section() also do ZDR, rho_hv and KDP. */
  dual = false
  /**
   * Radial bins like real radar data (null: every pixel sampled at its own centre): `gate` m along the beam and `beam`
   * degrees across it. Every pixel of a bin shows the bin's value, sampled at the bin's centre, so the scan looks as on a
   * radar display — sectors that widen with range. Call layout() after changing it.
   */
  bins: { gate: number; beam: number } | null = null

  constructor(model: AtmosphereModel, w: number, h: number) {
    this.model = model; this.w = w; this.h = h
    const n = w * h, f = () => new Float32Array(n)
    this.dbz = f(); this.velocity = f(); this.compositeDbz = f(); this.zdr = f(); this.rho = f(); this.kdp = f(); this.vil = f(); this.echoTop = f(); this.echoTopped = new Uint8Array(n); this.mesh = f(); this.gx = f(); this.gy = f(); this.sinAz = f(); this.cosAz = f()
    this.nodeDbz = new Float32Array(model.grid.n); this.nodeFall = new Float32Array(model.grid.n)
    this.nodeZdr = new Float32Array(model.grid.n); this.nodeRho = new Float32Array(model.grid.n).fill(1); this.nodeKdp = new Float32Array(model.grid.n)
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

  /** Where the radar samples for a pixel: its centre, or with `bins` the centre of the radial bin it lies in. */
  private samplePoint(px: number, py: number) {
    const g = this.ground(px, py), b = this.bins
    if (!b) return g
    const ex = g.x - this.site.x, ny = g.y - this.site.y, range = (Math.floor(Math.hypot(ex, ny) / b.gate) + .5) * b.gate
    const azimuth = (Math.floor(((Math.atan2(ex, ny) * 180 / Math.PI + 360) % 360) / b.beam) + .5) * b.beam * Math.PI / 180
    return { x: this.site.x + range * Math.sin(azimuth), y: this.site.y + range * Math.cos(azimuth) }
  }

  /** Recomputes the beam's ground track after the site or the bins changed (the per-tilt levels are recomputed on demand). */
  layout() {
    const { dx, dy } = this.model.grid
    this.levels.clear()
    for (let py = 0, i = 0; py < this.h; py++) for (let px = 0; px < this.w; px++, i++) {
      const g = this.samplePoint(px, py), ex = g.x - this.site.x, ny = g.y - this.site.y, range = Math.hypot(ex, ny)
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
      const g = this.samplePoint(px, py), height = beamHeight(Math.hypot(g.x - this.site.x, g.y - this.site.y), tilt)
      gz[i] = height > grid.height ? -1 : levelAt(grid, height)
    }
    this.levels.set(tilt, gz)
    return gz
  }

  /** Distance the moving domain has travelled, in grid columns (x, y): ground point X lies over model point X - shift. */
  private shift() { const [ox, oy] = this.model.frameOffset(); return [ox / this.model.grid.dx, oy / this.model.grid.dy] as const }

  /** Reflectivity and fall speed of the precipitation at every model node, from the current fields (sample and composite call it). */
  prepare() {
    const m = this.model, e = m.env, { nz, layer } = m.grid, rhoGround = e.rho[0], dual = this.dual
    for (let z = 0, i = 0; z < nz; z++) {
      const rho = e.rho[z], exner = e.exner[z]
      for (let end = i + layer; i < end; i++) {
        const rain = m.rain[i], snow = m.snow[i], graupel = m.graupel[i], hail = m.hail[i]
        if (rain <= 0 && snow <= 0 && graupel <= 0 && hail <= 0) {
          this.nodeDbz[i] = DBZ_FLOOR; this.nodeFall[i] = 0
          if (dual) { this.nodeZdr[i] = 0; this.nodeRho[i] = 1; this.nodeKdp[i] = 0 }
          continue
        }
        const tc = m.theta[i] * exner - 273.15
        this.nodeDbz[i] = reflectivity(rho, rain, snow, graupel, tc, hail); this.nodeFall[i] = reflectivityFallSpeed(rho, rhoGround, rain, snow, graupel, tc, hail)
        if (dual) { const d = dualPol(rho, rain, snow, graupel, tc, hail); this.nodeZdr[i] = d.zdr; this.nodeRho[i] = d.rho; this.nodeKdp[i] = d.kdp }
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
    // Ground-fixed raster over the moving domain: the model column under a pixel is shifted back by the distance the domain
    // has moved, and the radial wind is over the ground (model wind plus the frame velocity), minus the storm motion for SRV.
    const [ox, oy] = this.shift(), [fu, fv] = m.frame, [su, sv] = this.stormMotion ?? [0, 0], cu = fu - su, cv = fv - sv
    for (let i = 0; i < this.dbz.length; i++) {
      const z = gz[i]
      if (z < 0) { this.dbz[i] = DBZ_FLOOR; this.velocity[i] = this.zdr[i] = this.rho[i] = this.kdp[i] = NaN; continue }
      const x = this.gx[i] - ox, y = this.gy[i] - oy, d = m.sample(this.nodeDbz, x, y, z)
      this.dbz[i] = d
      if (this.dual) {
        const echo = d >= DUAL_MIN_DBZ
        this.zdr[i] = echo ? m.sample(this.nodeZdr, x, y, z) : NaN; this.rho[i] = echo ? m.sample(this.nodeRho, x, y, z) : NaN; this.kdp[i] = echo ? m.sample(this.nodeKdp, x, y, z) : NaN
      }
      if (d < VELOCITY_MIN_DBZ) { this.velocity[i] = NaN; continue }
      this.velocity[i] = ((m.sample(m.u, x, y, z) + cu) * this.sinAz[i] + (m.sample(m.v, x, y, z) + cv) * this.cosAz[i]) * ce + (m.sample(m.w, x, y, z) - m.sample(this.nodeFall, x, y, z)) * se
    }
  }

  /**
   * The volume scan's products over each pixel: the composite reflectivity (the strongest echo), the echo top (the
   * highest beam with at least ECHO_TOP_DBZ, as the NWS enhanced echo tops) and VIL — the liquid water the reflectivity
   * implies, integrated between the tilts' beam heights: 3.44e-6 Z^(4/7) kg/m³ (Greene & Clark 1972), Z (mm⁶/m³) capped at
   * VIL_MAX_DBZ so hail does not count as water. And MESH, the maximum expected size of hail (Witt et al. 1998): the
   * severe hail index SHI = 0.1 ∫ W_T(H) E dH, the hail kinetic energy flux E = 5e-6 10^(0.084 Z) W(Z) (W from 0 at 40 dBZ to
   * 1 at 50), weighted W_T from 0 at the melting level to 1 at the -20 °C level (the starting environment's), and
   * MESH = 2.54 SHI^0.5 mm.
   */
  composite() {
    this.prepare()
    const out = this.compositeDbz, m = this.model, grid = m.grid, vil = this.vil, top = this.echoTop
    const [ox, oy] = this.shift(), last = new Float32Array(out.length).fill(NaN), lastH = new Float32Array(out.length), lastE = new Float32Array(out.length), mesh = this.mesh
    out.fill(DBZ_FLOOR); vil.fill(0); top.fill(0); this.echoTopped.fill(0); mesh.fill(0)
    let h0 = 0, h20 = 0
    while (h0 < grid.height && m.env.temperatureEnv(h0) > 0) h0 += 25
    h20 = h0; while (h20 < grid.height && m.env.temperatureEnv(h20) > -20) h20 += 25
    for (const tilt of RADAR_TILTS) {
      const gz = this.levelsFor(tilt)
      for (let i = 0; i < out.length; i++) {
        const z = gz[i]
        if (z < 0) continue
        const d = m.sample(this.nodeDbz, this.gx[i] - ox, this.gy[i] - oy, z), h = heightAt(grid, z)
        if (d > out[i]) out[i] = d
        if (d >= ECHO_TOP_DBZ) top[i] = Math.max(top[i], h / 1000)
        if (tilt === RADAR_TILTS[RADAR_TILTS.length - 1]) this.echoTopped[i] = d >= ECHO_TOP_DBZ ? 1 : 0
        const zl = d > DBZ_FLOOR ? 10 ** (Math.min(d, VIL_MAX_DBZ) / 10) : 0
        if (!Number.isNaN(last[i]) && h > lastH[i]) vil[i] += 3.44e-6 * ((last[i] + zl) / 2) ** (4 / 7) * (h - lastH[i])
        const e = d > 40 ? 5e-6 * 10 ** (.084 * d) * Math.min(1, (d - 40) / 10) * Math.max(0, Math.min(1, (h - h0) / Math.max(1, h20 - h0))) : 0
        if (!Number.isNaN(last[i]) && h > lastH[i]) mesh[i] += .1 * (lastE[i] + e) / 2 * (h - lastH[i])
        last[i] = zl; lastH[i] = h; lastE[i] = e
      }
    }
    for (let i = 0; i < mesh.length; i++) mesh[i] = 2.54 * Math.sqrt(mesh[i])
  }

  /**
   * Vertical section from the site along `azimuth` (degrees clockwise from north), like an RHI scan through the full
   * volume (call prepare() first): crossSection() from the site to `gates` * `step` m along the azimuth, so gate g lies at
   * range (g + 0.5) step.
   */
  section(azimuth: number, step: number, gates: number, dz: number, rows: number) {
    const a = azimuth * Math.PI / 180, length = gates * step
    return this.crossSection(this.site, { x: this.site.x + length * Math.sin(a), y: this.site.y + length * Math.cos(a) }, gates, dz, rows)
  }

  /**
   * Vertical section along the straight line from ground point `a` to `b` (m), through the full volume (call prepare()
   * first): reflectivity and radial velocity at `gates` points (gate g at (g + 0.5) / gates of the way) and `rows`
   * heights `dz` m apart (row k at (k + 0.5) dz), row-major from the ground up. The radial velocity at each point is
   * along the ray from the radar to it (azimuth from the site, elevation atan(h / r)): ground-relative wind, minus the fall
   * speed, minus `stormMotion` if set; NaN without echo. With `dual` also ZDR, rho_hv and KDP (NaN below DUAL_MIN_DBZ;
   * empty arrays without it). Also per gate: the range from the radar (m), the beam height of every tilt there (m, in
   * RADAR_TILTS order) and the heights of the 0 °C and -20 °C isotherms in the column (m, the lowest crossing from warm
   * to cold; NaN if none). Periodic like the model; above the model top: no echo.
   */
  crossSection(a: { x: number; y: number }, b: { x: number; y: number }, gates: number, dz: number, rows: number) {
    const m = this.model, grid = m.grid, { dx, dy, nz } = grid, [ox, oy] = this.shift(), e = m.env
    const [fu, fv] = m.frame, [su, sv] = this.stormMotion ?? [0, 0], cu = fu - su, cv = fv - sv
    const dbz = new Float32Array(gates * rows).fill(DBZ_FLOOR), velocity = new Float32Array(gates * rows).fill(NaN), dual = this.dual
    const nan = () => new Float32Array(dual ? gates * rows : 0).fill(NaN), zdr = nan(), rho = nan(), kdp = nan()
    const range = new Float32Array(gates), iso0 = new Float32Array(gates).fill(NaN), iso20 = new Float32Array(gates).fill(NaN)
    const sinAz = new Float32Array(gates), cosAz = new Float32Array(gates), gxs = new Float32Array(gates), gys = new Float32Array(gates)
    for (let g = 0; g < gates; g++) {
      const t = (g + .5) / gates, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, ex = x - this.site.x, ny = y - this.site.y, r = Math.hypot(ex, ny)
      range[g] = r; sinAz[g] = r > 0 ? ex / r : 0; cosAz[g] = r > 0 ? ny / r : 0; gxs[g] = x / dx - ox; gys[g] = y / dy - oy
      // The isotherms: the first level where the column turns colder than 0 °C, then -20 °C (interpolated between levels).
      let below = m.sample(m.theta, gxs[g], gys[g], 0) * e.exner[0] - 273.15
      for (let z = 1; z < nz && Number.isNaN(iso20[g]); z++) {
        const tc = m.sample(m.theta, gxs[g], gys[g], z) * e.exner[z] - 273.15
        for (const [level, out] of [[0, iso0], [-20, iso20]] as const) if (Number.isNaN(out[g]) && below > level && tc <= level) out[g] = grid.zs[z - 1] + (below - level) / (below - tc) * (grid.zs[z] - grid.zs[z - 1])
        below = tc
      }
    }
    const beams = RADAR_TILTS.map(tilt => Float32Array.from(range, r => beamHeight(r, tilt)))
    for (let k = 0; k < rows; k++) {
      const h = (k + .5) * dz
      if (h > grid.height) break
      const z = levelAt(grid, h)
      for (let g = 0; g < gates; g++) {
        const gx = gxs[g], gy = gys[g], i = k * gates + g, d = m.sample(this.nodeDbz, gx, gy, z)
        dbz[i] = d
        if (dual && d >= DUAL_MIN_DBZ) { zdr[i] = m.sample(this.nodeZdr, gx, gy, z); rho[i] = m.sample(this.nodeRho, gx, gy, z); kdp[i] = m.sample(this.nodeKdp, gx, gy, z) }
        if (d < VELOCITY_MIN_DBZ) continue
        const el = Math.atan2(h, range[g])
        velocity[i] = ((m.sample(m.u, gx, gy, z) + cu) * sinAz[g] + (m.sample(m.v, gx, gy, z) + cv) * cosAz[g]) * Math.cos(el) + (m.sample(m.w, gx, gy, z) - m.sample(this.nodeFall, gx, gy, z)) * Math.sin(el)
      }
    }
    return { dbz, velocity, zdr, rho, kdp, range, beams, iso0, iso20 }
  }

  /** Reflectivity (dBZ) the beam of `tilt` sees over a ground point, m (call prepare() first; periodic like the model). */
  dbzAt(x: number, y: number, tilt: number) {
    const m = this.model, grid = m.grid, h = beamHeight(Math.hypot(x - this.site.x, y - this.site.y), tilt)
    if (h > grid.height) return DBZ_FLOOR
    const [ox, oy] = this.shift()
    return m.sample(this.nodeDbz, x / grid.dx - ox, y / grid.dy - oy, levelAt(grid, h))
  }

  /**
   * Polar scan of one tilt for the detection algorithms (call prepare() first): reflectivity and base radial velocity at
   * `gates` range gates `step` m apart (gate g at range (g + 1) * step) on `beams` azimuths (beam b at b * 360 / beams
   * degrees), beam-major. Beams leave the domain on one side and come back on the other, as the periodic model does (a
   * storm across the edge is seen whole). Above the model top: no echo; without echo the velocity is NaN.
   */
  polar(tilt: number, step: number, gates: number, beams: number) {
    const m = this.model, grid = m.grid, { dx, dy } = grid, el = tilt * Math.PI / 180, ce = Math.cos(el), se = Math.sin(el), [ox, oy] = this.shift(), [fu, fv] = m.frame
    const dbz = new Float32Array(gates * beams).fill(DBZ_FLOOR), velocity = new Float32Array(gates * beams).fill(NaN)
    const levels = Float64Array.from({ length: gates }, (_, g) => { const h = beamHeight((g + 1) * step, tilt); return h > grid.height ? -1 : levelAt(grid, h) })
    for (let b = 0; b < beams; b++) {
      const az = b * 2 * Math.PI / beams, sa = Math.sin(az), ca = Math.cos(az)
      for (let g = 0; g < gates; g++) {
        const r = (g + 1) * step, x = this.site.x + r * sa, y = this.site.y + r * ca, z = levels[g], i = b * gates + g
        if (z < 0) continue
        const gx = x / dx - ox, gy = y / dy - oy, d = m.sample(this.nodeDbz, gx, gy, z)
        dbz[i] = d
        if (d >= VELOCITY_MIN_DBZ) velocity[i] = ((m.sample(m.u, gx, gy, z) + fu) * sa + (m.sample(m.v, gx, gy, z) + fv) * ca) * ce + (m.sample(m.w, gx, gy, z) - m.sample(this.nodeFall, gx, gy, z)) * se
      }
    }
    return { dbz, velocity }
  }
}
