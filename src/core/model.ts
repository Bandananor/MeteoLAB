import type { SimConfig } from './config'
import { CP, DT, G, LV, OMEGA } from './constants'
import { Environment, type EnvironmentProfile } from './environment'
import { createGrid, domainGrid, type Grid, shiftedLevel } from './grid'
import { domainMotion } from './kinematics'
import { clamp, lerp, mod, mulberry32 } from './math'
import { FluxTransport, RK3 } from './advection'
import { weismanKlemp } from './profiles'
import { SMAGORINSKY, Turbulence } from './turbulence'
import { graupelFallSpeed, graupelProcesses } from './graupel'
import { hailFallSpeed, hailMaxDiameter, hailProcesses } from './hail'
import { freezeRain, saturationAdjustMixed, snowFallSpeed, snowProcesses } from './ice'
import { fallSpeed, rainProcesses, saturationAdjust } from './microphysics'
import { PressureSolver } from './pressure'
import { dragCoefficient, surfaceFluxes } from './surface'
import { computeSounding, type Sounding } from './sounding'
import { type Memory, type Phase, PRIVATE_MEMORY, type StepRunner, type TaskModel } from './threads'

/** One field a step transports: WENO (monotone) or linear upwind, with the positivity fix or not, and a decay factor per second. */
interface Carried { field: Float32Array; monotone: boolean; conserve: boolean; decay: number }
/** At most this many fields are transported (rain, snow, graupel, hail, u, v, w, theta, vapour, cloud, ice, cold pool). */
const MAX_CARRIED = 12
/**
 * Slabs of levels each transported field is split into when helper threads share the step (AtmosphereModel.transportSlabs):
 * finer work for them, but ~15 % more work in all (each slab recomputes the vertical flux below it).
 */
export const TRANSPORT_SLABS = 10

export interface ModelOptions {
  /** Where the arrays helper threads read live (threads.ts); default ordinary arrays. */
  memory?: Memory
  /** A helper's view of a model running elsewhere: the fields are not initialised (they are the main thread's). */
  attach?: boolean
}

// Updraft helicity (integral of w*zeta over 2-5 km, m2/s2): levels of rotation strength for the display and the cell
// stages, and the persistence that makes rotation a mesocyclone. Since 2026-10-08 the mesocyclone itself is decided by
// MESO_CORE_ZETA (UH also counts vortex pairs of both signs: up to ~400-600 in weak shear; supercells 700-1900; 3-km NWP
// uses ~75).
export const UH_ROTATING = 200, UH_MESOCYCLONE = 400, MESO_PERSISTENCE = 600
/** Condensate below this mixing ratio (kg/kg, 1e-7 g/kg) is set to zero by the WENO positivity fix, conservatively. */
const TINY_WATER = 1e-10
/** Safety limits of the horizontal and vertical velocity, m/s (see AtmosphereModel.clipped). */
export const U_LIMIT = 120, W_LIMIT = 100
/** Updraught (m/s) of the 2-5 km nodes that count as an updraught core for RotationState.coreZeta. */
export const CORE_ROTATION_W = 10
/**
 * Mesocyclone criterion (2026-10-08): the updraught core itself rotates, coreZeta >= this (s-1), for MESO_PERSISTENCE.
 * It replaced "UH 2-5 km >= UH_MESOCYCLONE and 1.5x the strongest anticyclonic UH anywhere": a strong updraught tilts the
 * shear's vorticity into a vortex pair on its flanks, honest physics that grows with w (UH ~ w zeta ~ w^2), and the
 * old criterion counted a weak-shear pair whenever its cyclonic member briefly outweighed the other. In the core-weighted
 * mean the pair cancels. Cloud experiments: HSLC and Weisman-Klemp hold it 1300-1500 s, all other scenarios <= 360 s.
 */
export const MESO_CORE_ZETA = 3e-3

export interface RotationState {
  /** Strongest cyclonic / anticyclonic UH 2-5 km (m2/s2), the column of the cyclonic one, and how long (s) a mesocyclone has held (MESO_CORE_ZETA). */
  uh: number; x: number; y: number; anticyclonic: number; persisted: number
  /**
   * Rotation of the updraught itself: the w-weighted mean vertical vorticity (s-1) over the 2-5 km nodes with w above
   * CORE_ROTATION_W of the most cyclonic updraught core (connected columns), and that core's strongest UH. A vortex pair
   * that a strong updraught tilts out of the shear sits on its two flanks and cancels here; a mesocyclone does not.
   */
  coreZeta: number; coreUH: number
  /** The same for the most anticyclonic core (positive, s-1): a left mover after a split. */
  coreAnti: number
  /** Largest cyclonic updraft helicity of the 0-1 and 0-3 km layers (low-level mesocyclone), m2/s2. */
  uh01: number; uh03: number
}

