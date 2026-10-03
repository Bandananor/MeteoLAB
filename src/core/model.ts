import type { SimConfig } from './config'
import { CP, DT, G, LV, OMEGA } from './constants'
import { Environment, type EnvironmentProfile } from './environment'
import { createGrid, domainGrid, type Grid, shiftedLevel } from './grid'
import { domainMotion } from './kinematics'
import { clamp, lerp, mod, mulberry32 } from './math'
import { FluxTransport } from './advection'
import { weismanKlemp } from './profiles'
import { SMAGORINSKY, Turbulence } from './turbulence'
import { graupelFallSpeed, graupelProcesses } from './graupel'
import { freezeRain, saturationAdjustMixed, snowFallSpeed, snowProcesses } from './ice'
import { fallSpeed, rainProcesses, saturationAdjust } from './microphysics'
import { PressureSolver } from './pressure'
import { dragCoefficient, surfaceFluxes } from './surface'
import { computeSounding, type Sounding } from './sounding'

// Updraft helicity (integral of w*zeta over 2-5 km, m2/s2) thresholds and the persistence that makes rotation a mesocyclone.
// Recalibrated 2026-09-29 on the realistic scenarios (~1 km grid, honest microphysics): strong updraughts in weak shear
// tilt the environmental vorticity into vortex pairs of both signs with UH up to ~380 cyclonic and ~320 anticyclonic;
// supercells hold 700-1900 with the anticyclonic maximum several times weaker (3-km NWP uses ~75).
export const UH_ROTATING = 200, UH_MESOCYCLONE = 400, MESO_PERSISTENCE = 600
/** Condensate below this mixing ratio (kg/kg, 1e-7 g/kg) is set to zero by the WENO positivity fix, conservatively. */
const TINY_WATER = 1e-10
/** Safety limits of the horizontal and vertical velocity, m/s (see AtmosphereModel.clipped). */
export const U_LIMIT = 120, W_LIMIT = 100
/** A mesocyclone must also outweigh the strongest anticyclonic rotation by this factor (a vortex pair is not one). */
export const MESO_DOMINANCE = 1.5

export interface RotationState {
  uh: number; x: number; y: number; anticyclonic: number; persisted: number
  /** Largest cyclonic updraft helicity of the 0-1 and 0-3 km layers (low-level mesocyclone), m2/s2. */
  uh01: number; uh03: number
}

export interface ModelDiagnostics {
  /** Heaviest rain reaching the ground now, mm/h: rho0 q_r V_t at the surface. */ rainRate: number
  /** Largest rain total on the ground since the start, mm. */ rainTotal: number
  updraft: number; downdraft: number; cloudTop: number; thermalTop: number
  maxCloud: number; coldMax: number; cores: number; shear06: number; microburst: number
  /**
   * Velocity components clipped by the safety limits since the start. The limits (|u|, |v| <= 120, |w| <= 100 m/s,
   * raised from 85 / 60 on 2026-09-29) lie well above any real storm and well inside the stability of both transports
   * (Courant number ~0.1-0.15 at dt = 1 s): a non-zero count means a genuine blow-up, not a strong updraught.
   */
  clipped: number
}

/** Cloud-scale atmosphere on a periodic box: prognostic u, v, w, theta, q, cloud water, cloud ice, rain, snow and the cold-pool indicator. */
export class AtmosphereModel {
  readonly grid: Grid; readonly config: SimConfig; readonly env: Environment
  readonly u: Float32Array; readonly v: Float32Array; readonly w: Float32Array; readonly theta: Float32Array
  readonly q: Float32Array; readonly cloud: Float32Array; readonly rain: Float32Array; readonly cold: Float32Array
  /** Cloud ice, snow and graupel mixing ratios, kg/kg (ice microphysics, src/core/ice.ts and graupel.ts). */
  readonly ice: Float32Array; readonly snow: Float32Array; readonly graupel: Float32Array
  /** Projection pressure (times dt, per unit density) at the dual-cell centres between nodes; see PressureSolver. */
  readonly pressure: Float64Array
  /** Updraft helicity of every column (2-5 km), m2/s2. */
  readonly uhColumn: Float32Array
  /** Rain that has reached the ground in each column since the start, mm (kg/m2). */
  readonly precipitation: Float32Array
  /** Fall speed of rain at every node (Kessler), m/s, raised to that of the rain just above (sedimentation), updated each step. */
  readonly fallSpeed: Float32Array
  /** Mass-weighted fall speeds of snow and graupel at each node, m/s. */
  readonly snowFall: Float32Array; readonly graupelFall: Float32Array
  readonly rotation: RotationState = { uh: 0, x: 0, y: 0, anticyclonic: 0, persisted: 0, uh01: 0, uh03: 0 }
  readonly sounding: Sounding
  /** Lowest and highest level of the 2-5 km updraft-helicity layer. */
  readonly uhLevels: readonly [number, number]
  time = 0; microburstOutflow = 0
  /** Velocity components clipped by the safety limits since the start: the model is outside its working range. */
  clipped = 0
  /** Water mass (level-weight units, summed over all fields) that the WENO positivity fix has moved since the start. */
  negativeFilled = 0
  private readonly solver: PressureSolver; private divergence: Float64Array
  private scratch: Float32Array; private surfacePattern: Float32Array
  private backtraceCorner: Int32Array; private backtraceWeight: Float64Array
  /** Mass weight of each level: rho0 times the layer share (nodes on the ground and top walls own half a layer). */
  private levelWeight: Float64Array
  /** Share of the surface fluxes deposited at each of the lowest levels, per metre of that level's thickness. */
  private surfaceShare: Float64Array
  private rng: () => number; private accumulator = 0
  /**
   * Velocity of the domain over the ground (u, v, m/s; see SimConfig.followStorm). The model's winds are relative to the
   * domain; the environmental wind it relaxes to (uEnv, vEnv) is the ground-relative one minus the frame velocity.
   */
  readonly frame: readonly [number, number]
  private readonly uEnv: Float64Array; private readonly vEnv: Float64Array
  /** This step's surface pattern under each column (the ground moves under the domain) and where each column's rain lands. */
  private readonly patternNow: Float32Array; private readonly groundCell: Int32Array; private readonly groundWeight: Float64Array

