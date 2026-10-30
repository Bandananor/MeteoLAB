import type { SimConfig } from './config'
import { CP, DT, G, LV, OMEGA } from './constants'
import { Environment, type EnvironmentProfile } from './environment'
import { createGrid, domainGrid, type Grid, shiftedLevel } from './grid'
import { domainMotion } from './kinematics'
import { clamp, lerp, mod, mulberry32 } from './math'
import { groundRepeats } from './station'
import { FluxTransport, RK3 } from './advection'
import { environmentProfile } from './profiles'
import { SMAGORINSKY, Turbulence } from './turbulence'
import { chargingRate, inductiveRate, transferCharge } from './charge'
import { type Flash, flashLimit, Lightning } from './lightning'
import { ZONE_DEPTH, ZONE_TIME, zoneMaps, zoneShape } from './zones'
import { advected } from './largescale'
import { coldMoisture, FRONT_BLUR, FRONTAL_TIME, frontalDeficit, frontDistance, WARM_BAND } from './fronts'
import { graupelFallSpeed, graupelProcesses, N0G, N0R, RHO_G, RHO_W } from './graupel'
import { hailFallSpeed, hailMaxDiameter, hailProcesses, N0H, RHO_H, wetGrowing } from './hail'
import { CRYSTAL_MASS, fragmentsPerKg, freezeRain, iceProcesses, saturationAdjustMixed, settleCrystals, snowFallSpeed, snowProcesses, SPLINTERS, splintering } from './ice'
import { fallSpeed, interceptOf, N0_MP, type RainIntercept, rainProcesses, saturationAdjust } from './microphysics'
import { PressureSolver } from './pressure'
import { dragCoefficient, LONGWAVE_LOSS, surfaceFluxes } from './surface'
import { insolation, sunDirection } from './solar'
import { computeSounding, type Sounding } from './sounding'
import { deficitNear, outflowDeficit } from './rkw'
import { type Memory, type Phase, PRIVATE_MEMORY, type StepRunner, type TaskModel } from './threads'
import { intervene } from './intervene'

/** One field a step transports: WENO (monotone) or linear upwind, with the positivity fix or not, and a decay factor per second. */
interface Carried { field: Float32Array; monotone: boolean; conserve: boolean; decay: number }
/** At most this many fields are transported (rain, snow, graupel, hail, u, v, w, theta, vapour, cloud, ice, cold pool, 4 charges). */
const MAX_CARRIED = 17
/**
 * The heat budget's terms (SimConfig.budget, roadmap D2), each theta's change by: rain evaporating; the saturation
 * adjustment (cloud water and, below -38 °C, ice condensing or evaporating); the crystals (deposition, sublimation, rain
 * freezing into graupel); snow, graupel and hail (riming, melting, sublimation, freezing of what they collect); the
 * ground's sensible heat; the rest of the node's physics (sponge, fronts, zones, relaxed edges, large-scale advection).
 */
export const BUDGET_TERMS = ['evaporation', 'condensation', 'ice', 'snow', 'graupel', 'hail', 'surface', 'other'] as const
export type BudgetTerm = typeof BUDGET_TERMS[number]
/** Flashes the model keeps (the latest). */
const RECENT_FLASHES = 2000
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
/** Width of the relaxed side-boundary zone (m) and the relaxation time at the domain edge (s); see SimConfig.edges. */
export const EDGE_ZONE = 12_000, EDGE_TIME = 300
/** The maintained front (SimConfig.front): depth (m), half-width of the transitions (m), relaxation time on the cold side (s), eastern end (share of the width). */
export const FRONT_DEPTH = 1500, FRONT_WIDTH = 1500, FRONT_TIME = 1800, FRONT_END = .6
/** Condensate below this mixing ratio (kg/kg, 1e-7 g/kg) is set to zero by the WENO positivity fix, conservatively. */
const TINY_WATER = 1e-10
/**
 * The updraught nudging (SimConfig.start 'nudge', AtmosphereModel.nudgeUpdraught): target w (m/s), the ellipsoid's
 * horizontal and vertical radii and its centre's height (m), the relaxation rate (1/s), full strength until t1 and none
 * after t2 (s of model time): CM1's defaults (iinit = 12, init3d.F *_wnudge, the forcing in misclibs.F get_wnudge, read
 * 24.10.2026) for Naylor & Gilmore (2012).
 */
/** Where in the step RK3 evaluates each stage's tendency, in steps (the nudging's ramp). */
const STAGE_TIME = [0, 1 / 3, 1 / 2]
/**
 * Visible mass extinction of the condensate along the sun's ray, m2/kg (roadmap B10): cloud water 150 (3 / (2 rho_w r_e),
 * r_e 10 um; Chou-Suarez and Slingo give 158-159), ice 80 (r_e ~30 um, Chou-Suarez / Ebert & Curry), snow 10 (Fu's
 * 6-16 for r_e 250-100 um), rain 3 (Chou 1999), graupel and hail 4 (geometric optics, 400 kg/m3, r_e 1 mm).
 */
export const EXTINCTION = { cloud: 150, ice: 80, snow: 10, rain: 3, graupel: 4 }
/** Asymmetry factor of the cloud's scattering (delta-Eddington scales it, see sunlightThrough). */
export const ASYMMETRY = .85

/**
 * The share of the sunlight (direct and diffuse) a non-absorbing cloud lets through: the delta-Eddington two-stream
 * solution for single-scattering albedo 1 (Joseph, Wiscombe & Weinman 1976; Meador & Weaver 1980, eq. 24), vertical
 * optical depth tau, the sun's zenith cosine mu. An anvil of tau 10 lets ~60 % through with the sun high, a
 * cumulonimbus core (tau 200-1000) 1-5 % — WRF's Dudhia (1989) tables give 5-8 % for 1-10 kg/m2 of water.
 */
export function sunlightThrough(tau: number, mu: number) {
  if (tau <= 0) return 1
  const f = ASYMMETRY * ASYMMETRY, g = ASYMMETRY / (1 + ASYMMETRY), t = (1 - f) * tau
  const g1 = .75 * (1 - g), g3 = (2 - 3 * g * mu) / 4
  return clamp(1 - (g1 * t + (g3 - g1 * mu) * (1 - Math.exp(-t / mu))) / (1 + g1 * t))
}
export const NUDGE = { w: 10, xr: 10_000, zr: 1500, zc: 1500, alpha: .5, t1: 900, t2: 1200 }

/**
 * How a run starts (SimConfig.start), absent filled in: the nudging in the mesoscale mode when no front starts the storms
 * — on 2 km the warm thermals start none (30.10.2026, tests/bench/gridscale.ts, 96 x 72 km: Summer day, Multicell, HSLC
 * and Cold front at most 8-10 m/s in 40 min, Summer day still 10 in 70; nudged 51, 53 and 26 m/s) —, else the thermals.
 */
export const startOf = (c: Pick<SimConfig, 'start' | 'domain' | 'front' | 'frontLine'>) => c.start ?? (c.domain === 'meso' && !c.front && !c.frontLine ? 'nudge' : 'thermals')

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
/**
 * The grid spacing (m) MESO_CORE_ZETA was set on. A resolved vortex's vorticity grows as the grid refines (~1/dx): at
 * 500 m the core's peak is 2.2x that at 1.2 km (classic supercell 29.6e-3 against 13.7e-3), and a multicell storm held
 * 3e-3 for 1014 s — a mesocyclone label it does not get at 1.2 km (25.10.2026, tests/bench/meso.ts). The threshold
 * scales with the grid: mesoCoreZeta(dx).
 */
export const MESO_GRID = 1200
/** The mesocyclone threshold of the core's vorticity (s-1) on a grid of spacing dx (m): never below MESO_CORE_ZETA. */
export const mesoCoreZeta = (dx: number) => MESO_CORE_ZETA * Math.max(1, MESO_GRID / dx)
/**
 * The UH thresholds' factor on a grid of spacing dx (m): MESO_GRID / dx, both ways, 1 on 1.2 km. UH is w times zeta and
 * both grow as the grid refines: against 1.2 km it is 2.3 times at 0.5 km (A2, tests/bench/converge.ts) and 0.28-0.51
 * at 2 km (30.10.2026, tests/bench/gridscale.ts: classic supercell 2296 / 878, WK 1061 / 539, HSLC 2351 / 669). The
 * core's vorticity falls far less at 2 km (0.22-0.84, the label agreeing on both grids), so mesoCoreZeta keeps its floor.
 */
