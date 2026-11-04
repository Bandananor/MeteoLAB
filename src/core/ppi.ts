import { heightAt, levelAt } from './grid'
import type { AtmosphereModel } from './model'
import { dualPol } from './polarimetry'
import { DBZ_FLOOR, reflectivity, reflectivityFallSpeed } from './radar'
import { RADARS, type RadarProfile } from './radars'
import { phenomenon, RD_CRITERIA } from './phenomena'
import { specificAttenuation } from './attenuation'
import { clutterAt, noiseFloor } from './clutter'

/** Elevation angles of a NEXRAD volume scan (VCP 12/212), degrees: the WSR-88D profile's. */
export const RADAR_TILTS = RADARS.wsr88d.tilts

/** Effective Earth radius for standard refraction (4/3 of 6371 km), m. */
const EARTH = 4 / 3 * 6_371_000

/** Height of the beam centre above the radar, m, at slant range r (m) and elevation (degrees): the 4/3-Earth model. */
export function beamHeight(range: number, elevation: number) {
  const s = Math.sin(elevation * Math.PI / 180)
  return Math.sqrt(range * range + EARTH * EARTH + 2 * range * EARTH * s) - EARTH
}

/**
 * VAD winds (Browning & Wexler 1968; NEXRAD VWP): slant ranges of the rings tried, longest first (the VAD's 30 km and the
 * enhanced VWP's 20 and 10 km), the fewest points and the azimuths a ring needs (>= 150° below 2°, >= 75° above - Losey et
 * al. 2017) and the largest RMS of the fit, m/s (5, the NEXRAD VAD's - from secondary sources).
 */
export const VAD = { ranges: [30_000, 20_000, 10_000], points: 25, coverLow: 150, coverHigh: 75, rms: 5 } as const

export interface VadWind {
  /** Height of the ring, m; slant range, m; tilt, degrees. */ height: number; range: number; tilt: number
  /** Wind toward the east and the north, m/s (over the ground); RMS of the fit, m/s; points and azimuths covered, degrees. */
  u: number; v: number; rms: number; points: number; cover: number
}

/** Echo needed for a Doppler velocity estimate, dBZ: without scatterers the radar measures nothing. */
export const VELOCITY_MIN_DBZ = 5
/** Echo needed for the dual-polarisation products, dBZ (weaker echo is too noisy for ZDR and rho_hv on a real radar). */
export const DUAL_MIN_DBZ = 10

/**
 * Plan position indicator over a w x h raster covering the domain (pixel (0, 0) at the north-west corner): reflectivity
 * (dBZ) and Doppler radial velocity (m/s, positive away from the radar) of the beam at one elevation, and the composite
 * reflectivity, the maximum over the whole volume scan (all the profile's tilts). The beam's ground track (grid x, y, azimuth)
 * is computed per radar site, its grid level per tilt (cached). `sample` and `composite` first compute reflectivity and
 * the precipitation's fall speed at the model nodes, then interpolate them along the beams. With `stormMotion` the
 * velocity is storm-relative (SRV): the storm's own motion, which masks a mesocyclone's couplet, is subtracted.
 * The raster, the site and every position are fixed to the ground: when the model domain follows the storm
 * (AtmosphereModel.frame), the storm moves across the screen as past a real radar. With `dual` set, `sample` and
 * `section` also give the dual-polarisation products (polarimetry.ts): ZDR (dB), rho_hv and KDP (deg/km), NaN below
 * DUAL_MIN_DBZ. The radar profile (radars.ts) sets the tilts and the ranges: beyond `range` no echo, beyond
 * `velocityRange` or off its velocity tilts no velocity.
 */
/** The echo top's reflectivity, dBZ (NWS enhanced echo tops), and the reflectivity VIL counts at most, dBZ (hail above it). */
export const ECHO_TOP_DBZ = 18, VIL_MAX_DBZ = 56
/**
 * The Russian radars' column quantities (Roshydromet DMRL-C guidelines 2014, section 5.1; GIMET-2010): the cloud top
 * H_ВГО at -5 dBZ, the layers Z1 (0.6-1 km) and Z2 (2-4 km), the levels H2 (0 °C) and H3 (2-2.5 km above it, here 2.25)
 * and Zmax above 1 km.
 */
export const VGO_DBZ = -5, Z1_LAYER = [600, 1000] as const, Z2_LAYER = [2000, 4000] as const, H3_ABOVE = 2250, ZMAX_FROM = 1000

/**
 * Nyquist velocities of the folding option, m/s: a pulsed Doppler radar measures the radial velocity only within
 * ±v_N = λ PRF / 4; faster wind folds over to the other sign. An S-band radar (λ 10 cm) as the NEXRAD's low tilts ~28;
 * a C-band one (λ 5.3 cm) at a PRF of 1000 Hz ~13, as many European radars, where folding is common.
 */