  /** `profile` replaces the slider environment with an analytic one (idealised test cases). */
  constructor(config: SimConfig, grid: Grid = createGrid(domainGrid(config.domain)), profile?: EnvironmentProfile) {
    this.config = config; this.grid = grid
    this.env = new Environment(config, grid, profile ?? (config.profile === 'weisman-klemp' ? weismanKlemp({ qvMax: .016 }) : undefined))
    this.frame = config.followStorm === false ? [0, 0] : domainMotion(this.env)
    this.uEnv = this.env.u.map(u => u - this.frame[0]); this.vEnv = this.env.v.map(v => v - this.frame[1])
    this.patternNow = new Float32Array(grid.layer); this.groundCell = new Int32Array(grid.layer * 4); this.groundWeight = new Float64Array(grid.layer * 4)
    const f = () => new Float32Array(grid.n)
    this.u = f(); this.v = f(); this.w = f(); this.theta = f(); this.q = f(); this.cloud = f(); this.rain = f(); this.cold = f()
    this.ice = f(); this.snow = f(); this.snowFall = f(); this.graupel = f(); this.graupelFall = f()
    // Anelastic: the projection makes the mass flux rho0 u divergence-free (rho0 falls ~6x over 15 km).
    this.solver = new PressureSolver(grid, this.env.rho)
    this.pressure = new Float64Array(this.solver.cells); this.divergence = new Float64Array(this.solver.cells); this.scratch = f()
    this.surfacePattern = new Float32Array(grid.layer); this.uhColumn = new Float32Array(grid.layer); this.precipitation = new Float32Array(grid.layer); this.fallSpeed = f()
    // Mass of each level per unit area and per metre of mean spacing: rho0 times the control-volume height over dz.
    this.levelWeight = Float64Array.from({ length: grid.nz }, (_, z) => grid.hz[z] / grid.dz * this.env.rho[z])
    this.backtraceCorner = new Int32Array(grid.n * 8); this.backtraceWeight = new Float64Array(grid.n * 3)
    // UH over 2-5 km: the first level at or above 2 km to the last at or below 5 km.
    this.uhLevels = [grid.zs.findIndex(z => z >= 2000), grid.zs.findLastIndex(z => z <= 5000)]
    // exp(-z / 300 m) per unit volume over the levels below 500 m (the two lowest on the uniform grid), each weighted by
    // the height of its control volume, normalised. Not higher: theta is float32 (~3e-5 K steps near 300 K), and the
    // per-step heating of thin levels near 1 km is only a few such steps, so it rounds systematically (±15 %).
    const low = Math.max(2, grid.zs.findIndex(z => z >= 500)), shape = Array.from({ length: low }, (_, z) => Math.exp(-grid.zs[z] / 300))
    const total = shape.reduce((sum, s, z) => sum + s * grid.hz[z], 0)
    this.surfaceShare = Float64Array.from(shape, s => s / total)
    this.rng = mulberry32(config.seed)
    this.initialize()
    this.sounding = computeSounding(config, this.env, grid.height)
  }