export const uhScale = (dx: number) => MESO_GRID / dx
/** A UH threshold set on 1.2 km, on the grid a rotation state was measured on. */
export const uhThreshold = (threshold: number, r: Pick<RotationState, 'uhScale'>) => threshold * (r.uhScale ?? 1)

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
  /** Ground column (x + nx y) of the largest UH 0-1 km. */
  low: number
  /** The mesocyclone threshold of coreZeta on this grid (mesoCoreZeta). */
  mesoZeta: number
  /** What the UH thresholds (set on 1.2 km) are multiplied by on this grid (uhScale; absent = 1). */
  uhScale?: number
}

export interface ModelDiagnostics {
  /** Heaviest rain reaching the ground now, mm/h: rho0 q_r V_t at the surface. */ rainRate: number
  /** Largest rain total on the ground since the start, mm. */ rainTotal: number
  updraft: number; downdraft: number; cloudTop: number; thermalTop: number
  maxCloud: number; coldMax: number; cores: number; shear06: number
  /** The outflow's cold at the ground (rkw.ts outflowDeficit): the largest θv deficit, and the largest within OUTFLOW_NEAR of the low-level rotation, K. */
  outflow: number; outflowLow: number
  /**
   * Strongest wind over the ground at the ground node (its half layer, ~0-50 m, with the surface drag), m/s: outflow and
   * downburst gusts, the level the weather station reads too (was ~100 m, the station z = 0: a tester saw two winds).
   * A mean over a ~1 km cell: a real gust in it is ~1.3-1.5 times stronger.
   */ gust: number
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
  /** Cloud-ice crystals per kg of air (2.7.2, ice.ts iceProcesses): transported and mixed like the cloud ice. */
  readonly iceNumber: Float32Array
  /**
   * Charge carried by the hydrometeors (2.3, charge.ts), C per kg of air: on cloud ice with snow, on graupel with hail,
   * on rain, and on the cloud droplets with the small ions (chargeAir: moves with the air, does not fall). Transported
   * like the water, falling with the carrier's mass-weighted speed; zero without ice microphysics or with lightning
   * switched off (SimConfig.lightning).
   */
  readonly chargeIce: Float32Array; readonly chargeGraupel: Float32Array; readonly chargeRain: Float32Array; readonly chargeAir: Float32Array
  /** Mass-weighted fall speeds of the ice-snow and graupel-hail carriers, m/s. */
  private readonly chargeFallIce: Float32Array; private readonly chargeFallGraupel: Float32Array
  /**
   * Charge the air has lost since the start, C: carried to the ground by the falling precipitation (counted by the thread
   * that sediments: the main one) and by the CG flashes, conducted to the ground and the upper atmosphere, less what
   * the corona gave it.
   */
  chargeGround = 0
  /** Heat (J) and vapour (kg) put in by hand during the run (interventions, intervene.ts), and how many times. */
  added = { heat: 0, vapour: 0, count: 0 }
  /** The latest flashes (lightning.ts), oldest first, at most RECENT_FLASHES; and the counts since the start. */
  readonly flashes: Flash[] = []
  flashCount = { ic: 0, cg: 0 }
  private lightning?: Lightning
  /** Vertical electric field at the nodes after the last discharge, V/m, positive upwards (for the inductive charging). */
  private readonly fieldZ: Float32Array
  private readonly chargeNow = [0, 0, 0, 0]; private readonly massBefore = [0, 0, 0, 0]; private readonly massAfter = [0, 0, 0, 0]
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
  readonly rotation: RotationState = { uh: 0, x: 0, y: 0, anticyclonic: 0, persisted: 0, uh01: 0, uh03: 0, low: 0, coreZeta: 0, coreUH: 0, coreAnti: 0, mesoZeta: MESO_CORE_ZETA }
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
  /** Share of each ground column covered by the city (SimConfig.city), and that share under each column this step. */
  readonly cityGround: Float32Array; private readonly cityNow: Float32Array
  /** The zones of the environment on the ground columns (SimConfig.zones; null without), and under each column this step. */
  readonly zoneGround: ReturnType<typeof zoneMaps>
  private readonly zoneShareNow: Float32Array; private readonly zoneThetaNow: Float32Array; private readonly zoneVapourNow: Float32Array
  /** This step's surface pattern under each column (the ground moves under the domain) and where each column's rain lands. */
  /** The share of the sunlight reaching each ground column through the clouds this step (1: clear; roadmap B10). */
  readonly sunNow: Float32Array
  /**
   * The heat budget (SimConfig.budget, roadmap D2), K per term: what each process changed theta by along the air's way
   * here (carried and mixed as theta), so theta - theta0 = the sum of the terms + where the air came from (theta it
   * brought from its starting level, the transport's own error). null without the setting.
   */
  readonly budget: Record<BudgetTerm, Float32Array> | null
  private readonly opticalDepth: Float64Array
  private shaded = false
  private readonly patternNow: Float32Array; private readonly groundCell: Int32Array; private readonly groundWeight: Float64Array

  /** `profile` replaces the slider environment with an analytic one (idealised test cases). */
  constructor(config: SimConfig, grid: Grid = createGrid(domainGrid(config.domain, config.top, config.domainSize, config.spacing)), profile?: EnvironmentProfile, options: ModelOptions = {}) {
    this.config = config; this.grid = grid; this.memory = options.memory ?? PRIVATE_MEMORY
    this.rotation.mesoZeta = mesoCoreZeta(grid.dx); this.rotation.uhScale = uhScale(grid.dx)
    if (config.rainN0 !== undefined) this.rainIntercept = clamp(config.rainN0, 100, 20_000) * 1000
    const shared = (name: string, length = grid.n) => this.memory.f32(name, length)
    this.env = new Environment(config, grid, profile ?? environmentProfile(config, grid.height))
    this.frame = config.followStorm === false ? [0, 0] : config.frameMotion ?? domainMotion(this.env)
    this.uEnv = this.env.u.map(u => u - this.frame[0]); this.vEnv = this.env.v.map(v => v - this.frame[1])
    this.sunNow = shared('sunNow', grid.layer); this.opticalDepth = new Float64Array(grid.layer); if (!options.attach) this.sunNow.fill(1)
    this.patternNow = shared('patternNow', grid.layer); this.cityNow = shared('cityNow', grid.layer); this.zoneShareNow = shared('zoneShareNow', grid.layer); this.zoneThetaNow = shared('zoneThetaNow', grid.layer); this.zoneVapourNow = shared('zoneVapourNow', grid.layer); this.groundCell = new Int32Array(grid.layer * 4); this.groundWeight = new Float64Array(grid.layer * 4)
    const f = () => new Float32Array(grid.n)
    this.u = shared('u'); this.v = shared('v'); this.w = shared('w'); this.theta = shared('theta'); this.q = shared('q'); this.cloud = shared('cloud'); this.rain = shared('rain'); this.cold = shared('cold')
    this.ice = shared('ice'); this.iceNumber = shared('iceNumber'); this.snow = shared('snow'); this.snowFall = shared('snowFall'); this.graupel = shared('graupel'); this.graupelFall = shared('graupelFall'); this.hail = shared('hail'); this.hailFall = shared('hailFall')
    this.condensate = shared('condensate')
    this.fieldZ = shared('fieldZ')
    this.chargeIce = shared('chargeIce'); this.chargeGraupel = shared('chargeGraupel'); this.chargeRain = shared('chargeRain'); this.chargeAir = shared('chargeAir'); this.chargeFallIce = shared('chargeFallIce'); this.chargeFallGraupel = shared('chargeFallGraupel')
    this.budget = config.budget ? Object.fromEntries(BUDGET_TERMS.map(t => [t, shared(`budget-${t}`)])) as Record<BudgetTerm, Float32Array> : null
    const carriedMost = MAX_CARRIED + (this.budget ? BUDGET_TERMS.length : 0)
    this.stageStart = Array.from({ length: carriedMost }, (_, k) => shared(`start${k}`)); this.stageTend = Array.from({ length: carriedMost }, (_, k) => this.memory.f64(`tend${k}`, grid.n))
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
    this.rng = mulberry32(config.seed); this.cityGround = this.cityMap(); this.zoneGround = zoneMaps(grid, config.zones)
    if (!options.attach) this.initialize()
    this.sounding = computeSounding(config, this.env, grid.height)
  }