export interface ModelDiagnostics {
  /** Heaviest rain reaching the ground now, mm/h: rho0 q_r V_t at the surface. */ rainRate: number
  /** Largest rain total on the ground since the start, mm. */ rainTotal: number
  updraft: number; downdraft: number; cloudTop: number; thermalTop: number
  maxCloud: number; coldMax: number; cores: number; shear06: number
  /** Strongest wind over the ground at the ~100 m level, m/s: outflow and downburst gusts. */ gust: number
  /** Diameter of the largest hailstones reaching the ground now, mm (0: no hail at the ground). */ hail: number
  /**
   * Velocity components clipped by the safety limits since the start. The limits (|u|, |v| <= 120, |w| <= 100 m/s,
   * raised from 85 / 60 on 2026-09-29) lie well above any real storm and well inside the stability of both transports
   * (Courant number ~0.1-0.15 at dt = 1 s): a non-zero count means a genuine blow-up, not a strong updraught.
   */
  clipped: number
}

/** Cloud-scale atmosphere on a periodic box: prognostic u, v, w, theta, q, cloud water, cloud ice, rain, snow, graupel, hail and the cold-pool indicator. */
export class AtmosphereModel implements TaskModel {
  readonly grid: Grid; readonly config: SimConfig; readonly env: Environment
  readonly u: Float32Array; readonly v: Float32Array; readonly w: Float32Array; readonly theta: Float32Array
  readonly q: Float32Array; readonly cloud: Float32Array; readonly rain: Float32Array
  /** Cold-pool indicator, K: cooling by evaporation, melting and sublimation, carried by the flow (diagnostic only). */
  readonly cold: Float32Array
  /** Cloud ice, snow, graupel and hail mixing ratios, kg/kg (ice microphysics, src/core/ice.ts, graupel.ts, hail.ts). */
  readonly ice: Float32Array; readonly snow: Float32Array; readonly graupel: Float32Array; readonly hail: Float32Array
  /** Projection pressure (times dt, per unit density) at the dual-cell centres between nodes; see PressureSolver. */
  readonly pressure: Float64Array
  /** Updraft helicity of every column (2-5 km), m2/s2. */
  readonly uhColumn: Float32Array
  /** Per column, the 2-5 km updraught-core sums w hz and w zeta hz, and a flood-fill label (see RotationState.coreZeta). */
  readonly coreW: Float64Array; readonly coreWZ: Float64Array; private readonly coreLabel: Uint8Array
  /** Rain that has reached the ground in each column since the start, mm (kg/m2). */
  readonly precipitation: Float32Array
  /** Fall speed of rain at every node (Kessler), m/s, raised to that of the rain just above (sedimentation), updated each step. */
  readonly fallSpeed: Float32Array
  /** Mass-weighted fall speeds of snow, graupel and hail at each node, m/s. */
  readonly snowFall: Float32Array; readonly graupelFall: Float32Array; readonly hailFall: Float32Array
  /**
   * Hail on the ground in each column since the start, mm of water (also counted in `precipitation`), and the diameter
   * of the largest stones that have fallen there, mm (see hailMaxDiameter): the hail swath.
   */
  readonly hailGround: Float32Array; readonly hailSize: Float32Array
  readonly rotation: RotationState = { uh: 0, x: 0, y: 0, anticyclonic: 0, persisted: 0, uh01: 0, uh03: 0, coreZeta: 0, coreUH: 0, coreAnti: 0 }
  readonly sounding: Sounding
  /** Lowest and highest level of the 2-5 km updraft-helicity layer. */
  readonly uhLevels: readonly [number, number]
  time = 0
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
  constructor(config: SimConfig, grid: Grid = createGrid(domainGrid(config.domain)), profile?: EnvironmentProfile, options: ModelOptions = {}) {
    this.config = config; this.grid = grid; this.memory = options.memory ?? PRIVATE_MEMORY
    const shared = (name: string, length = grid.n) => this.memory.f32(name, length)
    this.env = new Environment(config, grid, profile ?? (config.profile === 'weisman-klemp' ? weismanKlemp({ qvMax: .016 }) : undefined))
    this.frame = config.followStorm === false ? [0, 0] : domainMotion(this.env)
    this.uEnv = this.env.u.map(u => u - this.frame[0]); this.vEnv = this.env.v.map(v => v - this.frame[1])
    this.patternNow = shared('patternNow', grid.layer); this.groundCell = new Int32Array(grid.layer * 4); this.groundWeight = new Float64Array(grid.layer * 4)
    const f = () => new Float32Array(grid.n)
    this.u = shared('u'); this.v = shared('v'); this.w = shared('w'); this.theta = shared('theta'); this.q = shared('q'); this.cloud = shared('cloud'); this.rain = shared('rain'); this.cold = shared('cold')
    this.ice = shared('ice'); this.snow = shared('snow'); this.snowFall = shared('snowFall'); this.graupel = shared('graupel'); this.graupelFall = shared('graupelFall'); this.hail = shared('hail'); this.hailFall = shared('hailFall')
    this.condensate = shared('condensate')
    this.stageStart = Array.from({ length: MAX_CARRIED }, (_, k) => shared(`start${k}`)); this.stageTend = Array.from({ length: MAX_CARRIED }, (_, k) => this.memory.f64(`tend${k}`, grid.n))
    this.taskNegative = this.memory.f64('taskNegative', 32)
    this.flux = new FluxTransport(grid, this.env.rho, this.memory); this.turbulence = new Turbulence(grid, this.env.rho, this.memory)
    this.hailGround = new Float32Array(grid.layer); this.hailSize = new Float32Array(grid.layer)
    // Anelastic: the projection makes the mass flux rho0 u divergence-free (rho0 falls ~6x over 15 km).
    this.solver = new PressureSolver(grid, this.env.rho, this.memory)
    this.pressure = this.memory.f64('pressure', this.solver.cells); this.divergence = this.memory.f64('divergence', this.solver.cells); this.scratch = f()
    this.coreW = new Float64Array(grid.layer); this.coreWZ = new Float64Array(grid.layer); this.coreLabel = new Uint8Array(grid.layer)
    this.surfacePattern = new Float32Array(grid.layer); this.uhColumn = new Float32Array(grid.layer); this.precipitation = new Float32Array(grid.layer); this.fallSpeed = shared('fallSpeed')
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
    if (!options.attach) this.initialize()
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
      this.cloud[i] = this.rain[i] = this.cold[i] = this.ice[i] = this.snow[i] = this.graupel[i] = this.hail[i] = 0
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
    const { nx, ny, nz, dx, dy, zs, width: W, depth: D } = this.grid, radius = (this.config.bubbleRadius ?? 4.2) * 1000
    // The levels up to 2.7 km (the lowest five on the old uniform grid): the thermal's depth is set in metres, not levels.
    for (let z = 0; z < nz && zs[z] < 2700; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let ddx = x * dx - cx, ddy = y * dy - cy
      if (ddx > W / 2) ddx -= W; if (ddx < -W / 2) ddx += W; if (ddy > D / 2) ddy -= D; if (ddy < -D / 2) ddy += D
      const d2 = (ddx / radius) ** 2 + (ddy / radius) ** 2 + (zs[z] / 1800) ** 2, a = Math.exp(-d2) * strength, i = x + nx * (y + ny * z)
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
    // The explicit upwind fall is stable while a node loses at most all of its water in one go: large hail (30-40 m/s)
    // through the 100 m levels at the ground needs sub-steps at dt = 3 s (fall speeds kept from the start of the step).
    let courant = 0
    for (let z = 0; z < nz; z++) { const c = dt * rho[z] / (lw[z] * dz); for (let i = z * layer; i < (z + 1) * layer; i++) if (rain[i] > 0) courant = Math.max(courant, c * vt[i]) }
    const parts = Math.max(1, Math.ceil(courant / .8))
    for (let p = 0; p < parts; p++) this.sedimentPart(rain, vt, dt / parts)
  }

  private sedimentPart(rain: Float32Array, vt: Float32Array, dt: number) {
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
   * the remaining values in proportion to them. Exact zeros let the transport skip the empty air (see weno). Returns
   * the negative mass it removed (level-weight units).
   */
  private fillNegative(a: Float32Array) {
    const { nz, layer } = this.grid, lw = this.levelWeight
    let removed = 0, kept = 0, negative = 0
    for (let z = 0, i = 0; z < nz; z++) {
      const wz = lw[z]
      for (let e = i + layer; i < e; i++) { const x = a[i]; if (x < TINY_WATER) { if (x !== 0) { removed += wz * x; if (x < 0) negative -= wz * x } } else kept += wz * x }
    }
    if (removed === 0 && negative === 0) return 0
    const scale = kept > 0 ? Math.max(0, 1 + removed / kept) : 0
    for (let i = 0; i < a.length; i++) a[i] = a[i] < TINY_WATER ? 0 : a[i] * scale
    return negative
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

  /** Adds rain (mm) falling out of model column i to the ground columns under it (to `precipitation` or `target`). */
  private deposit(i: number, mm: number, target = this.precipitation) {
    const c = this.groundCell, w = this.groundWeight, k = i * 4
    for (let j = 0; j < 4; j++) if (w[k + j] > 0) target[c[k + j]] += w[k + j] * mm
  }

  /** The hail swath: hail leaving the ground nodes this step (before sedimentation moves it) and the largest stones. */
  private collectHail(dt: number) {
    const rho0 = this.env.rho[0], c = this.groundCell, w = this.groundWeight
    for (let i = 0; i < this.grid.layer; i++) {
      const h = this.hail[i]
      if (!(h > 1e-9)) continue
      this.deposit(i, rho0 * h * this.hailFall[i] * dt, this.hailGround)
      const size = hailMaxDiameter(h, rho0) * 1000
      for (let j = 0; j < 4; j++) if (w[i * 4 + j] > 0) this.hailSize[c[i * 4 + j]] = Math.max(this.hailSize[c[i * 4 + j]], size)
    }
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
  /** Subgrid filter width of the horizontal mixing: (dx dy dz)^(1/3), or sqrt(dx dy) (experiment; see Turbulence.anisotropic). */
  turbulenceWidth: 'cube' | 'anisotropic' = 'cube'
  /**
   * Reference cases (Straka et al. 1993, Bryan & Fritsch 2002): a constant eddy viscosity, m2/s, the same for momentum
   * and scalars, instead of Smagorinsky; null = Smagorinsky.
   */
  fixedViscosity: number | null = null
  /** Drag on the ground node; off in the free-slip reference cases. */
  surfaceDrag = true
  /**
   * Relaxation of the wind departure from the environmental wind, s-1: 1e-4 (was a factor .9999 per step, which tied
   * the damping to the step length); 0 in the reference cases.
   */
  windRelaxation = 1e-4
  /** Warm rain (Kessler); off for the reversible moist reference case: cloud water only condenses and evaporates. */
  rainFormation = true
  // Created with the model, so that their shared arrays exist before any helper thread attaches.
  private readonly flux: FluxTransport; private readonly turbulence: Turbulence
  private readonly memory: Memory
  /** Mass the positivity fix moved in each transport task of this step (summed in task order into negativeFilled). */
  private readonly taskNegative: Float64Array
  /** Per transported field: its value at the start of the step and the tendency of the current Runge-Kutta stage. */
  private readonly stageStart: Float32Array[]; private readonly stageTend: Float64Array[]
  /** Cloud water plus ice (the saturated stability of the eddy viscosity), filled by the physics. */
  private readonly condensate: Float32Array
  /** Runs the parallel phases of a step: here, in order (default), or on helper threads (threads.ts). */
  runner: StepRunner = { run: (phase, tasks, dt) => { for (let k = 0; k < tasks; k++) this.runTask(phase, k, dt) } }
  /** Slabs of levels per transported field (1: whole fields, for one thread; TRANSPORT_SLABS with helper threads). */
  transportSlabs = 1

  /** Advances by real elapsed seconds scaled by the speed setting; returns the number of model steps taken. */
  advance(realDt: number) {
    this.accumulator += realDt * this.config.speed
    let steps = 0
    while (this.accumulator >= DT && steps < 12) { this.step(DT); this.accumulator -= DT; this.time += DT; steps++ }
    return steps
  }

  step(dt: number) {
    const { nz, hz, layer } = this.grid
    this.updateGround()
    // Water is transported conservatively (WENO: by the flux form; semi-Lagrangian: by the mass fixer). Only the
    // cold-pool indicator decays. It is a diagnostic only since 2026-10-08: the cold-pool and microburst
    // parameterisations that pushed the air by it (lift on its edge, a push down in its core, a radial push of a
    // rain-loaded downdraught at the ground) are gone — they gave 30-36 m/s downdraughts and 44-52 m/s winds at
    // 100 m in ordinary storms; without them 9-16 and 20-29 m/s, the WK supercell unchanged (cloud experiments).
    const withIce = (this.config.microphysics ?? this.microphysics) === 'ice'
    // Precipitation fields with their fall speeds (snow only with ice microphysics).
    const falling: [Float32Array, Float32Array][] = withIce ? [[this.rain, this.fallSpeed], [this.snow, this.snowFall], [this.graupel, this.graupelFall], [this.hail, this.hailFall]] : [[this.rain, this.fallSpeed]]
    this.runner.run('fall', nz, dt)
    if (withIce) this.collectHail(dt)
    if ((this.config.transport ?? this.transport) === 'weno') {
      // Flux-form WENO5 + RK3 with the velocity frozen at the start of the step. The face fluxes are projected to zero
      // divergence, so water is conserved by the scheme itself: no mass fixer, only a positivity fix (fillNegative).
      // Precipitation first falls (sedimentation, here), then every field is transported (one task per field).
      // The face fluxes of the transport velocity, projected (FluxTransport.setVelocity, in parts).
      const run = (phase: Phase, tasks: number) => this.runner.run(phase, tasks, dt)
      run('faces', nz); run('faceDivergence', nz); run('faceForward', nz); run('faceModes', this.grid.ny); run('faceInverse', nz); run('faceCorrect', nz); run('faceDivergence', nz)
      for (const [field, vt] of falling) this.sediment(field, vt, dt)
      const carried = this.carried(), tasks = carried.length * this.slabs()
      for (const stage of [0, 1, 2] as const) { this.runner.run(`tendency${stage}`, tasks, dt); this.runner.run(`update${stage}`, tasks, dt) }
      this.runner.run('finish', carried.length, dt)
      for (let k = 0; k < carried.length; k++) if (carried[k].conserve) this.negativeFilled += this.taskNegative[k]
    } else {
      for (const [field, fs] of falling) {
        const lost = this.fallout(field, fs, dt)
        // Semi-Lagrangian sedimentation looks up from the arrival node, so the rain-free air under a rain shaft must fall
        // at the speed of the rain above it: with its own (zero) speed rain only ever came down in downdrafts.
        for (let i = 0; i < fs.length - layer; i++) if (fs[i + layer] > fs[i]) fs[i] = fs[i + layer]
        this.advectFalling(field, dt, fs); this.commit(field, 1, true, lost)
      }
      this.computeBacktrace(dt)
      const carry = (a: Float32Array, decay: number, conserve = false) => { this.advectBacktrace(a); this.commit(a, decay, conserve) }
      carry(this.u, 1); carry(this.v, 1); carry(this.w, 1); carry(this.theta, 1); carry(this.q, 1, true); carry(this.cloud, 1, true); if (withIce) carry(this.ice, 1, true); carry(this.cold, .9992 ** dt)
    }
    // Microphysics, buoyancy, Coriolis, surface fluxes and the sponge: node by node, one task per level.
    this.runner.run('physics', nz, dt)
    const cfg = this.config, e = this.env, u = this.u, v = this.v, w = this.w
    // Smagorinsky-Lilly subgrid mixing of momentum, heat and water (replaces the old horizontal smoothing of theta and q).
    const turb = this.turbulence
    turb.anisotropic = this.turbulenceWidth === 'anisotropic'
    const fixed = this.fixedViscosity
    if (fixed === null) this.runner.run('viscosity', nz, dt)
    else { turb.km.fill(fixed); turb.kh.fill(fixed) }
    this.runner.run('mix', this.mixed().length, dt)
    // Surface drag on the ground node, which owns half a layer: dV/dt = -C_D (|V| V - |V_env| V_env) / h_0. The
    // environment's own drag is taken as balanced by the large-scale flow that maintains the profile, so the background
    // stays steady (was: u, v *= 0.94 every step, which stopped the ground wind in ~16 s). Applied with the rigid
    // ground/top before the projection, so the transport velocity is D-free.
    // Friction acts on the wind over the ground: the model's (domain-relative) wind plus the frame velocity.
    const drag = this.surfaceDrag ? dragCoefficient(cfg, 2 * hz[0]) * dt / hz[0] : 0, ue0 = e.u[0], ve0 = e.v[0], envSpeed = Math.hypot(ue0, ve0), [fu, fv] = this.frame
    for (let b = 0; b < layer; b++) {
      const ug = u[b] + fu, vg = v[b] + fv, speed = Math.hypot(ug, vg)
      u[b] -= drag * (speed * ug - envSpeed * ue0); v[b] -= drag * (speed * vg - envSpeed * ve0)
      w[b] = 0; w[b + (nz - 1) * layer] = 0
    }
    this.project(dt)
    this.updateRotation(dt)
  }

  /** Does task k of a parallel phase (see threads.ts): transport field k, physics of level k, or mixing of field k. */
  runTask(phase: Phase, k: number, dt: number) {
    const { nz, layer } = this.grid
    switch (phase) {
      case 'fall': {
        const rho = this.env.rho
        for (let i = k * layer, end = i + layer; i < end; i++) { this.fallSpeed[i] = fallSpeed(this.rain[i], rho[k], rho[0]); this.snowFall[i] = snowFallSpeed(this.snow[i], rho[k], rho[0]); this.graupelFall[i] = graupelFallSpeed(this.graupel[i], rho[k]); this.hailFall[i] = hailFallSpeed(this.hail[i], rho[k]) }
        break
      }
      case 'tendency0': case 'tendency1': case 'tendency2': case 'update0': case 'update1': case 'update2': {
        // Task k: field k / slabs, levels of slab k % slabs. The first tendency also saves the field's starting value.
        const slabs = this.slabs(), f = Math.floor(k / slabs), j = k % slabs, c = this.carried()[f]
        const z0 = Math.floor(j * nz / slabs), z1 = Math.floor((j + 1) * nz / slabs), a = c.field, start = this.stageStart[f], tend = this.stageTend[f]
        if (phase === 'tendency0') start.set(a.subarray(z0 * layer, z1 * layer), z0 * layer)
        if (phase.startsWith('tendency')) this.flux.tendency(a, tend, z0, z1, c.monotone)
        else { const fraction = RK3[Number(phase[6])] * dt; for (let i = z0 * layer; i < z1 * layer; i++) a[i] = start[i] + fraction * tend[i] }
        break
      }
      case 'finish': {
        const c = this.carried()[k], a = c.field
        this.taskNegative[k] = c.conserve ? this.fillNegative(a) : 0
        if (c.decay !== 1) { const keep = c.decay ** dt; for (let i = 0; i < a.length; i++) a[i] *= keep }
        break
      }
      case 'physics': this.physics(k, dt); break
      case 'faces': this.flux.faces(this.u, this.v, this.w, k, k + 1); break
      case 'faceDivergence': this.flux.divergence(k, k + 1); break
      case 'faceForward': this.flux.forward(k, k + 1); break
      case 'faceModes': this.flux.modes(k, k + 1); break
      case 'faceInverse': this.flux.inverse(k, k + 1); break
      case 'faceCorrect': this.flux.correctFaces(k, k + 1); break
      case 'pressureDivergence': this.solver.divergence(this.u, this.v, this.w, dt, this.divergence, k, k + 1); break
      case 'pressureForward': this.solver.transform(this.divergence, k, k + 1); break
      case 'pressureModes': this.solver.modes(k, k + 1); break
      case 'pressureInverse': this.solver.back(this.pressure, k, k + 1); break
      case 'pressureCorrect': this.solver.correct(this.pressure, this.u, this.v, this.w, dt, k, k + 1); break
      case 'viscosity': {
        // Saturated stability inside clouds (cloud water plus ice): see Turbulence.viscosity.
        const e = this.env, moist = { q: this.q, condensate: this.withIce() ? this.condensate : this.cloud, exner: e.exner }
        this.turbulence.viscosity(this.u, this.v, this.w, this.theta, e.theta, SMAGORINSKY * this.config.turbulence / .55, dt, moist, k, k + 1)
        break
      }
      case 'mix': { const [a, base, factor] = this.mixed()[k]; this.turbulence.mix(a, base, factor, dt) }
    }
  }

  private slabs() { return Math.max(1, Math.min(this.transportSlabs, this.grid.nz)) }

  private withIce() { return (this.config.microphysics ?? this.microphysics) === 'ice' }

  /** The fields a step transports, in order: falling precipitation, wind and theta (linear upwind), vapour and cloud, the cold-pool indicator. */
  private carried(): Carried[] {
    const withIce = this.withIce(), c: Carried[] = [], water = (field: Float32Array) => c.push({ field, monotone: true, conserve: true, decay: 1 })
    water(this.rain); if (withIce) { water(this.snow); water(this.graupel); water(this.hail) }
    // WENO for water and the cold-pool indicator (no overshoots); linear 5th-order upwind for the smooth u, v, w, theta.
    for (const field of [this.u, this.v, this.w, this.theta]) c.push({ field, monotone: false, conserve: false, decay: 1 })
    water(this.q); water(this.cloud); if (withIce) water(this.ice)
    c.push({ field: this.cold, monotone: true, conserve: false, decay: .9992 })
    return c
  }

  /** The fields the subgrid turbulence mixes, with the base state it mixes the departure from and the K factor (1/Pr for scalars). */
  private mixed(): [Float32Array, ArrayLike<number> | null, number][] {
    const scalars = this.fixedViscosity === null ? 3 : 1, e = this.env
    const list: [Float32Array, ArrayLike<number> | null, number][] = [[this.u, this.uEnv, 1], [this.v, this.vEnv, 1], [this.w, null, 1], [this.theta, e.theta, scalars], [this.q, e.q, scalars], [this.cloud, null, scalars]]
    if (this.withIce()) list.push([this.ice, null, scalars])
    return list
  }

  /** Microphysics, buoyancy, Coriolis, surface fluxes and the sponge at every node of level z (nodes are independent). */
  private physics(z: number, dt: number) {
    const { nx, ny, zs, height: H, layer } = this.grid, withIce = this.withIce()
    const cfg = this.config, e = this.env, u = this.u, v = this.v, w = this.w, theta = this.theta, q = this.q, cloud = this.cloud, rain = this.rain, cold = this.cold
    const ice = this.ice, snow = this.snow, graupel = this.graupel, hail = this.hail, rhoGround = e.rho[0]
    const flux = surfaceFluxes(cfg, this.time), f = 2 * OMEGA * Math.sin(cfg.latitude * Math.PI / 180)
    const spongeStart = Math.max(cfg.tropopause * 1000 + 2500, 14_000), keep = Math.exp(-this.windRelaxation * dt)
    {
      let i = z * layer
      const alt = zs[z], p = e.p[z], rhoZ = e.rho[z], exner = e.exner[z], thEnv = e.theta[z], qEnv = e.q[z], thvEnv = thEnv * (1 + .61 * qEnv), ue = this.uEnv[z], ve = this.vEnv[z]
      for (let y = 0; y < ny; y++) {
        const row = y * nx
        for (let x = 0; x < nx; x++, i++) {
          // Kessler warm rain, then saturation adjustment (vapour and cloud water in equilibrium after every step).
          // Evaporation of rain and cloud feeds the cold-pool indicator.
          const evap = this.rainFormation ? rainProcesses(q, cloud, rain, i, theta[i] * exner, p, rhoZ, dt) : 0
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
            cold[i] += hailProcesses(theta, q, cloud, ice, snow, rain, graupel, hail, i, exner, p, rhoZ, dt)
            // Mixed-phase saturation adjustment: water saturation above 0 °C, ice-weighted below, condensate frozen by T.
            cond = saturationAdjustMixed(theta, q, cloud, ice, i, exner, p)
          } else cond = saturationAdjust(theta, q, cloud, i, exner, p)
          if (cond < 0) cold[i] -= LV / CP / exner * cond * .14
          // B = g [(θv − θv_env) / θv_env − q_c − q_i − q_r − q_s − q_g]: condensate loads the air with its own mass.
          const buoy = (theta[i] * (1 + .61 * q[i]) - thvEnv) / thvEnv - cloud[i] - ice[i] - rain[i] - snow[i] - graupel[i] - hail[i]; w[i] += G * buoy * dt
          // Damp and rotate only the departure from the environmental wind, so the imposed shear profile is not eroded.
          const du = (u[i] - ue) * keep, dv = (v[i] - ve) * keep; u[i] = ue + du + f * dv * dt; v[i] = ve + dv - f * du * dt
          // Surface fluxes enter the lowest levels with the shares in surfaceShare, so the column receives exactly H and LE.
          if (z < this.surfaceShare.length) { const pattern = 1 + this.patternNow[x + row] * .32, per = pattern * this.surfaceShare[z] * dt / rhoZ; theta[i] += flux.sensible * per / (CP * exner); q[i] += flux.latent * per / LV }
          // Below 0.001 K the indicator is noise from the transport tails: zero, so the transport can skip it.
          cold[i] = cold[i] < 1e-3 ? 0 : Math.min(cold[i], 15)
          if (alt > spongeStart) { const s = clamp((alt - spongeStart) / (H - spongeStart)) * .06 * dt; w[i] *= 1 - s; u[i] = lerp(u[i], ue, s); v[i] = lerp(v[i], ve, s); theta[i] = lerp(theta[i], thEnv, s) }
        }
      }
    }
    if (withIce) for (let i = z * layer, e = i + layer; i < e; i++) this.condensate[i] = cloud[i] + ice[i]
  }

  /** The settings helper threads must follow (threads.ts): the config and the model's switches. */
  settings() {
    return JSON.stringify({ config: this.config, microphysics: this.microphysics, transport: this.transport, rainFormation: this.rainFormation, windRelaxation: this.windRelaxation, fixedViscosity: this.fixedViscosity, transportSlabs: this.transportSlabs })
  }

  applySettings(json: string) {
    const s = JSON.parse(json)
    Object.assign(this.config, s.config)
    this.microphysics = s.microphysics; this.transport = s.transport; this.rainFormation = s.rainFormation; this.windRelaxation = s.windRelaxation; this.fixedViscosity = s.fixedViscosity; this.transportSlabs = s.transportSlabs
  }

  /** Makes the node velocities exactly free of dual-cell divergence (see PressureSolver); ground and top are rigid walls. */
  private project(dt: number) {
    const u = this.u, v = this.v, w = this.w
    const { nz, ny } = this.grid, run = (phase: Phase, tasks: number) => this.runner.run(phase, tasks, dt)
    run('pressureDivergence', nz - 1); run('pressureForward', nz - 1); run('pressureModes', ny); run('pressureInverse', nz - 1); run('pressureCorrect', nz)
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
    const coreW = this.coreW, coreWZ = this.coreWZ
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let uh = 0, low = 0, sw = 0, swz = 0
      for (let z = 1; z <= top3; z++) { low += this.w[x + nx * y + z * layer] * this.zeta(x, y, z) * hz[z]; if (z === top1) max01 = Math.max(max01, low) }
      max03 = Math.max(max03, low)
      for (let z = z0; z <= z1; z++) {
        const w = this.w[x + nx * y + z * layer], wz = w * this.zeta(x, y, z) * hz[z]
        uh += wz
        if (w > CORE_ROTATION_W) { sw += w * hz[z]; swz += wz }
      }
      col[x + nx * y] = uh; coreW[x + nx * y] = sw; coreWZ[x + nx * y] = swz
      if (uh > max) { max = uh; bx = x; by = y }
      min = Math.min(min, uh)
    }
    // Updraught cores: connected columns (8 neighbours, periodic) with 2-5 km nodes above CORE_ROTATION_W.
    const label = this.coreLabel.fill(0), stack: number[] = []
    let coreZeta = 0, coreUH = 0, coreAnti = 0
    for (let start = 0; start < layer; start++) {
      if (coreW[start] <= 0 || label[start]) continue
      let sw = 0, swz = 0, peak = 0
      label[start] = 1; stack.push(start)
      while (stack.length) {
        const a = stack.pop()!, x = a % nx, y = (a - x) / nx
        sw += coreW[a]; swz += coreWZ[a]; peak = Math.max(peak, col[a])
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const b = (x + ox + nx) % nx + nx * ((y + oy + ny) % ny)
          if (coreW[b] > 0 && !label[b]) { label[b] = 1; stack.push(b) }
        }
      }
      if (swz / sw > coreZeta) { coreZeta = swz / sw; coreUH = peak }
      coreAnti = Math.max(coreAnti, -swz / sw)
    }
    r.coreZeta = coreZeta; r.coreUH = coreUH; r.coreAnti = coreAnti
    r.uh = max; r.anticyclonic = -min; r.uh01 = max01; r.uh03 = max03; r.x = bx; r.y = by; r.persisted = coreZeta >= MESO_CORE_ZETA ? r.persisted + dt : 0
  }

  private countCores() {
    const { nx, ny, nz, zs, layer } = this.grid, mask = new Uint8Array(layer)
    // Cores between ~1.9 and 6.6 km (levels 3-10 of the old uniform 652 m grid; on the stretched grid those indices lay
    // at 0.3-1.1 km, below cloud base, so almost no core was found).
    const lo = zs.findIndex(z => z >= 1900), hi = Math.min(nz - 3, zs.findLastIndex(z => z <= 6600))
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let active = false
      for (let z = lo; z <= hi; z++) { const i = x + nx * y + z * layer; if (this.w[i] > 2 && this.cloud[i] + this.ice[i] > .00007) { active = true; break } }
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
    let rainTotal = 0, gust = 0
    const near = this.grid.zs.findIndex(z => z >= 100) * this.grid.layer, [fu, fv] = this.frame
    for (let c = 0; c < this.grid.layer; c++) gust = Math.max(gust, Math.hypot(this.u[near + c] + fu, this.v[near + c] + fv))
    for (let i = 0; i < this.grid.layer; i++) { rainRate = Math.max(rainRate, rho0 * (this.rain[i] * fallSpeed(this.rain[i], rho0, rho0) + this.snow[i] * snowFallSpeed(this.snow[i], rho0, rho0) + this.graupel[i] * graupelFallSpeed(this.graupel[i], rho0) + this.hail[i] * hailFallSpeed(this.hail[i], rho0)) * 3600); rainTotal = Math.max(rainTotal, this.precipitation[i]) }
    // Largest hailstones reaching the ground now (falling through the ground node), mm.
    let hail = 0
    for (let i = 0; i < this.grid.layer; i++) hail = Math.max(hail, hailMaxDiameter(this.hail[i], rho0) * 1000)
    return { updraft: up, downdraft: down, rainRate, rainTotal, cloudTop: top, thermalTop, maxCloud, coldMax, cores: this.countCores(), shear06: Math.hypot(u6 - u0, v6 - v0), gust, hail, clipped: this.clipped }
  }
}