  private initialize() {
    const { nx, ny, nz, zs, width: W, depth: D } = this.grid
    let walk = 0
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { walk = walk * .82 + (this.rng() - .5) * .34; this.surfacePattern[x + nx * y] = walk }
    // Zero mean: the pattern only redistributes the surface fluxes (a random offset once added ~1 % to H and LE).
    const mean = this.surfacePattern.reduce((a, b) => a + b, 0) / this.surfacePattern.length
    for (let i = 0; i < this.surfacePattern.length; i++) this.surfacePattern[i] -= mean
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      const alt = zs[z], [ue, ve] = this.env.windUV(alt)
      this.u[i] = ue - this.frame[0]; this.v[i] = ve - this.frame[1]; this.w[i] = 0
      this.theta[i] = this.env.thetaEnv(alt) + (this.rng() - .5) * .018; this.q[i] = this.env.qEnv(alt)
      this.cloud[i] = this.rain[i] = this.cold[i] = this.ice[i] = this.snow[i] = this.graupel[i] = 0
    }
    // The Weisman-Klemp case starts from a single thermal, as in the calibration test.
    if (this.config.profile === 'weisman-klemp') this.injectBubble(W * .3, D * .5, this.config.bubble)
    else { this.injectBubble(W * .38, D * .45, this.config.bubble); this.injectBubble(W * .61, D * .57, .72 * this.config.bubble) }
  }

  /**
   * Warm thermal centred at (cx, cy) metres from the domain corner, near the ground: +3.2 K and 1.1 m/s times strength.
   * No added vapour since 2026-09-29 (as in Weisman-Klemp and other reference cases): +3 g/kg gave the bubble air a far
   * larger CAPE than the environment it is meant to probe.
   */
  injectBubble(cx: number, cy: number, strength: number) {
    const { nx, ny, nz, dx, dy, zs, width: W, depth: D } = this.grid
    // The levels up to 2.7 km (the lowest five on the old uniform grid): the thermal's depth is set in metres, not levels.
    for (let z = 0; z < nz && zs[z] < 2700; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let ddx = x * dx - cx, ddy = y * dy - cy
      if (ddx > W / 2) ddx -= W; if (ddx < -W / 2) ddx += W; if (ddy > D / 2) ddy -= D; if (ddy < -D / 2) ddy += D
      const d2 = (ddx / 4200) ** 2 + (ddy / 4200) ** 2 + (zs[z] / 1800) ** 2, a = Math.exp(-d2) * strength, i = x + nx * (y + ny * z)
      this.theta[i] += 3.2 * a; this.w[i] += 1.1 * a
    }
  }

  /** Trilinear sample at fractional grid coordinates (periodic in x, y; clamped in z). */
  sample(a: Float32Array, x: number, y: number, z: number) {
    const { nx, ny, nz, layer } = this.grid
    // z0 stops one level below the top so the top node itself can take weight 1 (no leak from the level below).
    x = mod(x, nx); y = mod(y, ny); z = clamp(z, 0, nz - 1)
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.min(Math.floor(z), nz - 2), x1 = (x0 + 1) % nx, y1 = (y0 + 1) % ny, z1 = z0 + 1, fx = x - x0, fy = y - y0, fz = z - z0
    const r0 = nx * y0, r1 = nx * y1, l0 = layer * z0, l1 = layer * z1
    const c00 = lerp(a[x0 + r0 + l0], a[x1 + r0 + l0], fx), c10 = lerp(a[x0 + r1 + l0], a[x1 + r1 + l0], fx), c01 = lerp(a[x0 + r0 + l1], a[x1 + r0 + l1], fx), c11 = lerp(a[x0 + r1 + l1], a[x1 + r1 + l1], fx)
    return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz)
  }

  /** Semi-Lagrangian transport of `a` with an extra downward fall speed per node into the scratch buffer (see commit). */
  private advectFalling(a: Float32Array, dt: number, fall: Float32Array) {
    const grid = this.grid, { nx, ny, nz, dx, dy } = grid, s = this.scratch, u = this.u, v = this.v, w = this.w
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) s[i] = this.sample(a, x - u[i] * dt / dx, y - v[i] * dt / dy, shiftedLevel(grid, z, -(w[i] - fall[i]) * dt))
  }

  /**
   * Writes the transported values (scratch) back into `a`, then applies `decay`. With `conserve`, the transport's own
   * mass error is removed first: trilinear semi-Lagrangian transport is not conservative, so the total (mass-weighted with
   * rho0, which the anelastic flow conserves) is restored to its old value minus `loss`, with the correction placed where the
   * transport changed the field (proportional to |new - old|), not spread over quiet air.
   */
  private commit(a: Float32Array, decay: number, conserve = false, loss = 0) {
    const s = this.scratch, { nz, layer } = this.grid, lw = this.levelWeight
    if (conserve) {
      let before = 0, after = 0, moved = 0
      for (let z = 0, i = 0; z < nz; z++) { const wz = lw[z]; for (let e = i + layer; i < e; i++) { before += wz * a[i]; after += wz * s[i]; moved += wz * Math.abs(s[i] - a[i]) } }
      const excess = after - (before - loss)
      if (moved > 0) { const c = excess / moved; for (let i = 0; i < s.length; i++) s[i] = Math.max(0, s[i] - c * Math.abs(s[i] - a[i])) }
    }
    for (let i = 0; i < s.length; i++) a[i] = s[i] * decay
  }

  /**
   * Flux-form sedimentation of a precipitation field (first-order upwind from above, conservative): the mass flux through
   * the face between two levels is rho0 q Vt of the node above it, and the ground node loses rho0 q Vt through the
   * ground, which is added to `precipitation` (mm of water).
   */
  private sediment(rain: Float32Array, vt: Float32Array, dt: number) {
    const { nz, layer } = this.grid, rho = this.env.rho, lw = this.levelWeight, dz = this.grid.dz
    for (let i = 0; i < layer; i++) this.deposit(i, rho[0] * rain[i] * vt[i] * dt)
    // Level weight lw = rho0 h / dz, so dq = dt (F_in - F_out) / (lw dz). Bottom-up, so each face uses pre-step values above.
    for (let z = 0; z < nz; z++) {
      const l = z * layer, inflow = z < nz - 1 ? rho[z + 1] : 0
      for (let i = l; i < l + layer; i++) rain[i] += dt * (inflow * (z < nz - 1 ? rain[i + layer] * vt[i + layer] : 0) - rho[z] * rain[i] * vt[i]) / (lw[z] * dz)
    }
  }

  /**
   * Removes the small negative values WENO leaves behind (it is not positivity-preserving) and the tiny tails it spreads
   * (below TINY_WATER), without changing the total: they are set to zero and their net mass is given to or taken from
   * the remaining values in proportion to them. Exact zeros let the transport skip the empty air (see weno).
   */
  private fillNegative(a: Float32Array) {
    const { nz, layer } = this.grid, lw = this.levelWeight
    let removed = 0, kept = 0, negative = 0
    for (let z = 0, i = 0; z < nz; z++) {
      const wz = lw[z]
      for (let e = i + layer; i < e; i++) { const x = a[i]; if (x < TINY_WATER) { if (x !== 0) { removed += wz * x; if (x < 0) negative -= wz * x } } else kept += wz * x }
    }
    if (removed === 0 && negative === 0) return
    const scale = kept > 0 ? Math.max(0, 1 + removed / kept) : 0
    for (let i = 0; i < a.length; i++) a[i] = a[i] < TINY_WATER ? 0 : a[i] * scale
    this.negativeFilled += negative
  }

  /** Distance the domain has moved over the ground since the start (m east, m north). */
  frameOffset() { return [this.frame[0] * this.time, this.frame[1] * this.time] as const }

  /**
   * The ground under the domain this step: the surface pattern under each column and the four ground columns (with
   * bilinear weights) that receive its rain. `precipitation` is fixed to the ground, so the rain total is a real swath.
   * Without frame motion both are the identity.
   */
  private updateGround() {
    const { nx, ny, dx, dy } = this.grid, [ox, oy] = this.frameOffset(), sx = mod(ox / dx, nx), sy = mod(oy / dy, ny)
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0, c = this.groundCell, w = this.groundWeight, pattern = this.surfacePattern
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = x + nx * y, ax = (x + x0) % nx, bx = (ax + 1) % nx, ay = (y + y0) % ny * nx, by = (ay / nx + 1) % ny * nx, k = i * 4
      c[k] = ax + ay; c[k + 1] = bx + ay; c[k + 2] = ax + by; c[k + 3] = bx + by
      w[k] = (1 - fx) * (1 - fy); w[k + 1] = fx * (1 - fy); w[k + 2] = (1 - fx) * fy; w[k + 3] = fx * fy
      this.patternNow[i] = w[k] * pattern[c[k]] + w[k + 1] * pattern[c[k + 1]] + w[k + 2] * pattern[c[k + 2]] + w[k + 3] * pattern[c[k + 3]]
    }
  }

  /** Adds rain (mm) falling out of model column i to the ground columns under it. */
  private deposit(i: number, mm: number) {
    const c = this.groundCell, w = this.groundWeight, k = i * 4
    for (let j = 0; j < 4; j++) if (w[k + j] > 0) this.precipitation[c[k + j]] += w[k + j] * mm
  }

  /** Precipitation leaving through the ground this step: adds it to `precipitation` (mm) and returns it in level-weight (mass) units. */
  private fallout(rain: Float32Array, vt: Float32Array, dt: number) {
    const { layer, dz } = this.grid, rhoGround = this.env.rho[0]
    let total = 0
    for (let i = 0; i < layer; i++) { const flux = rain[i] * vt[i] * dt; this.deposit(i, rhoGround * flux); total += rhoGround * flux / dz }
    return total
  }

  // Departure points of one semi-Lagrangian step (8 corner indices + 3 weights per cell), shared by every field
  // so that all of them are carried by the same, pre-step velocity.
  private computeBacktrace(dt: number) {
    const grid = this.grid, { nx, ny, nz, dx, dy, layer } = grid, c = this.backtraceCorner, wt = this.backtraceWeight, u = this.u, v = this.v, w = this.w
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      const px = mod(x - u[i] * dt / dx, nx), py = mod(y - v[i] * dt / dy, ny), pz = shiftedLevel(grid, z, -w[i] * dt)
      const x0 = Math.floor(px), y0 = Math.floor(py), z0 = Math.min(Math.floor(pz), nz - 2), x1 = (x0 + 1) % nx, r0 = nx * y0, r1 = nx * ((y0 + 1) % ny), l0 = layer * z0, l1 = layer * (z0 + 1), k = i * 8
      c[k] = x0 + r0 + l0; c[k + 1] = x1 + r0 + l0; c[k + 2] = x0 + r1 + l0; c[k + 3] = x1 + r1 + l0; c[k + 4] = x0 + r0 + l1; c[k + 5] = x1 + r0 + l1; c[k + 6] = x0 + r1 + l1; c[k + 7] = x1 + r1 + l1
      wt[i * 3] = px - x0; wt[i * 3 + 1] = py - y0; wt[i * 3 + 2] = pz - z0
    }
  }

  /** Transport of `a` along the shared backtrace into the scratch buffer (see commit). */
  private advectBacktrace(a: Float32Array) {
    const n = this.grid.n, s = this.scratch, c = this.backtraceCorner, wt = this.backtraceWeight
    for (let i = 0; i < n; i++) {
      const k = i * 8, fx = wt[i * 3], fy = wt[i * 3 + 1], fz = wt[i * 3 + 2]
      const c00 = a[c[k]] + (a[c[k + 1]] - a[c[k]]) * fx, c10 = a[c[k + 2]] + (a[c[k + 3]] - a[c[k + 2]]) * fx, c01 = a[c[k + 4]] + (a[c[k + 5]] - a[c[k + 4]]) * fx, c11 = a[c[k + 6]] + (a[c[k + 7]] - a[c[k + 6]]) * fx
      const lo = c00 + (c10 - c00) * fy, hi = c01 + (c11 - c01) * fy; s[i] = lo + (hi - lo) * fz
    }
  }

  /**
   * Transport: flux-form WENO5 + RK3 (default since 2026-09-29; conserves water by itself) or the old trilinear
   * semi-Lagrangian one (about twice as fast, diffusive, needs the mass fixer).
   */
  transport: 'semi-lagrangian' | 'weno' = 'weno'
  /**
   * Microphysics: with ice (default since 2026-09-29): cloud ice and snow (src/core/ice.ts) and graupel
   * (src/core/graupel.ts), Lin et al. (1983); or Kessler warm rain only (cheaper, no anvil, no heat of fusion).
   */
  microphysics: 'warm' | 'ice' = 'ice'
  private flux: FluxTransport | null = null
  private turbulence: Turbulence | null = null

  /** Advances by real elapsed seconds scaled by the speed setting; returns the number of model steps taken. */
  advance(realDt: number) {
    this.accumulator += realDt * this.config.speed
    let steps = 0
    while (this.accumulator >= DT && steps < 12) { this.step(DT); this.accumulator -= DT; this.time += DT; steps++ }
    return steps
  }

  step(dt: number) {
    const { nx, ny, nz, zs, hz, height: H, layer, xp: XP, xm: XM, yp: YP, ym: YM } = this.grid
    this.microburstOutflow *= .993
    this.updateGround()
    // Water is transported conservatively (WENO: by the flux form; semi-Lagrangian: by the mass fixer). Only the
    // cold-pool indicator decays: it belongs to the cold-pool parameterisation and goes away with it.
    const { rho } = this.env, withIce = (this.config.microphysics ?? this.microphysics) === 'ice'
    // Precipitation fields with their fall speeds (snow only with ice microphysics).
    const falling: [Float32Array, Float32Array][] = withIce ? [[this.rain, this.fallSpeed], [this.snow, this.snowFall], [this.graupel, this.graupelFall]] : [[this.rain, this.fallSpeed]]
    for (let z = 0, i = 0; z < nz; z++) for (let end = i + layer; i < end; i++) { this.fallSpeed[i] = fallSpeed(this.rain[i], rho[z], rho[0]); this.snowFall[i] = snowFallSpeed(this.snow[i], rho[z], rho[0]); this.graupelFall[i] = graupelFallSpeed(this.graupel[i], rho[z]) }
    let carry: (a: Float32Array, decay: number, conserve?: boolean) => void
    if ((this.config.transport ?? this.transport) === 'weno') {
      // Flux-form WENO5 + RK3 with the velocity frozen at the start of the step. The face fluxes are projected to zero
      // divergence, so water is conserved by the scheme itself: no mass fixer, only a positivity fix (fillNegative).
      const flux = this.flux ??= new FluxTransport(this.grid, this.env.rho)
      flux.setVelocity(this.u, this.v, this.w)
      for (const [field, vt] of falling) {
        this.sediment(field, vt, dt)
        this.scratch.set(field); flux.advect(this.scratch, dt); this.fillNegative(this.scratch); this.commit(field, 1)
      }
      // WENO for water and the cold-pool indicator (no overshoots); linear 5th-order upwind for the smooth u, v, w, theta.
      carry = (a, decay, conserve = false) => {
        this.scratch.set(a); flux.advect(this.scratch, dt, a === this.q || a === this.cloud || a === this.ice || a === this.cold)
        if (conserve) this.fillNegative(this.scratch)
        this.commit(a, decay)
      }
    } else {
      for (const [field, fs] of falling) {
        const lost = this.fallout(field, fs, dt)
        // Semi-Lagrangian sedimentation looks up from the arrival node, so the rain-free air under a rain shaft must fall
        // at the speed of the rain above it: with its own (zero) speed rain only ever came down in downdrafts.
        for (let i = 0; i < fs.length - layer; i++) if (fs[i + layer] > fs[i]) fs[i] = fs[i + layer]
        this.advectFalling(field, dt, fs); this.commit(field, 1, true, lost)
      }
      this.computeBacktrace(dt)
      carry = (a, decay, conserve = false) => { this.advectBacktrace(a); this.commit(a, decay, conserve) }
    }
    carry(this.u, 1); carry(this.v, 1); carry(this.w, 1); carry(this.theta, 1); carry(this.q, 1, true); carry(this.cloud, 1, true); if (withIce) carry(this.ice, 1, true); carry(this.cold, .9992)
    const cfg = this.config, e = this.env, u = this.u, v = this.v, w = this.w, theta = this.theta, q = this.q, cloud = this.cloud, rain = this.rain, cold = this.cold
    const ice = this.ice, snow = this.snow, graupel = this.graupel, rhoGround = e.rho[0]
    const flux = surfaceFluxes(cfg, this.time), lfcZ = (this.sounding.lfc ?? 1.5) * 1000, f = 2 * OMEGA * Math.sin(cfg.latitude * Math.PI / 180)
    const spongeStart = Math.max(cfg.tropopause * 1000 + 2500, 14_000), liftTop = Math.min(3200, lfcZ)
    for (let z = 0, i = 0; z < nz; z++) {
      const alt = zs[z], p = e.p[z], rhoZ = e.rho[z], exner = e.exner[z], thEnv = e.theta[z], qEnv = e.q[z], thvEnv = thEnv * (1 + .61 * qEnv), ue = this.uEnv[z], ve = this.vEnv[z], l = z * layer
      for (let y = 0; y < ny; y++) {
        const row = y * nx, yp = YP[y], ym = YM[y]
        for (let x = 0; x < nx; x++, i++) {
          const xp = XP[x], xm = XM[x]
          // Kessler warm rain, then saturation adjustment (vapour and cloud water in equilibrium after every step).
          // Evaporation of rain and cloud feeds the cold-pool indicator.
          const evap = rainProcesses(q, cloud, rain, i, theta[i] * exner, p, rhoZ, dt)
          // Evaporation takes exactly L/cp per unit mass from the air (no strength multiplier): energy is conserved.
          if (evap > 0) { const cool = LV / CP / exner * evap; theta[i] -= cool; cold[i] += cool }
          // Ice: rain freezes (Bigg into graupel, below -40 °C at once into snow), snow aggregates, rimes, grows by
          // deposition, sublimates and melts, graupel rimes, collects and melts; melting and sublimation feed the cold-pool
          // indicator like evaporation.
          let cond: number
          if (withIce) {
            freezeRain(theta, rain, snow, i, exner)
            cold[i] += snowProcesses(theta, q, cloud, ice, snow, rain, i, exner, p, rhoZ, rhoGround, dt)
            cold[i] += graupelProcesses(theta, q, cloud, ice, snow, rain, graupel, i, exner, p, rhoZ, dt)
            // Mixed-phase saturation adjustment: water saturation above 0 °C, ice-weighted below, condensate frozen by T.
            cond = saturationAdjustMixed(theta, q, cloud, ice, i, exner, p)
          } else cond = saturationAdjust(theta, q, cloud, i, exner, p)
          if (cond < 0) cold[i] -= LV / CP / exner * cond * .14
          // B = g [(θv − θv_env) / θv_env − q_c − q_i − q_r − q_s − q_g]: condensate loads the air with its own mass.
          const buoy = (theta[i] * (1 + .61 * q[i]) - thvEnv) / thvEnv - cloud[i] - ice[i] - rain[i] - snow[i] - graupel[i]; w[i] += G * buoy * dt
          // Damp and rotate only the departure from the environmental wind, so the imposed shear profile is not eroded.
          const du = (u[i] - ue) * .9999, dv = (v[i] - ve) * .9999; u[i] = ue + du + f * dv * dt; v[i] = ve + dv - f * du * dt
          // Surface fluxes enter the lowest levels with the shares in surfaceShare, so the column receives exactly H and LE.
          if (z < this.surfaceShare.length) { const pattern = 1 + this.patternNow[x + row] * .32, per = pattern * this.surfaceShare[z] * dt / rhoZ; theta[i] += flux.sensible * per / (CP * exner); q[i] += flux.latent * per / LV }
          if (alt < liftTop) { const gx = cold[xp + row] - cold[xm + row], gy = cold[x + yp] - cold[x + ym], edge = Math.hypot(gx, gy), core = cold[x + row]; w[i] += G * edge / 300 * .45 * Math.max(.12, 1 - alt / Math.max(300, lfcZ)) * dt; if (alt < 1300 && core > 1) w[i] -= G * core / 300 * .52 * Math.exp(-alt / 520) * dt }
          if (z <= 1 && w[i] < -5 && rain[i] > .0001) { const impact = Math.min(38, -w[i] * Math.sqrt(rain[i] / .00055)), dpx = (-w[xp + row + l] + w[xm + row + l]) * .5, dpy = (-w[x + yp + l] + w[x + ym + l]) * .5; u[i] -= dpx * .12 * dt; v[i] -= dpy * .12 * dt; cold[i] += impact * .0012 * dt; this.microburstOutflow = Math.max(this.microburstOutflow, impact) }
          // Below 0.001 K the indicator is noise from the transport tails: zero, so the transport can skip it.
          cold[i] = cold[i] < 1e-3 ? 0 : Math.min(cold[i], 15)
          if (alt > spongeStart) { const s = clamp((alt - spongeStart) / (H - spongeStart)) * .06 * dt; w[i] *= 1 - s; u[i] = lerp(u[i], ue, s); v[i] = lerp(v[i], ve, s); theta[i] = lerp(theta[i], thEnv, s) }
        }
      }
    }
    // Smagorinsky-Lilly subgrid mixing of momentum, heat and water (replaces the old horizontal smoothing of theta and q).
    const turb = this.turbulence ??= new Turbulence(this.grid, e.rho)
    // Saturated stability inside clouds (cloud water plus ice): see Turbulence.viscosity.
    if (withIce) for (let k = 0; k < ice.length; k++) this.scratch[k] = cloud[k] + ice[k]
    const moist = { q, condensate: withIce ? this.scratch : cloud, exner: e.exner }
    turb.viscosity(u, v, w, theta, e.theta, SMAGORINSKY * cfg.turbulence / .55, dt, moist)
    turb.mix(u, this.uEnv, 1, dt); turb.mix(v, this.vEnv, 1, dt); turb.mix(w, null, 1, dt)
    turb.mix(theta, e.theta, 3, dt); turb.mix(q, e.q, 3, dt); turb.mix(cloud, null, 3, dt); if (withIce) turb.mix(ice, null, 3, dt)
    // Surface drag on the ground node, which owns half a layer: dV/dt = -C_D (|V| V - |V_env| V_env) / h_0. The
    // environment's own drag is taken as balanced by the large-scale flow that maintains the profile, so the background
    // stays steady (was: u, v *= 0.94 every step, which stopped the ground wind in ~16 s). Applied with the rigid
    // ground/top before the projection, so the transport velocity is D-free.
    // Friction acts on the wind over the ground: the model's (domain-relative) wind plus the frame velocity.
    const drag = dragCoefficient(cfg, 2 * hz[0]) * dt / hz[0], ue0 = e.u[0], ve0 = e.v[0], envSpeed = Math.hypot(ue0, ve0), [fu, fv] = this.frame
    for (let b = 0; b < layer; b++) {
      const ug = u[b] + fu, vg = v[b] + fv, speed = Math.hypot(ug, vg)
      u[b] -= drag * (speed * ug - envSpeed * ue0); v[b] -= drag * (speed * vg - envSpeed * ve0)
      w[b] = 0; w[b + (nz - 1) * layer] = 0
    }
    this.project(dt)
    this.updateRotation(dt)
  }

  /** Makes the node velocities exactly free of dual-cell divergence (see PressureSolver); ground and top are rigid walls. */
  private project(dt: number) {
    const u = this.u, v = this.v, w = this.w
    this.solver.divergence(u, v, w, dt, this.divergence)
    this.solver.solve(this.divergence, this.pressure)
    this.solver.correct(this.pressure, u, v, w, dt)
    let clipped = 0
    for (let i = 0; i < this.grid.n; i++) {
      if (u[i] < -U_LIMIT || u[i] > U_LIMIT) { u[i] = clamp(u[i], -U_LIMIT, U_LIMIT); clipped++ }
      if (v[i] < -U_LIMIT || v[i] > U_LIMIT) { v[i] = clamp(v[i], -U_LIMIT, U_LIMIT); clipped++ }
      if (w[i] < -W_LIMIT || w[i] > W_LIMIT) { w[i] = clamp(w[i], -W_LIMIT, W_LIMIT); clipped++ }
    }
    this.clipped += clipped
  }

  /** Vertical vorticity dv/dx - du/dy at a grid node, s-1. */
  zeta(x: number, y: number, z: number) {
    const { nx, dx, dy, layer, xp, xm, yp, ym } = this.grid, l = z * layer
    return (this.v[xp[x] + nx * y + l] - this.v[xm[x] + nx * y + l]) / (2 * dx) - (this.u[x + yp[y] + l] - this.u[x + ym[y] + l]) / (2 * dy)
  }

  private updateRotation(dt: number) {
    const { nx, ny, hz, zs, layer } = this.grid, [z0, z1] = this.uhLevels, r = this.rotation, col = this.uhColumn
    // Low layers: the levels up to 1 and 3 km (on the uniform ~650 m grid: one level at ~650 m, w = 0 on the ground; four).
    const top1 = zs.findLastIndex(z => z <= 1000), top3 = zs.findLastIndex(z => z <= 3000)
    let max = 0, min = 0, bx = 0, by = 0, max01 = 0, max03 = 0
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let uh = 0, low = 0
      for (let z = 1; z <= top3; z++) { low += this.w[x + nx * y + z * layer] * this.zeta(x, y, z) * hz[z]; if (z === top1) max01 = Math.max(max01, low) }
      max03 = Math.max(max03, low)
      for (let z = z0; z <= z1; z++) uh += this.w[x + nx * y + z * layer] * this.zeta(x, y, z) * hz[z]
      col[x + nx * y] = uh
      if (uh > max) { max = uh; bx = x; by = y }
      min = Math.min(min, uh)
    }
    r.uh = max; r.anticyclonic = -min; r.uh01 = max01; r.uh03 = max03; r.x = bx; r.y = by; r.persisted = max >= UH_MESOCYCLONE && max >= MESO_DOMINANCE * -min ? r.persisted + dt : 0
  }

  private countCores() {
    const { nx, ny, nz, layer } = this.grid, mask = new Uint8Array(layer)
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let active = false
      for (let z = 3; z < Math.min(nz - 2, 11); z++) { const i = x + nx * y + z * layer; if (this.w[i] > 2 && this.cloud[i] + this.ice[i] > .00007) { active = true; break } }
      mask[x + nx * y] = active ? 1 : 0
    }
    let cores = 0; const stack: number[] = []
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== 1) continue
      cores++; mask[i] = 2; stack.push(i)
      while (stack.length) {
        const a = stack.pop()!, x = a % nx, y = Math.floor(a / nx)
        for (const b of [mod(x + 1, nx) + nx * y, mod(x - 1, nx) + nx * y, x + nx * mod(y + 1, ny), x + nx * mod(y - 1, ny)]) if (mask[b] === 1) { mask[b] = 2; stack.push(b) }
      }
    }
    return cores
  }

  diagnostics(): ModelDiagnostics {
    const { nx, ny, nz, zs } = this.grid
    let up = 0, down = 0, rainRate = 0, top = 0, coldMax = 0, thermalTop = 0, maxCloud = 0
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      const alt = zs[z]
      up = Math.max(up, this.w[i]); down = Math.max(down, -this.w[i]); maxCloud = Math.max(maxCloud, this.cloud[i] + this.ice[i])
      if (this.cloud[i] + this.ice[i] > .00007) top = Math.max(top, alt / 1000)
      if (this.w[i] > .6) thermalTop = Math.max(thermalTop, alt / 1000)
      if (alt < 1500) coldMax = Math.max(coldMax, this.cold[i])
    }
    const [u0, v0] = this.env.windUV(0), [u6, v6] = this.env.windUV(6000)
    // Surface precipitation flux, rain and snow as water (was the largest q_r anywhere times 12000, 2-2.5x too low).
    const rho0 = this.env.rho[0]
    let rainTotal = 0
    for (let i = 0; i < this.grid.layer; i++) { rainRate = Math.max(rainRate, rho0 * (this.rain[i] * fallSpeed(this.rain[i], rho0, rho0) + this.snow[i] * snowFallSpeed(this.snow[i], rho0, rho0) + this.graupel[i] * graupelFallSpeed(this.graupel[i], rho0)) * 3600); rainTotal = Math.max(rainTotal, this.precipitation[i]) }
    return { updraft: up, downdraft: down, rainRate, rainTotal, cloudTop: top, thermalTop, maxCloud, coldMax, cores: this.countCores(), shear06: Math.hypot(u6 - u0, v6 - v0), microburst: this.microburstOutflow, clipped: this.clipped }
  }
}