  private initialize() {
    const { nx, ny, nz, zs, width: W, depth: D } = this.grid
    let walk = 0
    // The single-storm mode keeps the air and the ground uniform (SimConfig.single).
    const noise = this.config.single ? 0 : 1
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { walk = walk * .82 + (this.rng() - .5) * .34; this.surfacePattern[x + nx * y] = walk * noise }
    // Zero mean: the pattern only redistributes the surface fluxes (a random offset once added ~1 % to H and LE).
    const mean = this.surfacePattern.reduce((a, b) => a + b, 0) / this.surfacePattern.length
    for (let i = 0; i < this.surfacePattern.length; i++) this.surfacePattern[i] -= mean
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      const alt = zs[z], [ue, ve] = this.env.windUV(alt)
      this.u[i] = ue - this.frame[0]; this.v[i] = ve - this.frame[1]; this.w[i] = 0
      this.theta[i] = this.env.thetaEnv(alt) + (this.rng() - .5) * .018 * noise; this.q[i] = this.env.qEnv(alt)
      this.cloud[i] = this.rain[i] = this.cold[i] = this.ice[i] = this.iceNumber[i] = this.snow[i] = this.graupel[i] = this.hail[i] = 0
      this.chargeIce[i] = this.chargeGraupel[i] = this.chargeRain[i] = this.chargeAir[i] = 0
    }
    // The moving front's cold air, from the start.
    if (this.config.frontLine) for (let z = 0; z < nz && zs[z] < this.config.frontLine.depth * 1000 + FRONT_BLUR; z++)
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = x + nx * (y + ny * z), d = this.frontalAt(x, y, zs[z])[0]; this.theta[i] -= d; this.q[i] *= coldMoisture(d) }
    // The zones' air near the ground, from the start (the domain is still over its starting ground).
    const zones = this.zoneGround
    if (zones) for (let z = 0; z < nz && zs[z] < ZONE_DEPTH; z++) {
      const shape = zoneShape(zs[z]), exner = this.env.exner[z]
      for (let c = 0; c < nx * ny; c++) { const i = c + z * nx * ny; this.theta[i] += zones.theta[c] * shape / exner; this.q[i] = Math.max(0, this.q[i] + zones.vapour[c] * shape) }
    }
    // The Weisman-Klemp case starts from a single thermal, as in the calibration test. An ensemble member's thermals are shifted (startOffset).
    const [sx, sy] = this.config.startOffset ?? [0, 0], bubble = (x: number, y: number, strength: number) => this.injectBubble(x + sx, y + sy, strength)
    if (startOf(this.config) === 'line') {
      // Thermals every 6 km along y (periodic: the line has no ends), strength x (0.85-1.15).
      for (let y = 3000; y < D; y += 6000) bubble(W * .5, y, this.config.bubble * (.85 + .3 * this.rng()))
    } else if (this.config.front) {
      for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) this.theta[i] -= this.frontDeficit(x, y, zs[z])
      // Weak thermals on the warm side, 3 km from the front, between the western zone and the front's end.
      for (let k = 0; k < 5; k++) bubble(W * (.18 + .09 * k), D / 2 - 3000, this.config.bubble)
    } else if (startOf(this.config) === 'nudge') {
      // No thermal: the nudging in physics() starts the storm.
    } else if (this.config.single) bubble(W * .5, D * .5, this.config.bubble)
    else if (this.config.profile === 'weisman-klemp') bubble(W * .3, D * .5, this.config.bubble)
    else { bubble(W * .38, D * .45, this.config.bubble); bubble(W * .61, D * .57, .72 * this.config.bubble) }
    // The starting thermals are the setup, not something added during the run.
    this.added = { heat: 0, vapour: 0, count: 0 }
  }

  /**
   * Warm thermal centred at (cx, cy) metres from the domain corner, near the ground: +3.2 K and 1.1 m/s times strength.
   * No added vapour since 2026-09-29 (as in Weisman-Klemp and other reference cases): +3 g/kg gave the bubble air a far
   * larger CAPE than the environment it is meant to probe.
   */
  injectBubble(cx: number, cy: number, strength: number) { intervene(this, { kind: 'thermal', x: cx, y: cy, strength }) }

  /**
   * Updraught nudging (SimConfig.start 'nudge'; Naylor & Gilmore 2012, as CM1 does it) on level z at model time t: within
   * an ellipsoid in the domain's middle the target is NUDGE.w (or SimConfig.nudge) times cos² of the normalised distance
   * from the centre, and where w is below it the tendency alpha gamma (target - w) acts, gamma 1 until NUDGE.t1, then
   * falling linearly to 0 at NUDGE.t2. With the pressure in the RK3 stages (staged()) it goes into each stage's w tendency
   * `out`, before the stage's projection, as CM1 adds it before its pressure on every acoustic step: an exponential
   * relaxation once a step was halved by the projection reopening the gap (the numerics review, 24.10.2026; alpha dt =
   * 1.5 is well inside RK3's stability). Without stages (out null) it acts on w itself, at most closing the gap.
   */
  private nudgeLevel(z: number, t: number, out: Float64Array | null, dt: number) {
    if (t >= NUDGE.t2) return
    const { nx, ny, dx, dy, zs, width: W, depth: D, layer } = this.grid, sz = (zs[z] - NUDGE.zc) / NUDGE.zr
    if (Math.abs(sz) >= 1) return
    const [ox, oy] = this.config.startOffset ?? [0, 0], cx = W / 2 + ox, cy = D / 2 + oy, w = this.w
    const rate = NUDGE.alpha * (t < NUDGE.t1 ? 1 : (NUDGE.t2 - t) / (NUDGE.t2 - NUDGE.t1)), top = this.config.nudge ?? NUDGE.w, part = Math.min(1, rate * dt)
    for (let y = 0; y < ny; y++) {
      let ddy = y * dy - cy
      if (ddy > D / 2) ddy -= D; if (ddy < -D / 2) ddy += D
      for (let x = 0; x < nx; x++) {
        let ddx = x * dx - cx
        if (ddx > W / 2) ddx -= W; if (ddx < -W / 2) ddx += W
        const d = Math.sqrt((ddx / NUDGE.xr) ** 2 + (ddy / NUDGE.xr) ** 2 + sz * sz)
        if (d >= 1) continue
        const i = x + nx * y + z * layer, gap = top * Math.cos(Math.PI / 2 * d) ** 2 - w[i]
        if (gap <= 0) continue
        if (out) out[i] += rate * gap; else w[i] += part * gap
      }
    }
  }

  /** How much colder the maintained front (SimConfig.front) keeps the air at node column (x, y) and height alt, K. */
  frontDeficit(x: number, y: number, alt: number) {
    const front = this.config.front ?? 0
    if (!front || alt >= FRONT_DEPTH) return 0
    const { dx, dy, width, depth } = this.grid
    return front * (1 - alt / FRONT_DEPTH) * .25 * (1 + Math.tanh((y * dy - depth / 2) / FRONT_WIDTH)) * (1 - Math.tanh((x * dx - FRONT_END * width) / FRONT_WIDTH))
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
  /** The charge fields with the fall speeds of their carriers. */
  private chargeFalls(): [Float32Array, Float32Array][] { return [[this.chargeIce, this.chargeFallIce], [this.chargeGraupel, this.chargeFallGraupel], [this.chargeRain, this.fallSpeed]] }

  /** `deposit`: the field is water that lands in the rain gauge (charge is not). */
  private sediment(rain: Float32Array, vt: Float32Array, dt: number, deposit = true) {
    const { nz, layer } = this.grid, rho = this.env.rho, lw = this.levelWeight, dz = this.grid.dz
    // The explicit upwind fall is stable while a node loses at most all of its water in one go: large hail (30-40 m/s)
    // through the 100 m levels at the ground needs sub-steps at dt = 3 s (fall speeds kept from the start of the step).
    let courant = 0
    for (let z = 0; z < nz; z++) { const c = dt * rho[z] / (lw[z] * dz); for (let i = z * layer; i < (z + 1) * layer; i++) if (rain[i] !== 0) courant = Math.max(courant, c * vt[i]) }
    const parts = Math.max(1, Math.ceil(courant / .8))
    for (let p = 0; p < parts; p++) this.sedimentPart(rain, vt, dt / parts, deposit)
  }

  private sedimentPart(rain: Float32Array, vt: Float32Array, dt: number, deposit: boolean) {
    const { nz, layer } = this.grid, rho = this.env.rho, lw = this.levelWeight, dz = this.grid.dz
    if (deposit) for (let i = 0; i < layer; i++) this.deposit(i, rho[0] * rain[i] * vt[i] * dt)
    else { let out = 0; for (let i = 0; i < layer; i++) out += rain[i] * vt[i]; this.chargeGround += rho[0] * out * dt * this.grid.dx * this.grid.dy }
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

  /** The city's share of each ground column: 1 inside its radius, 0 outside, a 1 km linear transition (periodic distances). */
  private cityMap() {
    const { nx, ny, dx, dy } = this.grid, map = new Float32Array(nx * ny)
    if ((this.config.city ?? 0) > 0) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) map[x + nx * y] = this.cityShare((x + .5) * dx, (y + .5) * dy)
    return map
  }

  /**
   * The city's share at a ground point (m from the ground origin): the distance from the ground's centre is periodic
   * along the axes where the ground repeats (groundRepeats), so across relaxed edges the city stays where it was built.
   */
  private cityShare(gx: number, gy: number) {
    const { width: W, depth: D } = this.grid, [rx, ry] = groundRepeats(this), r = (this.config.city ?? 0) * 1000
    const ex = rx ? Math.abs(mod(gx, W) - W / 2) : Math.abs(gx - W / 2), ey = ry ? Math.abs(mod(gy, D) - D / 2) : Math.abs(gy - D / 2)
    return Math.max(0, Math.min(1, .5 - (Math.hypot(rx ? Math.min(ex, W - ex) : ex, ry ? Math.min(ey, D - ey) : ey) - r) / 1000))
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
    const city = (this.config.city ?? 0) > 0 ? this.cityGround : null, zones = this.zoneGround, [rx, ry] = groundRepeats(this)
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = x + nx * y, ax = (x + x0) % nx, bx = (ax + 1) % nx, ay = (y + y0) % ny * nx, by = (ay / nx + 1) % ny * nx, k = i * 4
      c[k] = ax + ay; c[k + 1] = bx + ay; c[k + 2] = ax + by; c[k + 3] = bx + by
      w[k] = (1 - fx) * (1 - fy); w[k + 1] = fx * (1 - fy); w[k + 2] = (1 - fx) * fy; w[k + 3] = fx * fy
      this.patternNow[i] = w[k] * pattern[c[k]] + w[k + 1] * pattern[c[k + 1]] + w[k + 2] * pattern[c[k + 2]] + w[k + 3] * pattern[c[k + 3]]
      if (city) this.cityNow[i] = rx && ry ? w[k] * city[c[k]] + w[k + 1] * city[c[k + 1]] + w[k + 2] * city[c[k + 2]] + w[k + 3] * city[c[k + 3]] : this.cityShare((x + .5) * dx + ox, (y + .5) * dy + oy)
      if (zones) for (const [now, map] of [[this.zoneShareNow, zones.share], [this.zoneThetaNow, zones.theta], [this.zoneVapourNow, zones.vapour]] as const)
        now[i] = w[k] * map[c[k]] + w[k + 1] * map[c[k + 1]] + w[k + 2] * map[c[k + 2]] + w[k + 3] * map[c[k + 3]]
    }
  }

  /**
   * Cloud shadows (roadmap B10, SimConfig.shade): for each ground column the condensate along the ray towards the sun —
   * the node the ray crosses at each level — gives the optical depth of that tilted column (EXTINCTION) and the share of
   * the sunlight let through (sunlightThrough): a tilted independent column, so the shadow falls where the sun puts it —
   * west of a storm in the morning, east in the evening, longer the lower the sun (a vertical column would put it right
   * under the cloud, off by up to ~500 W/m2 at its edge with a low sun). Nearest nodes: the edge is a grid length sharp.
   * Periodic edges wrap the ray as they wrap the storms; relaxed edges do not (beyond them is cloudless environment).
   */
  private updateShade() {
    const cfg = this.config, sun = sunDirection(cfg, this.time)
    if (cfg.shade === false || sun.y < .02 || insolation(cfg, this.time) <= 0) { if (this.shaded) { this.sunNow.fill(1); this.shaded = false } return }
    const { nx, ny, nz, dx, dy, zs, hz, layer } = this.grid, rho = this.env.rho, tau = this.opticalDepth.fill(0)
    const cloud = this.cloud, ice = this.ice, snow = this.snow, rain = this.rain, graupel = this.graupel, hail = this.hail, e = EXTINCTION
    // Cells the ray moves per metre of height: east by x / y, north by -z / y (sunDirection's z points south).
    const east = sun.x / sun.y / dx, north = -sun.z / sun.y / dy, edges = this.edges(), openX = edges !== 'periodic', openY = edges === 'relaxed'
    for (let z = 0; z < nz; z++) {
      const sx = Math.round(east * zs[z]), sy = Math.round(north * zs[z]), path = rho[z] * hz[z], base = z * layer
      for (let y = 0; y < ny; y++) {
        if (openY && (y + sy < 0 || y + sy >= ny)) continue
        const row = mod(y + sy, ny) * nx + base
        for (let x = 0; x < nx; x++) {
          if (openX && (x + sx < 0 || x + sx >= nx)) continue
          const i = row + mod(x + sx, nx), m = e.cloud * cloud[i] + e.ice * ice[i] + e.snow * snow[i] + e.rain * rain[i] + e.graupel * (graupel[i] + hail[i])
          if (m > 0) tau[x + nx * y] += m * path
        }
      }
    }
    for (let c = 0; c < layer; c++) this.sunNow[c] = sunlightThrough(tau[c], sun.y)
    this.shaded = true
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
  /**
   * Subgrid filter width of the horizontal mixing: sqrt(dx dy) (default since 2026-10-09; see Turbulence.anisotropic), or
   * (dx dy dz)^(1/3) as before. With sqrt(dx dy) weak-shear updraughts are 4-10 m/s weaker and rotate less; the WK
   * supercell keeps its split and mesocyclone (w 54 -> 51 m/s).
   */
  turbulenceWidth: 'cube' | 'anisotropic' = 'anisotropic'
  /**
   * Reference cases (Straka et al. 1993, Bryan & Fritsch 2002): a constant eddy viscosity, m2/s, the same for momentum
   * and scalars, instead of Smagorinsky; null = Smagorinsky.
   */
  fixedViscosity: number | null = null
  /** Drag on the ground node; off in the free-slip reference cases. */
  surfaceDrag = true
  /**
   * Buoyancy and pressure in every RK3 stage of the WENO transport (since 22.10.2026, roadmap A4), as CM1 and WRF do:
   * each stage's w tendency carries the buoyancy and each stage's velocity is made divergence-free. Once a step after
   * the transport, as before, the step's splitting gave a first-order error in dt: the Straka density current's u max
   * 30.9 / 32.7 / 33.7 m/s at dt 1 / 0.5 / 0.25 s on 200 m, now 34.6-34.7 at any of them (tests/bench/straka.ts); the
   * storms' strongest updraughts 2-5 % lower, at about the same cost (two more pressure solves a step).
   * STORMLAB_STAGES=0 turns it off, for comparisons.
   */
  pressureInStages = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env?.STORMLAB_STAGES !== '0'
  /**
   * Relaxation of the wind departure from the environmental wind, s-1: 1e-4 (was a factor .9999 per step, which tied
   * the damping to the step length); 0 in the reference cases.
   */
  windRelaxation = 1e-4
  /** Warm rain (Kessler); off for the reversible moist reference case: cloud water only condenses and evaporates. */
  rainFormation = true
  /**
   * The rain's size distribution intercept (roadmap D2, B1): 'fixed' — Marshall-Palmer's (the scheme's own); 'diagnosed' —
   * from the rain water content (rainIntercept, Zhang et al. 2008); a number — that, m^-4 (Dawson et al. 2010 ran 4e5);
   * in the rain's evaporation, accretion and fall speed (the radar, the freezing and the splinters keep Marshall-Palmer's).
   * A switch for experiments.
   */
  rainIntercept: RainIntercept = 'fixed'
  // Created with the model, so that their shared arrays exist before any helper thread attaches.
  private readonly flux: FluxTransport; private readonly turbulence: Turbulence
  private readonly memory: Memory
  /** Mass the positivity fix moved in each transport task of this step (summed in task order into negativeFilled). */
  private readonly taskNegative: Float64Array
  private edgeX?: Float64Array; private edgeY?: Float64Array
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
    this.updateGround(); this.updateShade()
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
      if (this.electrified()) for (const [field, vt] of this.chargeFalls()) this.sediment(field, vt, dt, false)
      const carried = this.carried(), tasks = carried.length * this.slabs()
      for (const stage of [0, 1, 2] as const) {
        this.runner.run(`tendency${stage}`, tasks, dt); this.runner.run(`update${stage}`, tasks, dt)
        // The pressure acts within the stages: each stage's velocity made divergence-free (the last by project() below).
        if (this.pressureInStages && stage < 2) { const top = (nz - 1) * layer; for (let b = 0; b < layer; b++) { this.w[b] = 0; this.w[b + top] = 0 } this.project(dt, false) }
      }
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
      carry(this.u, 1); carry(this.v, 1); carry(this.w, 1); carry(this.theta, 1); carry(this.q, 1, true); carry(this.cloud, 1, true); if (withIce) { carry(this.ice, 1, true); carry(this.iceNumber, 1) } carry(this.cold, .9992 ** dt)
      if (this.budget) for (const t of BUDGET_TERMS) carry(this.budget[t], 1)
      // Charges fall with their carriers and move with the air (not mass-fixed: the fast transport does not conserve them exactly).
      if (this.electrified()) { for (const [field, vt] of this.chargeFalls()) { this.advectFalling(field, dt, vt); this.commit(field, 1) } carry(this.chargeAir, 1) }
    }
    // Microphysics, buoyancy, Coriolis, surface fluxes and the sponge: node by node, one task per level.
    this.runner.run('physics', nz, dt)
    const cfg = this.config, e = this.env, u = this.u, v = this.v, w = this.w
    // Smagorinsky-Lilly subgrid mixing of momentum, heat and water (replaces the old horizontal smoothing of theta and q).
    const turb = this.turbulence
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
    if (this.electrified()) this.discharge(dt)
  }

  /** Whether this step's buoyancy goes into the transport's stages (pressureInStages, WENO only) instead of physics(). */
  private staged() { return this.pressureInStages && (this.config.transport ?? this.transport) === 'weno' }

  /**
   * Adds g B of the fields as they are now to the w tendency on levels z0-z1 (pressureInStages): the same buoyancy as
   * physics() gives, against the environment or, inside a zone, the zone's own air.
   */
  private stageBuoyancy(tend: Float64Array, z0: number, z1: number) {
    const { layer, zs } = this.grid, zones = this.zoneGround !== null
    for (let z = z0; z < z1; z++) {
      const [thEnv, qEnv] = this.envNow(z), thvEnv = thEnv * (1 + .61 * qEnv), alt = zs[z], inZone = zones && alt < ZONE_DEPTH, shape = inZone ? zoneShape(alt) : 0, exner = this.env.exner[z]
      for (let i = z * layer, c = 0; c < layer; i++, c++) {
        const ref = inZone ? (thEnv + this.zoneThetaNow[c] * shape / exner) * (1 + .61 * (qEnv + this.zoneVapourNow[c] * shape)) : thvEnv
        const loaded = this.cloud[i] + this.ice[i] + this.rain[i] + this.snow[i] + this.graupel[i] + this.hail[i]
        tend[i] += G * ((this.theta[i] * (1 + .61 * this.q[i]) - ref) / ref - loaded)
      }
    }
  }

  /** Does task k of a parallel phase (see threads.ts): transport field k, physics of level k, or mixing of field k. */
  runTask(phase: Phase, k: number, dt: number) {
    const { nz, layer } = this.grid
    switch (phase) {
      case 'fall': {
        const rho = this.env.rho, intercept = this.rainIntercept
        for (let i = k * layer, end = i + layer; i < end; i++) { this.fallSpeed[i] = fallSpeed(this.rain[i], rho[k], rho[0], intercept === 'fixed' || !(this.rain[i] > 0) ? N0_MP : interceptOf(intercept, this.rain[i], rho[k])); this.snowFall[i] = snowFallSpeed(this.snow[i], rho[k], rho[0]); this.graupelFall[i] = graupelFallSpeed(this.graupel[i], rho[k]); this.hailFall[i] = hailFallSpeed(this.hail[i], rho[k]) }
        if (this.electrified()) for (let i = k * layer, end = i + layer; i < end; i++) {
          const is = this.ice[i] + this.snow[i], gh = this.graupel[i] + this.hail[i]
          this.chargeFallIce[i] = is > 0 ? this.snow[i] * this.snowFall[i] / is : 0
          this.chargeFallGraupel[i] = gh > 0 ? (this.graupel[i] * this.graupelFall[i] + this.hail[i] * this.hailFall[i]) / gh : 0
        }
        break
      }
      case 'tendency0': case 'tendency1': case 'tendency2': case 'update0': case 'update1': case 'update2': {
        // Task k: field k / slabs, levels of slab k % slabs. The first tendency also saves the field's starting value.
        const slabs = this.slabs(), f = Math.floor(k / slabs), j = k % slabs, c = this.carried()[f]
        const z0 = Math.floor(j * nz / slabs), z1 = Math.floor((j + 1) * nz / slabs), a = c.field, start = this.stageStart[f], tend = this.stageTend[f]
        if (phase === 'tendency0') start.set(a.subarray(z0 * layer, z1 * layer), z0 * layer)
        if (phase.startsWith('tendency')) {
          this.flux.tendency(a, tend, z0, z1, c.monotone)
          if (a === this.w && this.staged()) {
            this.stageBuoyancy(tend, z0, z1)
            // The stage's time: RK3 evaluates its tendencies at t, t + dt/3, t + dt/2.
            if (startOf(this.config) === 'nudge') for (let z = z0; z < z1; z++) this.nudgeLevel(z, this.time + STAGE_TIME[Number(phase[8])] * dt, tend, dt)
          }
        }
        else { const fraction = RK3[Number(phase[6])] * dt; for (let i = z0 * layer; i < z1 * layer; i++) a[i] = start[i] + fraction * tend[i] }
        break
      }
      case 'finish': {
        const c = this.carried()[k], a = c.field
        this.taskNegative[k] = c.conserve ? this.fillNegative(a) : 0
        if (c.decay !== 1) { const keep = c.decay ** dt; for (let i = 0; i < a.length; i++) a[i] *= keep }
        break
      }
      case 'physics': this.physics(k, dt); if (startOf(this.config) === 'nudge' && !this.staged()) this.nudgeLevel(k, this.time + dt / 2, null, dt); break
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
        // Set here, in the task, not before the phase: a helper thread runs this task on its own Turbulence (until
        // 30.10.2026 the helpers' levels kept the cube-root width while the main thread's had the anisotropic one).
        this.turbulence.anisotropic = this.turbulenceWidth === 'anisotropic'
        this.turbulence.viscosity(this.u, this.v, this.w, this.theta, e.theta, SMAGORINSKY * this.config.turbulence / .55, dt, moist, k, k + 1)
        break
      }
      case 'mix': { const [a, base, factor] = this.mixed()[k]; this.turbulence.mix(a, base, factor, dt) }
    }
  }

  private slabs() { return Math.max(1, Math.min(this.transportSlabs, this.grid.nz)) }

  private withIce() { return (this.config.microphysics ?? this.microphysics) === 'ice' }

  /**
   * The environment's potential temperature (K) and vapour (kg/kg) at level z at time s (default: now): the base state
   * plus the large-scale advection that has come by then (SimConfig.largeScale).
   */
  envNow(z: number, s = this.time): [number, number] {
    const e = this.env, changes = this.config.largeScale
    if (!changes?.length) return [e.theta[z], e.q[z]]
    const [dt, dq] = advected(changes, this.grid.zs[z], s)
    return [e.theta[z] + dt / e.exner[z], Math.max(0, e.q[z] + dq)]
  }

  /** The side boundaries (SimConfig.edges): relaxed when a moving front is set and they are not. */
  edges() { return this.config.edges ?? (this.config.frontLine ? 'relaxed' : 'periodic') }

  /**
   * How much colder the moving front (SimConfig.frontLine) keeps the air at node column (x, y) and height alt now, K,
   * and whether the column lies in the band behind a warm front (where the air is pulled back to the warm air).
   */
  private frontalAt(x: number, y: number, alt: number): [number, boolean] {
    const f = this.config.frontLine
    if (!f) return [0, false]
    const { dx, dy, width, depth } = this.grid, [fx, fy] = this.frame
    const s = frontDistance(f, x * dx + fx * this.time, y * dy + fy * this.time, this.time, width, depth)
    return [frontalDeficit(f, s, alt), f.kind === 'warm' && s <= 0 && s > -WARM_BAND]
  }

  /** Electrification runs with the ice microphysics (it needs graupel and crystals) unless lightning is switched off. */
  electrified() { return this.withIce() && this.config.lightning !== false }

  /** The fields a step transports, in order: falling precipitation, wind and theta (linear upwind), vapour and cloud, the cold-pool indicator. */
  private carried(): Carried[] {
    const withIce = this.withIce(), c: Carried[] = [], water = (field: Float32Array) => c.push({ field, monotone: true, conserve: true, decay: 1 })
    water(this.rain); if (withIce) { water(this.snow); water(this.graupel); water(this.hail) }
    // WENO for water and the cold-pool indicator (no overshoots); linear 5th-order upwind for the smooth u, v, w, theta.
    for (const field of [this.u, this.v, this.w, this.theta]) c.push({ field, monotone: false, conserve: false, decay: 1 })
    water(this.q); water(this.cloud); if (withIce) { water(this.ice); c.push({ field: this.iceNumber, monotone: true, conserve: false, decay: 1 }) }
    c.push({ field: this.cold, monotone: true, conserve: false, decay: .9992 })
    // Charges: WENO (no overshoots; signed, so no positivity fix, and no cut of the tails: the charge is kept exactly).
    // The four fields cost ~30 % of a step in a mature storm (single-threaded, 20-30 min of the classic supercell).
    if (this.electrified()) for (const field of [this.chargeIce, this.chargeGraupel, this.chargeRain, this.chargeAir]) c.push({ field, monotone: true, conserve: false, decay: 1 })
    // The heat budget's terms with theta's own scheme, so their sum stays theta's departure.
    if (this.budget) for (const t of BUDGET_TERMS) c.push({ field: this.budget[t], monotone: false, conserve: false, decay: 1 })
    return c
  }

  /** The fields the subgrid turbulence mixes, with the base state it mixes the departure from and the K factor (1/Pr for scalars). */
  private mixed(): [Float32Array, ArrayLike<number> | null, number][] {
    const scalars = this.fixedViscosity === null ? 3 : 1, e = this.env
    const list: [Float32Array, ArrayLike<number> | null, number][] = [[this.u, this.uEnv, 1], [this.v, this.vEnv, 1], [this.w, null, 1], [this.theta, e.theta, scalars], [this.q, e.q, scalars], [this.cloud, null, scalars]]
    if (this.withIce()) list.push([this.ice, null, scalars], [this.iceNumber, null, scalars])
    if (this.budget) for (const t of BUDGET_TERMS) list.push([this.budget[t], null, scalars])
    return list
  }

  /** Microphysics, buoyancy, Coriolis, surface fluxes and the sponge at every node of level z (nodes are independent). */
  private physics(z: number, dt: number) {
    const { nx, ny, zs, height: H, layer } = this.grid, withIce = this.withIce(), staged = this.staged()
    const cfg = this.config, e = this.env, u = this.u, v = this.v, w = this.w, theta = this.theta, q = this.q, cloud = this.cloud, rain = this.rain, cold = this.cold
    const ice = this.ice, iceNumber = this.iceNumber, snow = this.snow, graupel = this.graupel, hail = this.hail, rhoGround = e.rho[0]
    const intercept = this.rainIntercept
    const budget = this.budget, bEvap = budget?.evaporation, bCond = budget?.condensation, bIce = budget?.ice, bSnow = budget?.snow, bGraupel = budget?.graupel, bHail = budget?.hail, bSurface = budget?.surface, bOther = budget?.other
    // A pull towards a profile (sponge, fronts, zones, relaxed edges) takes the terms' share with theta's departure: the
    // pulled-in air comes from the environment (the origin), not from the node's processes.
    const pull = (i: number, keep: number) => { for (const t of BUDGET_TERMS) budget![t][i] *= keep }
    const electric = withIce && this.electrified(), cI = this.chargeIce, cG = this.chargeGraupel, cR = this.chargeRain, cA = this.chargeAir, cNow = this.chargeNow, before = this.massBefore, after = this.massAfter
    const flux = surfaceFluxes(cfg, this.time), urban = (cfg.city ?? 0) > 0 ? surfaceFluxes(cfg, this.time, 'urban') : flux, f = 2 * OMEGA * Math.sin(cfg.latitude * Math.PI / 180)
    // Under a cloud the balance is the same with the sunlight times sunNow: the available energy max(0, A T - LW) of the
    // clear sky's A - LW (the shares of H and LE stay), so a column scales its clear-sky fluxes by it (roadmap B10).
    const shaded = this.shaded, scale = (absorbed: number, t: number) => absorbed > LONGWAVE_LOSS ? Math.max(0, absorbed * t - LONGWAVE_LOSS) / (absorbed - LONGWAVE_LOSS) : 0
    const spongeStart = Math.max(cfg.tropopause * 1000 + 2500, 14_000), keep = Math.exp(-this.windRelaxation * dt)
    // Distance of each column from the nearest domain edge (the seam between the last and the first node), m.
    const edges = this.edges(), relaxed = edges === 'relaxed' || edges === 'relaxed-x', onlyX = edges === 'relaxed-x', front = cfg.front ?? 0, zones = this.zoneGround !== null, frontTop = cfg.frontLine ? cfg.frontLine.depth * 1000 + FRONT_BLUR : -1, frontPull = 1 - Math.exp(-dt / FRONTAL_TIME), { dx, dy } = this.grid
    const edgeX = this.edgeX ??= Float64Array.from({ length: nx }, (_, x) => Math.min(x + .5, nx - .5 - x) * dx)
    const edgeY = this.edgeY ??= Float64Array.from({ length: ny }, (_, y) => Math.min(y + .5, ny - .5 - y) * dy)
    {
      let i = z * layer
      const alt = zs[z], p = e.p[z], rhoZ = e.rho[z], exner = e.exner[z], ue = this.uEnv[z], ve = this.vEnv[z]
      // Large-scale advection (SimConfig.largeScale): the environment now, and this step's change added to every node.
      const [thEnv, qEnv] = this.envNow(z), [thNext, qNext] = this.envNow(z, this.time + dt), thvEnv = thEnv * (1 + .61 * qEnv)
      const addTheta = thNext - thEnv, addQ = qNext - qEnv, advecting = addTheta !== 0 || addQ !== 0
      for (let y = 0; y < ny; y++) {
        const row = y * nx
        for (let x = 0; x < nx; x++, i++) {
          // The heat budget: theta at the start, and theta just before each process (its change goes to its term).
          const start = theta[i]
          let mark = 0, given = 0, pulled = 0
          if (advecting) { theta[i] += addTheta; q[i] = Math.max(0, q[i] + addQ) }
          if (electric) { before[0] = ice[i] + snow[i]; before[1] = graupel[i] + hail[i]; before[2] = rain[i]; before[3] = cloud[i] }
          // Kessler warm rain, then saturation adjustment (vapour and cloud water in equilibrium after every step).
          // Evaporation of rain and cloud feeds the cold-pool indicator.
          const evap = this.rainFormation ? rainProcesses(q, cloud, rain, i, theta[i] * exner, p, rhoZ, dt, intercept) : 0
          // Evaporation takes exactly L/cp per unit mass from the air (no strength multiplier): energy is conserved.
          if (evap > 0) { const cool = LV / CP / exner * evap; mark = theta[i]; theta[i] -= cool; cold[i] += cool; if (budget) { bEvap![i] += theta[i] - mark; given += theta[i] - mark } }
          // Ice: rain freezes (Bigg into graupel, below -38 °C at once), crystals nucleate and grow by deposition (at the
          // droplets' expense in a cloud) or sublimate, snow aggregates, rimes, grows by deposition, sublimates and
          // melts, graupel rimes, collects and melts; melting and sublimation feed the cold-pool indicator like evaporation.
          let cond: number
          if (withIce) {
            mark = theta[i]
            freezeRain(theta, rain, graupel, i, exner)
            // The crystals first match the ice the transport (or a loaded state without them) left.
            settleCrystals(ice, iceNumber, i)
            cold[i] += iceProcesses(theta, q, ice, snow, iceNumber, i, exner, p, rhoZ, dt)
            if (budget) { bIce![i] += theta[i] - mark; given += theta[i] - mark; mark = theta[i] }
            const iceBefore = ice[i], cloudBefore = cloud[i]
            cold[i] += snowProcesses(theta, q, cloud, ice, snow, rain, i, exner, p, rhoZ, rhoGround, dt)
            if (budget) { bSnow![i] += theta[i] - mark; given += theta[i] - mark; mark = theta[i] }
            const rainBefore = rain[i]
            cold[i] += graupelProcesses(theta, q, cloud, ice, snow, rain, graupel, i, exner, p, rhoZ, dt)
            if (budget) { bGraupel![i] += theta[i] - mark; given += theta[i] - mark; mark = theta[i] }
            const rainFrozen = theta[i] * exner < 273.15 ? Math.max(0, rainBefore - rain[i]) : 0
            cold[i] += hailProcesses(theta, q, cloud, ice, snow, rain, graupel, hail, i, exner, p, rhoZ, dt)
            if (budget) { bHail![i] += theta[i] - mark; given += theta[i] - mark }
            // Crystals aggregated or collected by snow, graupel and hail go with their mass.
            if (iceBefore > 0) iceNumber[i] *= ice[i] / iceBefore
            // Secondary ice: rime splintering at -3…-8 °C (the droplets the snow, graupel and hail froze on throw off
            // crystals) and the raindrops shattering as they freeze into graupel (on their own or on graupel).
            const splinters = splintering(theta[i] * exner - 273.15) * SPLINTERS * Math.max(0, cloudBefore - cloud[i])
              + (rainFrozen > 0 ? fragmentsPerKg((Math.PI * RHO_W * N0R / (rhoZ * rainBefore)) ** .25) * rainFrozen : 0)
            if (splinters > 0) {
              // The splinters' mass from the rimers (graupel, then snow): a tiny share of the frozen water (350 per mg weigh 0.035 %).
              const fromG = Math.min(graupel[i], splinters * CRYSTAL_MASS), fromS = Math.min(snow[i], splinters * CRYSTAL_MASS - fromG)
              graupel[i] -= fromG; snow[i] -= fromS; ice[i] += fromG + fromS; iceNumber[i] += (fromG + fromS) / CRYSTAL_MASS
            }
            // Saturation adjustment: water saturation down to -38 °C (supercooled droplets), ice saturation below.
            mark = theta[i]
            cond = saturationAdjustMixed(theta, q, cloud, ice, i, exner, p, iceNumber)
            if (budget) { bCond![i] += theta[i] - mark; given += theta[i] - mark }
            settleCrystals(ice, iceNumber, i)
            if (electric) {
              // The charge follows the water the microphysics moved between the carriers, then the rebounding
              // graupel-crystal collisions separate new charge (graupel-hail gains it, ice-snow the opposite).
              after[0] = ice[i] + snow[i]; after[1] = graupel[i] + hail[i]; after[2] = rain[i]; after[3] = cloud[i]
              cNow[0] = cI[i]; cNow[1] = cG[i]; cNow[2] = cR[i]; cNow[3] = cA[i]
              if (cNow[0] !== 0 || cNow[1] !== 0 || cNow[2] !== 0 || cNow[3] !== 0) transferCharge(cNow, before, after)
              const tc = theta[i] * exner - 273.15
              const wetG = wetGrowing(graupel[i], N0G, RHO_G, tc, q[i], p, rhoZ, cloud[i], rain[i], ice[i], snow[i]), wetH = wetGrowing(hail[i], N0H, RHO_H, tc, q[i], p, rhoZ, cloud[i], rain[i], ice[i], snow[i])
              const separated = chargingRate(tc, rhoZ, cloud[i], ice[i], snow[i], graupel[i], hail[i], this.snowFall[i], wetG, wetH, iceNumber[i] * rhoZ) * dt / rhoZ
              // Inductive charging in the field: the graupel-hail gains what the rebounding droplets take away.
              const induced = inductiveRate(tc, rhoZ, cloud[i], graupel[i], hail[i], this.fieldZ[i], (cNow[1] + separated) * rhoZ, wetG, wetH) * dt / rhoZ
              cI[i] = cNow[0] - separated; cG[i] = cNow[1] + separated + induced; cR[i] = cNow[2]; cA[i] = cNow[3] - induced
            }
          } else { mark = theta[i]; cond = saturationAdjust(theta, q, cloud, i, exner, p); if (budget) { bCond![i] += theta[i] - mark; given += theta[i] - mark } }
          if (cond < 0) cold[i] -= LV / CP / exner * cond * .14
          // B = g [(θv − θv_env) / θv_env − q_c − q_i − q_r − q_s − q_g]: condensate loads the air with its own mass.
          // Inside a zone the reference is the zone's own air (each zone its own environment, as the large-scale flow
          // keeps it): its warmer air is not a giant thermal there, but becomes buoyant where it leaves the zone.
          const ref = zones && alt < ZONE_DEPTH ? (thEnv + this.zoneThetaNow[x + row] * zoneShape(alt) / exner) * (1 + .61 * (qEnv + this.zoneVapourNow[x + row] * zoneShape(alt))) : thvEnv
          const buoy = (theta[i] * (1 + .61 * q[i]) - ref) / ref - cloud[i] - ice[i] - rain[i] - snow[i] - graupel[i] - hail[i]; if (!staged) w[i] += G * buoy * dt
          // Damp and rotate only the departure from the environmental wind, so the imposed shear profile is not eroded.
          const du = (u[i] - ue) * keep, dv = (v[i] - ve) * keep; u[i] = ue + du + f * dv * dt; v[i] = ve + dv - f * du * dt
          // Surface fluxes enter the lowest levels with the shares in surfaceShare, so the column receives exactly H and LE.
          if (z < this.surfaceShare.length) {
            // The city (if any) blends in its own energy balance under the share of the column it covers.
            const pattern = 1 + this.patternNow[x + row] * .32, per = pattern * this.surfaceShare[z] * dt / rhoZ, c = urban === flux ? 0 : this.cityNow[x + row]
            const sunlit = shaded ? this.sunNow[x + row] : 1, k = sunlit < 1 ? scale(flux.absorbed, sunlit) : 1, ku = c > 0 && sunlit < 1 ? scale(urban.absorbed, sunlit) : 1
            const heat = (k * flux.sensible + c * (ku * urban.sensible - k * flux.sensible)) * per / (CP * exner)
            mark = theta[i]; theta[i] += heat; q[i] += (k * flux.latent + c * (ku * urban.latent - k * flux.latent)) * per / LV
            if (budget) { bSurface![i] += theta[i] - mark; given += theta[i] - mark }
          }
          // Below 0.001 K the indicator is noise from the transport tails: zero, so the transport can skip it.
          cold[i] = cold[i] < 1e-3 ? 0 : Math.min(cold[i], 15)
          if (alt > spongeStart) { const s = clamp((alt - spongeStart) / (H - spongeStart)) * .06 * dt; w[i] *= 1 - s; u[i] = lerp(u[i], ue, s); v[i] = lerp(v[i], ve, s); mark = theta[i]; theta[i] = lerp(theta[i], thEnv, s); if (budget) { pulled += theta[i] - mark; pull(i, 1 - s) } }
          // The maintained front: the cold side is pulled to its colder profile (the warm side is left alone).
          if (front && alt < FRONT_DEPTH) { const d = this.frontDeficit(x, y, alt), s = 1 - Math.exp(-dt / FRONT_TIME * d / front / (1 - alt / FRONT_DEPTH)); mark = theta[i]; theta[i] = lerp(theta[i], thEnv - d, s); if (budget) { pulled += theta[i] - mark; pull(i, 1 - s) } }
          // The moving front: inside its cold air the air is pulled to the colder profile; behind a warm front, back to the
          // warm air (outside both, nothing: the storms' outflow and the front's own density current move freely).
          if (frontTop > alt) {
            const [d, behindWarm] = this.frontalAt(x, y, alt)
            if (d > .01 || behindWarm) { mark = theta[i]; theta[i] = lerp(theta[i], thEnv - d, frontPull); if (budget) { pulled += theta[i] - mark; pull(i, 1 - frontPull) }; q[i] = lerp(q[i], qEnv * coldMoisture(d), frontPull) }
          }
          // Zones of the environment: inside one, the air near the ground is pulled to the zone's profile, in proportion to
          // the share of the column it covers (outside, nothing: the outflow spreads freely).
          if (zones && alt < ZONE_DEPTH) {
            const share = this.zoneShareNow[x + row]
            if (share > 0) {
              const s = 1 - Math.exp(-dt / ZONE_TIME * share), shape = zoneShape(alt)
              mark = theta[i]; theta[i] = lerp(theta[i], thEnv + this.zoneThetaNow[x + row] * shape / exner, s); if (budget) { pulled += theta[i] - mark; pull(i, 1 - s) }; q[i] = lerp(q[i], Math.max(0, qEnv + this.zoneVapourNow[x + row] * shape), s)
            }
          }
          // Relaxed side boundaries: the pull grows as (1 - d / zone)^2 from the inner edge of the zone to the domain edge.
          if (relaxed) {
            const d = onlyX ? edgeX[x] : Math.min(edgeX[x], edgeY[y])
            if (d < EDGE_ZONE) {
              const s = 1 - Math.exp(-dt / EDGE_TIME * (1 - d / EDGE_ZONE) ** 2), k = 1 - s
              u[i] = lerp(u[i], ue, s); v[i] = lerp(v[i], ve, s); w[i] *= k; const fd = frontTop > alt ? this.frontalAt(x, y, alt)[0] : 0
              mark = theta[i]; theta[i] = lerp(theta[i], thEnv - this.frontDeficit(x, y, alt) - fd, s); if (budget) { pulled += theta[i] - mark; pull(i, k) }; q[i] = lerp(q[i], qEnv * coldMoisture(fd), s)
              cloud[i] *= k; rain[i] *= k; ice[i] *= k; iceNumber[i] *= k; snow[i] *= k; graupel[i] *= k; hail[i] *= k; cold[i] *= k
              if (electric) { cI[i] *= k; cG[i] *= k; cR[i] *= k; cA[i] *= k }
            }
          }
          // The rest of the node's change (what no term or pull above took) goes to "other", so the terms add up to it exactly.
          if (budget) bOther![i] += theta[i] - start - given - pulled
        }
      }
    }
    if (withIce) for (let i = z * layer, e = i + layer; i < e; i++) this.condensate[i] = cloud[i] + ice[i]
  }

  /**
   * Lightning (2.3 step 3): flashes wherever the storm's field exceeds the breakdown threshold, on the main thread
   * after the step. A CG flash lowers its charge to the ground.
   */
  private discharge(dt: number) {
    this.lightning ??= new Lightning(this.grid, this.env.rho, this.config.seed + 1)
    this.lightning.corona = this.config.surfaceType !== 'water'
    // The cloud of the channel and the conduction: the droplets, crystals and snow (in the scheme the anvil is mostly snow).
    this.lightning.cloud([this.cloud, this.ice, this.snow])
    for (const flash of this.lightning.discharge([this.chargeIce, this.chargeGraupel, this.chargeRain, this.chargeAir], this.time + dt, flashLimit(dt))) {
      if (flash.kind === 'CG') { this.chargeGround += flash.charge; this.flashCount.cg++ } else this.flashCount.ic++
      this.flashes.push(flash)
    }
    if (this.flashes.length > RECENT_FLASHES) this.flashes.splice(0, this.flashes.length - RECENT_FLASHES)
    // The ions drift in the field and relax the charge (screening layers at the cloud's edges), the ground gives corona.
    this.chargeGround += this.lightning.conduct(this.chargeAir, dt)
    // The vertical field of the last solve (after the flashes, or as the storm stands), for the inductive charging.
    const { nz, layer, zs } = this.grid, phi = this.lightning.phi, ez = this.fieldZ
    for (let z = 1; z < nz - 1; z++) { const h = zs[z + 1] - zs[z - 1]; for (let c = 0, i = z * layer; c < layer; c++, i++) ez[i] = -(phi[i + layer] - phi[i - layer]) / h }
  }

  /** Total charge in the domain, C: the three carriers summed with the air mass of every node (rho0 · volume). */
  totalCharge() {
    const { nz, layer, dx, dy, hz } = this.grid, rho = this.env.rho
    let total = 0
    for (let z = 0, i = 0; z < nz; z++) { let s = 0; for (let e = i + layer; i < e; i++) s += this.chargeIce[i] + this.chargeGraupel[i] + this.chargeRain[i] + this.chargeAir[i]; total += s * rho[z] * dx * dy * hz[z] }
    return total
  }

  /** The settings helper threads must follow (threads.ts): the config and the model's switches. */
  settings() {
    return JSON.stringify({ config: this.config, microphysics: this.microphysics, transport: this.transport, rainFormation: this.rainFormation, windRelaxation: this.windRelaxation, fixedViscosity: this.fixedViscosity, transportSlabs: this.transportSlabs, pressureInStages: this.pressureInStages, rainIntercept: this.rainIntercept, turbulenceWidth: this.turbulenceWidth })
  }

  applySettings(json: string) {
    const s = JSON.parse(json)
    Object.assign(this.config, s.config)
    this.microphysics = s.microphysics; this.transport = s.transport; this.rainFormation = s.rainFormation; this.windRelaxation = s.windRelaxation; this.fixedViscosity = s.fixedViscosity; this.transportSlabs = s.transportSlabs; this.pressureInStages = s.pressureInStages; this.rainIntercept = s.rainIntercept; this.turbulenceWidth = s.turbulenceWidth
  }

  /** Makes the node velocities exactly free of dual-cell divergence (see PressureSolver); ground and top are rigid walls. */
  private project(dt: number, limit = true) {
    const u = this.u, v = this.v, w = this.w
    const { nz, ny } = this.grid, run = (phase: Phase, tasks: number) => this.runner.run(phase, tasks, dt)
    run('pressureDivergence', nz - 1); run('pressureForward', nz - 1); run('pressureModes', ny); run('pressureInverse', nz - 1); run('pressureCorrect', nz)
    // The safety limits act once a step, on the final velocity, not on the stages' (clipped counts per step as before).
    if (!limit) return
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

  /**
   * The rotation diagnostics (UH, the cores' vorticity, where) from the fields as they are, keeping how long the
   * rotation has held: after a saved state is applied, so the panel does not show UH 0 until a step runs.
   */
  refreshRotation() { const held = this.rotation.persisted; this.updateRotation(0); this.rotation.persisted = held }

  private updateRotation(dt: number) {
    const { nx, ny, hz, zs, layer } = this.grid, [z0, z1] = this.uhLevels, r = this.rotation, col = this.uhColumn
    // Low layers: the levels up to 1 and 3 km (on the uniform ~650 m grid: one level at ~650 m, w = 0 on the ground; four).
    const top1 = zs.findLastIndex(z => z <= 1000), top3 = zs.findLastIndex(z => z <= 3000)
    let max = 0, min = 0, bx = 0, by = 0, max01 = 0, max03 = 0, low01 = 0
    const coreW = this.coreW, coreWZ = this.coreWZ
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let uh = 0, low = 0, sw = 0, swz = 0
      for (let z = 1; z <= top3; z++) { low += this.w[x + nx * y + z * layer] * this.zeta(x, y, z) * hz[z]; if (z === top1 && low > max01) { max01 = low; low01 = x + nx * y } }
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
    r.uh = max; r.anticyclonic = -min; r.uh01 = max01; r.uh03 = max03; r.low = low01; r.x = bx; r.y = by; r.persisted = coreZeta >= r.mesoZeta ? r.persisted + dt : 0
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
    const [fu, fv] = this.frame
    for (let c = 0; c < this.grid.layer; c++) gust = Math.max(gust, Math.hypot(this.u[c] + fu, this.v[c] + fv))
    for (let i = 0; i < this.grid.layer; i++) { rainRate = Math.max(rainRate, rho0 * (this.rain[i] * fallSpeed(this.rain[i], rho0, rho0) + this.snow[i] * snowFallSpeed(this.snow[i], rho0, rho0) + this.graupel[i] * graupelFallSpeed(this.graupel[i], rho0) + this.hail[i] * hailFallSpeed(this.hail[i], rho0)) * 3600); rainTotal = Math.max(rainTotal, this.precipitation[i]) }
    // Largest hailstones reaching the ground now (falling through the ground node), mm.
    let hail = 0
    const cold = outflowDeficit(this)
    for (let i = 0; i < this.grid.layer; i++) hail = Math.max(hail, hailMaxDiameter(this.hail[i], rho0) * 1000)
    return { updraft: up, downdraft: down, rainRate, rainTotal, cloudTop: top, thermalTop, maxCloud, coldMax, cores: this.countCores(), shear06: Math.hypot(u6 - u0, v6 - v0), outflow: cold.max, outflowLow: deficitNear(cold, this.grid, this.rotation.low), gust, hail, clipped: this.clipped }
  }
}