export const NYQUIST = { S: 28, C: 13 } as const
/** The radial velocity as a radar of Nyquist velocity n measures it: within ±n (NaN stays NaN). */
export const fold = (v: number, n: number) => v - 2 * n * Math.round(v / (2 * n))

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
  /**
   * The column quantities of the Russian radars from the volume scan, with composite(): the cloud top H_ВГО (km, the
   * highest beam with VGO_DBZ; 0: none), the strongest echo in the layers Z1 and Z2 and above ZMAX_FROM, and the echo
   * at the levels H2 and H3 (dBZ; between two tilts linear in height, DBZ_FLOOR where no beam passes).
   */
  readonly vgo: Float32Array; readonly z1: Float32Array; readonly z2: Float32Array; readonly zmax: Float32Array; readonly zh2: Float32Array; readonly zh3: Float32Array
  /** The echo at H0 + 1.4 km (the hail core's level of RD 52.04.320-91), dBZ, with composite(). */
  readonly zCore: Float32Array
  /** The levels H2 and H3 of the last composite(), m. */
  levelH2 = 0; levelH3 = 0
  /** The phenomena map (phenomena.ts codes; 31 beyond the radar's range), with phenomena(). */
  readonly codes: Uint8Array
  private readonly gx: Float32Array; private readonly gy: Float32Array; private readonly sinAz: Float32Array; private readonly cosAz: Float32Array
  /** Grid level of the beam per tilt (-1 above the model top), for the current site. */
  private readonly levels = new Map<number, Float32Array>()
  /** Reflectivity (dBZ) and reflectivity-weighted fall speed (m/s) at the model nodes, refreshed by prepare(). */
  private readonly nodeDbz: Float32Array; private readonly nodeFall: Float32Array
  /** ZDR, rho_hv and KDP at the model nodes (prepared only with `dual`; without precipitation 0, 1 and 0). */
  private readonly nodeZdr: Float32Array; private readonly nodeRho: Float32Array; private readonly nodeKdp: Float32Array
  readonly model: AtmosphereModel
  site = { x: 0, y: 0 }; tilt: number = RADAR_TILTS[0]
  /** The radar's scan (tilts, ranges); set it with setProfile(). */
  profile: RadarProfile = RADARS.wsr88d
  /** Range from the radar of each pixel's sample point, m (layout()). */
  private readonly range: Float32Array
  /** Storm motion (u, v, m/s) to subtract from the radial velocity (storm-relative velocity), or null (base velocity). */
  stormMotion: readonly [number, number] | null = null
  /** Whether prepare(), sample() and section() also do ZDR, rho_hv and KDP. */
  dual = false
  /**
   * Whether the beam is attenuated by precipitation and gases (attenuation.ts) on the way out and back: sample() and
   * composite() lower Z (and ZDR) by the two-way path-integrated attenuation from the radar along each beam (the section,
   * the detection and the hook check do not).
   */
  attenuate = false
  /**
   * Whether rain, graupel and hail scatter by Mie at the radar's wavelength (radar.ts speciesZ) instead of Rayleigh: large
   * hail looks weaker at C and X band, melting graupel brighter at S. Every product of the PPI follows.
   */
  mie = false
  /** Ground clutter next to the radar and receiver noise (clutter.ts) in sample() and composite(); `filtered`: through the clutter filter. */
  clutter = false; filtered = false
  /** One-way specific and differential attenuation at the nodes, dB/km (prepared with `attenuate`). */
  private nodeAtt = new Float32Array(0); private nodeAttDp = new Float32Array(0)
  /** Radial spacing (m) and azimuthal bins of the path-integrated attenuation. */
  private static readonly PIA_STEP = 500; private static readonly PIA_BEAMS = 360
  /**
   * Radial bins like real radar data (null: every pixel sampled at its own centre): `gate` m along the beam and `beam`
   * degrees across it. Every pixel of a bin shows the bin's value, sampled at the bin's centre, so the scan looks as on a
   * radar display — sectors that widen with range. Call layout() after changing it.
   */
  bins: { gate: number; beam: number } | null = null

  constructor(model: AtmosphereModel, w: number, h: number) {
    this.model = model; this.w = w; this.h = h
    const n = w * h, f = () => new Float32Array(n)
    this.dbz = f(); this.velocity = f(); this.compositeDbz = f(); this.zdr = f(); this.rho = f(); this.kdp = f(); this.vil = f(); this.echoTop = f(); this.echoTopped = new Uint8Array(n); this.mesh = f(); this.vgo = f(); this.z1 = f(); this.z2 = f(); this.zmax = f(); this.zh2 = f(); this.zh3 = f(); this.zCore = f(); this.codes = new Uint8Array(n); this.gx = f(); this.gy = f(); this.sinAz = f(); this.cosAz = f(); this.range = f()
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
      this.gx[i] = g.x / dx; this.gy[i] = g.y / dy; this.range[i] = range
      this.sinAz[i] = range > 0 ? ex / range : 0; this.cosAz[i] = range > 0 ? ny / range : 0
    }
  }

  /** The volume scan's tilts, and those it measures the velocity at. */
  get tilts() { return this.profile.tilts }
  get velocityTilts() { return this.profile.velocityTilts ?? this.profile.tilts }

  /** Switches the radar: its tilts and ranges (the tilt moves to the nearest of the new ones). Call layout() after changing the bins. */
  setProfile(profile: RadarProfile) {
    this.profile = profile
    this.tilt = profile.tilts.reduce((best, t) => Math.abs(t - this.tilt) < Math.abs(best - this.tilt) ? t : best)
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
    const m = this.model, e = m.env, { nz, layer, zs } = m.grid, rhoGround = e.rho[0], dual = this.dual, att = this.attenuate, { band, wavelength } = this.profile
    if (att && this.nodeAtt.length !== m.grid.n) { this.nodeAtt = new Float32Array(m.grid.n); this.nodeAttDp = new Float32Array(m.grid.n) }
    for (let z = 0, i = 0; z < nz; z++) {
      const rho = e.rho[z], exner = e.exner[z]
      for (let end = i + layer; i < end; i++) {
        const rain = m.rain[i], snow = m.snow[i], graupel = m.graupel[i], hail = m.hail[i]
        if (att) { const a = specificAttenuation(rho, rain, graupel, hail, rain > 0 || graupel > 0 || hail > 0 ? m.theta[i] * exner - 273.15 : -1, zs[z], band, wavelength); this.nodeAtt[i] = a.a; this.nodeAttDp[i] = a.dp }
        if (rain <= 0 && snow <= 0 && graupel <= 0 && hail <= 0) {
          this.nodeDbz[i] = DBZ_FLOOR; this.nodeFall[i] = 0
          if (dual) { this.nodeZdr[i] = 0; this.nodeRho[i] = 1; this.nodeKdp[i] = 0 }
          continue
        }
        const tc = m.theta[i] * exner - 273.15
        const radar = this.mie ? this.profile : undefined
        this.nodeDbz[i] = reflectivity(rho, rain, snow, graupel, tc, hail, radar); this.nodeFall[i] = reflectivityFallSpeed(rho, rhoGround, rain, snow, graupel, tc, hail, radar)
        if (dual) { const d = dualPol(rho, rain, snow, graupel, tc, hail, radar); this.nodeZdr[i] = d.zdr; this.nodeRho[i] = d.rho; this.nodeKdp[i] = d.kdp }
      }
    }
  }

  /**
   * Two-way path-integrated attenuation (dB) of `tilt` on PIA_BEAMS azimuths every PIA_STEP m from the site out to the
   * farthest pixel within the radar's range (call prepare() with `attenuate` first): the specific attenuation sampled at
   * the beam's centre, summed out and back; beyond the model top it stays. Beam-major, `pia` for Z and `dp` for ZDR.
   */
  private pathAttenuation(tilt: number) {
    const m = this.model, grid = m.grid, { dx, dy } = grid, [ox, oy] = this.shift(), step = PPI.PIA_STEP, beams = PPI.PIA_BEAMS
    let far = 0; for (let i = 0; i < this.range.length; i++) far = Math.max(far, this.range[i])
    const gates = Math.ceil(Math.min(far, this.profile.range) / step) + 1, pia = new Float32Array(beams * gates), dp = new Float32Array(beams * gates)
    const levels = Float64Array.from({ length: gates }, (_, g) => { const h = beamHeight((g + .5) * step, tilt); return h > grid.height ? -1 : levelAt(grid, h) })
    for (let b = 0; b < beams; b++) {
      const az = (b + .5) * 2 * Math.PI / beams, sa = Math.sin(az), ca = Math.cos(az)
      let sum = 0, sumDp = 0
      for (let g = 0; g < gates; g++) {
        const z = levels[g], r = (g + .5) * step
        if (z >= 0) {
          const gx = (this.site.x + r * sa) / dx - ox, gy = (this.site.y + r * ca) / dy - oy
          sum += 2 * m.sample(this.nodeAtt, gx, gy, z) * step / 1000; sumDp += 2 * m.sample(this.nodeAttDp, gx, gy, z) * step / 1000
        }
        pia[b * gates + g] = sum; dp[b * gates + g] = sumDp
      }
    }
    return { pia, dp, gates }
  }

  /**
   * VAD winds over the radar (call prepare() first): on each velocity tilt the radial velocity around a ring at the
   * longest slant range of VAD.ranges that stays inside the domain and the Doppler range, where there is echo, fitted by
   * least squares with V = a0 + a1 sin(az) + b1 cos(az) (Teschke & Lehmann 2017): u = a1 / cos el, v = b1 / cos el; a ring
   * passes with enough points, azimuths and a small RMS. One wind per height band of 250 m (the lowest RMS), lowest first.
   * Without clear-air echo (the model has no insects or Bragg scatter) the winds come only where it rains or snows.
   */
  vad(): VadWind[] {
    const m = this.model, grid = m.grid, { dx, dy, width, depth } = grid, [ox, oy] = this.shift(), [fu, fv] = m.frame
    const room = Math.min(this.site.x, width - this.site.x, this.site.y, depth - this.site.y) - 1000
    const ring = VAD.ranges.find(r => r <= room && r <= this.profile.velocityRange) ?? Math.min(room, this.profile.velocityRange)
    if (ring < 5000) return []
    const found: VadWind[] = []
    for (const tilt of this.velocityTilts) {
      const h = beamHeight(ring, tilt), el = tilt * Math.PI / 180, ce = Math.cos(el), se = Math.sin(el)
      if (h > grid.height) break
      const z = levelAt(grid, h), az: number[] = [], vr: number[] = []
      for (let k = 0; k < 360; k++) {
        const a = (k + .5) * Math.PI / 180, sa = Math.sin(a), ca = Math.cos(a), gx = (this.site.x + ring * ce * sa) / dx - ox, gy = (this.site.y + ring * ce * ca) / dy - oy
        if (m.sample(this.nodeDbz, gx, gy, z) < VELOCITY_MIN_DBZ) continue
        az.push(a); vr.push(((m.sample(m.u, gx, gy, z) + fu) * sa + (m.sample(m.v, gx, gy, z) + fv) * ca) * ce + (m.sample(m.w, gx, gy, z) - m.sample(this.nodeFall, gx, gy, z)) * se)
      }
      if (az.length < VAD.points) continue
      // The azimuths covered: 360° less the widest gap between neighbouring points.
      let gap = 2 * Math.PI - az[az.length - 1] + az[0]
      for (let k = 1; k < az.length; k++) gap = Math.max(gap, az[k] - az[k - 1])
      const cover = 360 - gap * 180 / Math.PI
      if (cover < (tilt < 2 ? VAD.coverLow : VAD.coverHigh)) continue
      // Least squares for [a0, a1, b1] by the normal equations.
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0]
      for (let k = 0; k < az.length; k++) { const f = [1, Math.sin(az[k]), Math.cos(az[k])]; for (let i = 0; i < 3; i++) { b[i] += f[i] * vr[k]; for (let j = 0; j < 3; j++) A[i][j] += f[i] * f[j] } }
      const c = solve3(A, b)
      if (!c) continue
      let ss = 0
      for (let k = 0; k < az.length; k++) { const r = vr[k] - c[0] - c[1] * Math.sin(az[k]) - c[2] * Math.cos(az[k]); ss += r * r }
      const rms = Math.sqrt(ss / az.length)
      if (rms > VAD.rms) continue
      found.push({ height: h, range: ring, tilt, u: c[1] / ce, v: c[2] / ce, rms, points: az.length, cover })
    }
    const bands = new Map<number, VadWind>()
    for (const w of found) { const k = Math.round(w.height / 250), o = bands.get(k); if (!o || w.rms < o.rms) bands.set(k, w) }
    return [...bands.values()].sort((p, q) => p.height - q.height)
  }

  /** Ground clutter (clutter.ts) at pixel i's range and azimuth for `tilt`. */
  private clutterOf(i: number, tilt: number) {
    return clutterAt(this.range[i], Math.atan2(this.sinAz[i], this.cosAz[i]) * 180 / Math.PI, tilt, this.profile.beam, this.filtered)
  }

  /** Index into pathAttenuation()'s arrays of pixel i (its range and azimuth). */
  private piaIndex(i: number, gates: number) {
    const az = (Math.atan2(this.sinAz[i], this.cosAz[i]) + 2 * Math.PI) % (2 * Math.PI), b = Math.min(PPI.PIA_BEAMS - 1, Math.floor(az / (2 * Math.PI) * PPI.PIA_BEAMS))
    return b * gates + Math.min(gates - 1, Math.floor(this.range[i] / PPI.PIA_STEP))
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
    const [ox, oy] = this.shift(), [fu, fv] = m.frame, [su, sv] = this.stormMotion ?? [0, 0], cu = fu - su, cv = fv - sv, { range } = this.profile, velocityRange = this.velocityTilts.includes(this.tilt) ? this.profile.velocityRange : -1
    const path = this.attenuate ? this.pathAttenuation(this.tilt) : null
    for (let i = 0; i < this.dbz.length; i++) {
      const z = gz[i]
      if (z < 0 || this.range[i] > range) { this.dbz[i] = DBZ_FLOOR; this.velocity[i] = this.zdr[i] = this.rho[i] = this.kdp[i] = NaN; continue }
      const x = this.gx[i] - ox, y = this.gy[i] - oy, k = path ? this.piaIndex(i, path.gates) : 0
      const weather = path ? Math.max(DBZ_FLOOR, m.sample(this.nodeDbz, x, y, z) - path.pia[k]) : m.sample(this.nodeDbz, x, y, z)
      // Clutter adds its power; its share pulls the velocity to zero and the dual-pol moments to its own.
      const c = this.clutter ? this.clutterOf(i, this.tilt) : null, pw = weather > DBZ_FLOOR ? 10 ** (weather / 10) : 0, pc = c && c.dbz > -Infinity ? 10 ** (c.dbz / 10) : 0
      let d = pc > 0 ? Math.max(DBZ_FLOOR, 10 * Math.log10(pw + pc)) : weather
      const seen = !this.clutter || d >= noiseFloor(this.range[i])
      if (!seen) d = DBZ_FLOOR
      this.dbz[i] = d
      const share = pc > 0 ? pc / (pw + pc) : 0
      if (this.dual) {
        const echo = seen && d >= DUAL_MIN_DBZ
        if (!echo) this.zdr[i] = this.rho[i] = this.kdp[i] = NaN
        else {
          const zw = 10 ** ((pw > 0 ? m.sample(this.nodeZdr, x, y, z) - (path ? path.dp[k] : 0) : 0) / 10)
          this.zdr[i] = 10 * Math.log10(1 / ((1 - share) / zw + (c ? share / c.zdr : 0)))
          this.rho[i] = (1 - share) * (pw > 0 ? m.sample(this.nodeRho, x, y, z) : 1) + share * (c ? c.rho : 1)
          this.kdp[i] = pw > 0 ? m.sample(this.nodeKdp, x, y, z) : 0
        }
      }
      if (!seen || d < VELOCITY_MIN_DBZ || this.range[i] > velocityRange) { this.velocity[i] = NaN; continue }
      const vw = pw > 0 ? ((m.sample(m.u, x, y, z) + cu) * this.sinAz[i] + (m.sample(m.v, x, y, z) + cv) * this.cosAz[i]) * ce + (m.sample(m.w, x, y, z) - m.sample(this.nodeFall, x, y, z)) * se : 0
      this.velocity[i] = (1 - share) * vw
    }
  }

  /**
   * The volume scan's products over each pixel: the composite reflectivity (the strongest echo), the echo top (the
   * highest beam with at least ECHO_TOP_DBZ, as the NWS enhanced echo tops, raised to where the echo falls through that
   * threshold between it and the next tilt up - Lakshmanan et al. 2013, WAF 28, 481: the beam heights alone make rings of
   * stair-steps with range; a beam above the model top counts as no echo) and VIL — the liquid water the reflectivity
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
    const { vgo, z1, z2, zmax, zh2, zh3 } = this, lastD = new Float32Array(out.length)
    vgo.fill(0); z1.fill(DBZ_FLOOR); z2.fill(DBZ_FLOOR); zmax.fill(DBZ_FLOOR); zh2.fill(DBZ_FLOOR); zh3.fill(DBZ_FLOOR); this.zCore.fill(DBZ_FLOOR)
    let h0 = 0, h20 = 0
    while (h0 < grid.height && m.env.temperatureEnv(h0) > 0) h0 += 25
    h20 = h0; while (h20 < grid.height && m.env.temperatureEnv(h20) > -20) h20 += 25
    const h3 = h0 + H3_ABOVE, hCore = h0 + RD_CRITERIA.hailCoreAbove; this.levelH2 = h0; this.levelH3 = h3
    // The echo at height H between the previous beam (h1, d1) and this one (h2, d2), and a layer's strongest echo: the
    // beams inside it and the interpolated echo where the beams cross its bounds.
    const between = (h1: number, d1: number, h2: number, d2: number, H: number) => d1 + (d2 - d1) * (H - h1) / (h2 - h1)
    // Where the echo falls through `threshold` between a beam at h1 (with it) and the next one up at h2 (without), km.
    const crossing = (h1: number, d1: number, h2: number, d2: number, threshold: number) => d1 >= threshold && d2 < threshold ? (h1 + (h2 - h1) * (d1 - threshold) / (d1 - d2)) / 1000 : 0
    const layer = (into: Float32Array, i: number, h1: number, d1: number, h2: number, d2: number, a: number, b: number) => {
      let v = into[i]
      if (h2 >= a && h2 <= b) v = Math.max(v, d2)
      if (h1 < a && h2 >= a) v = Math.max(v, between(h1, d1, h2, d2, a))
      if (h1 < b && h2 >= b) v = Math.max(v, between(h1, d1, h2, d2, b))
      into[i] = v
    }
    const tilts = this.tilts, highest = tilts[tilts.length - 1], reach = this.profile.range, topDbz = this.profile.echoTopDbz ?? ECHO_TOP_DBZ
    for (const tilt of tilts) {
      const gz = this.levelsFor(tilt), path = this.attenuate ? this.pathAttenuation(tilt) : null
      for (let i = 0; i < out.length; i++) {
        const z = gz[i]
        if (this.range[i] > reach) continue
        if (z < 0) {
          // Above the model top: no echo, which closes the tops of the beam below it (once: the higher tilts are higher still).
          if (!Number.isNaN(last[i]) && lastH[i] < Infinity) { const h = beamHeight(this.range[i], tilt); top[i] = Math.max(top[i], crossing(lastH[i], lastD[i], h, DBZ_FLOOR, topDbz)); vgo[i] = Math.max(vgo[i], crossing(lastH[i], lastD[i], h, DBZ_FLOOR, VGO_DBZ)); lastH[i] = Infinity }
          continue
        }
        const raw = m.sample(this.nodeDbz, this.gx[i] - ox, this.gy[i] - oy, z), h = heightAt(grid, z)
        let d = path ? Math.max(DBZ_FLOOR, raw - path.pia[this.piaIndex(i, path.gates)]) : raw
        if (this.clutter) { const c = this.clutterOf(i, tilt); if (c.dbz > -Infinity) d = Math.max(DBZ_FLOOR, 10 * Math.log10((d > DBZ_FLOOR ? 10 ** (d / 10) : 0) + 10 ** (c.dbz / 10))); if (d < noiseFloor(this.range[i])) d = DBZ_FLOOR }
        if (d > out[i]) out[i] = d
        if (!Number.isNaN(last[i]) && h > lastH[i]) { top[i] = Math.max(top[i], crossing(lastH[i], lastD[i], h, d, topDbz)); vgo[i] = Math.max(vgo[i], crossing(lastH[i], lastD[i], h, d, VGO_DBZ)) }
        if (d >= topDbz) top[i] = Math.max(top[i], h / 1000)
        if (tilt === highest) this.echoTopped[i] = d >= topDbz ? 1 : 0
        if (d >= VGO_DBZ) vgo[i] = Math.max(vgo[i], h / 1000)
        if (Number.isNaN(last[i])) { if (h >= ZMAX_FROM) zmax[i] = Math.max(zmax[i], d); if (h >= Z1_LAYER[0] && h <= Z1_LAYER[1]) z1[i] = d; if (h >= Z2_LAYER[0] && h <= Z2_LAYER[1]) z2[i] = d }
        else if (h > lastH[i]) {
          const h1 = lastH[i], d1 = lastD[i]
          layer(z1, i, h1, d1, h, d, Z1_LAYER[0], Z1_LAYER[1]); layer(z2, i, h1, d1, h, d, Z2_LAYER[0], Z2_LAYER[1]); layer(zmax, i, h1, d1, h, d, ZMAX_FROM, Infinity)
          if (h1 < h0 && h >= h0) zh2[i] = between(h1, d1, h, d, h0)
          if (h1 < h3 && h >= h3) zh3[i] = between(h1, d1, h, d, h3)
          if (h1 < hCore && h >= hCore) this.zCore[i] = between(h1, d1, h, d, hCore)
        }
        lastD[i] = d
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
   * The phenomena map from the last composite() (phenomena.ts): the environment's 0 °C and -22 °C levels and its
   * tropopause (the lowest level from 5 km where the temperature falls less than 2 K over the next 2 km), the cell motion
   * `motion` (m/s) for the squalls, the hook echoes the mesocyclone detection found (ground positions, m) for the
   * tornado; 31 (no data) beyond the radar's range.
   */
  phenomena(motion: number, hooks: readonly { x: number; y: number }[] = []) {
    const reach = RD_CRITERIA.tornadoHook * 1000 / 2
    const e = this.model.env, top = this.model.grid.height, t = (h: number) => e.temperatureEnv(h)
    let h22 = 0; while (h22 < top && t(h22) > -22) h22 += 25
    let trop = 5000; while (trop < top - 2000 && t(trop) - t(trop + 2000) >= 4) trop += 100
    const levels = { h0: this.levelH2 / 1000, h22: h22 / 1000, tropopause: trop / 1000, motion: motion * 3.6 }
    for (let i = 0; i < this.codes.length; i++) {
      if (this.range[i] > this.profile.range) { this.codes[i] = 31; continue }
      const g = hooks.length ? this.samplePoint(i % this.w, Math.floor(i / this.w)) : null, hook = !!g && hooks.some(k => Math.hypot(g.x - k.x, g.y - k.y) <= reach)
      this.codes[i] = phenomenon({ top: this.vgo[i], strongest: this.compositeDbz[i], z1: this.z1[i], z2: this.z2[i], zh3: this.zh3[i], zCore: this.zCore[i], zmax: this.zmax[i], mesh: this.mesh[i], hook }, levels)
    }
    return levels
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
   * the profile's order) and the heights of the 0 °C and -20 °C isotherms in the column (m, the lowest crossing from warm
   * to cold; NaN if none). Periodic like the model; above the model top and beyond the profile's ranges: no echo, no velocity;
   * only within the volume the radar scans - from the lower edge of its lowest beam to the upper edge of its highest (half
   * a beam width beyond the tilts; the velocity by its own tilts): no data above it near the radar (the cone of silence)
   * and below it far away, where no beam reaches. With `bins` the section is made of the radar's own samples, as in
   * GR2Analyst: each radial bin on the line (the gate and the degree of azimuth the map uses) gives one cell per tilt, the
   * beam's value over the beam's thickness at that range, so the cells follow the beams, grow with range and leave gaps
   * between tilts farther apart than the beam is wide; a cell thinner than a row still fills one.
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
    const beams = this.tilts.map(tilt => Float32Array.from(range, r => beamHeight(r, tilt))), reach = this.profile.range, doppler = this.profile.velocityRange
    // The scanned volume over each gate: beam heights of the lowest tilt's lower edge and the highest's upper edge.
    const half = this.profile.beam / 2, vt = this.velocityTilts, edge = (tilt: number) => Float32Array.from(range, r => beamHeight(r, tilt))
    const low = edge(this.tilts[0] - half), high = edge(this.tilts[this.tilts.length - 1] + half), lowV = edge(vt[0] - half), highV = edge(vt[vt.length - 1] + half)
    if (this.bins) {
      const { gate, beam: step } = this.bins, near = new Float32Array(gates * rows), nearV = new Float32Array(gates * rows)
      // A value of `tilt` over the rows its beam fills at gate g, the nearest beam winning where beams overlap.
      const fill = (g: number, r: number, tilt: number, closest: Float32Array, write: (i: number) => void) => {
        const h = beamHeight(r, tilt), thick = Math.max(beamHeight(r, tilt + half) - h, dz / 2)
        for (let k = Math.max(0, Math.floor((h - thick) / dz)); k < rows && (k + .5) * dz <= h + thick + dz / 2; k++) {
          const i = k * gates + g, d = Math.abs((k + .5) * dz - h)
          if (closest[i] === 0 || d < closest[i]) { closest[i] = Math.max(d, 1e-3); write(i) }
        }
      }
      for (let g = 0; g < gates; g++) {
        if (range[g] > reach) continue
        const t = (g + .5) / gates, ex = a.x + (b.x - a.x) * t - this.site.x, ny = a.y + (b.y - a.y) * t - this.site.y
        const r = (Math.floor(range[g] / gate) + .5) * gate, az = (Math.floor(((Math.atan2(ex, ny) * 180 / Math.PI + 360) % 360) / step) + .5) * step * Math.PI / 180
        const sa = Math.sin(az), ca = Math.cos(az), gx = (this.site.x + r * sa) / dx - ox, gy = (this.site.y + r * ca) / dy - oy
        for (const tilt of this.tilts) {
          const h = beamHeight(r, tilt)
          if (h > grid.height) break
          const z = levelAt(grid, h), d = m.sample(this.nodeDbz, gx, gy, z), echo = dual && d >= DUAL_MIN_DBZ
          const dr = echo ? m.sample(this.nodeZdr, gx, gy, z) : NaN, rh = echo ? m.sample(this.nodeRho, gx, gy, z) : NaN, kd = echo ? m.sample(this.nodeKdp, gx, gy, z) : NaN
          fill(g, r, tilt, near, i => { dbz[i] = d; if (dual) { zdr[i] = dr; rho[i] = rh; kdp[i] = kd } })
        }
        if (r > doppler) continue
        for (const tilt of vt) {
          const h = beamHeight(r, tilt), el = tilt * Math.PI / 180
          if (h > grid.height) break
          const z = levelAt(grid, h)
          if (m.sample(this.nodeDbz, gx, gy, z) < VELOCITY_MIN_DBZ) continue
          const v = ((m.sample(m.u, gx, gy, z) + cu) * sa + (m.sample(m.v, gx, gy, z) + cv) * ca) * Math.cos(el) + (m.sample(m.w, gx, gy, z) - m.sample(this.nodeFall, gx, gy, z)) * Math.sin(el)
          fill(g, r, tilt, nearV, i => { velocity[i] = v })
        }
      }
      return { dbz, velocity, zdr, rho, kdp, range, beams, iso0, iso20 }
    }
    for (let k = 0; k < rows; k++) {
      const h = (k + .5) * dz
      if (h > grid.height) break
      const z = levelAt(grid, h)
      for (let g = 0; g < gates; g++) {
        if (range[g] > reach || h < low[g] || h > high[g]) continue
        const gx = gxs[g], gy = gys[g], i = k * gates + g, d = m.sample(this.nodeDbz, gx, gy, z)
        dbz[i] = d
        if (dual && d >= DUAL_MIN_DBZ) { zdr[i] = m.sample(this.nodeZdr, gx, gy, z); rho[i] = m.sample(this.nodeRho, gx, gy, z); kdp[i] = m.sample(this.nodeKdp, gx, gy, z) }
        if (d < VELOCITY_MIN_DBZ || range[g] > doppler || h < lowV[g] || h > highV[g]) continue
        const el = Math.atan2(h, range[g])
        velocity[i] = ((m.sample(m.u, gx, gy, z) + cu) * sinAz[g] + (m.sample(m.v, gx, gy, z) + cv) * cosAz[g]) * Math.cos(el) + (m.sample(m.w, gx, gy, z) - m.sample(this.nodeFall, gx, gy, z)) * Math.sin(el)
      }
    }
    return { dbz, velocity, zdr, rho, kdp, range, beams, iso0, iso20 }
  }

  /** Reflectivity (dBZ) the beam of `tilt` sees over a ground point, m (call prepare() first; periodic like the model). */
  dbzAt(x: number, y: number, tilt: number) {
    const m = this.model, grid = m.grid, r = Math.hypot(x - this.site.x, y - this.site.y), h = beamHeight(r, tilt)
    if (h > grid.height || r > this.profile.range) return DBZ_FLOOR
    const [ox, oy] = this.shift()
    return m.sample(this.nodeDbz, x / grid.dx - ox, y / grid.dy - oy, levelAt(grid, h))
  }

  /**
   * Polar scan of one tilt for the detection algorithms (call prepare() first): reflectivity and base radial velocity at
   * `gates` range gates `step` m apart (gate g at range (g + 1) * step) on `beams` azimuths (beam b at b * 360 / beams
   * degrees), beam-major. Beams leave the domain on one side and come back on the other, as the periodic model does (a
   * storm across the edge is seen whole). Above the model top and beyond the profile's range: no echo; without echo or
   * beyond the velocity range the velocity is NaN.
   */
  polar(tilt: number, step: number, gates: number, beams: number) {
    const m = this.model, grid = m.grid, { dx, dy } = grid, el = tilt * Math.PI / 180, ce = Math.cos(el), se = Math.sin(el), [ox, oy] = this.shift(), [fu, fv] = m.frame
    const dbz = new Float32Array(gates * beams).fill(DBZ_FLOOR), velocity = new Float32Array(gates * beams).fill(NaN)
    const { range, velocityRange } = this.profile
    const levels = Float64Array.from({ length: gates }, (_, g) => { const h = beamHeight((g + 1) * step, tilt); return h > grid.height || (g + 1) * step > range ? -1 : levelAt(grid, h) })
    for (let b = 0; b < beams; b++) {
      const az = b * 2 * Math.PI / beams, sa = Math.sin(az), ca = Math.cos(az)
      for (let g = 0; g < gates; g++) {
        const r = (g + 1) * step, x = this.site.x + r * sa, y = this.site.y + r * ca, z = levels[g], i = b * gates + g
        if (z < 0) continue
        const gx = x / dx - ox, gy = y / dy - oy, d = m.sample(this.nodeDbz, gx, gy, z)
        dbz[i] = d
        if (d >= VELOCITY_MIN_DBZ && r <= velocityRange) velocity[i] = ((m.sample(m.u, gx, gy, z) + fu) * sa + (m.sample(m.v, gx, gy, z) + fv) * ca) * ce + (m.sample(m.w, gx, gy, z) - m.sample(this.nodeFall, gx, gy, z)) * se
      }
    }
    return { dbz, velocity }
  }
}

/** Solves the 3 x 3 system A x = b by Cramer's rule; null if singular. */
function solve3(A: number[][], b: number[]) {
  const det = (M: number[][]) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])
  const d = det(A)
  if (Math.abs(d) < 1e-9) return null
  return [0, 1, 2].map(c => det(A.map((row, i) => row.map((v, j) => j === c ? b[i] : v))) / d)
}
