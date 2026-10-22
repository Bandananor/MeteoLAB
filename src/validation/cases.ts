/**
 * The model's validation cases (roadmap A1), one list for the slow tests and the validation report (tools/validate.ts,
 * docs/validation.md): each case runs the model and gives its checks — the quantity, the model's value, the reference
 * with its source, and the bounds the value must stay in. The bounds hold today's result with a margin and catch a
 * regression; where the model is off the reference (Straka), the bounds say so and the reference stays outside them.
 *
 * The dynamical core against the literature (Straka et al. 1993, Bryan & Fritsch 2002), the Weisman & Klemp (1982)
 * supercell, and every scenario with a thermal against what it is meant to show.
 */
import { AtmosphereModel, CP, createGrid, DT, G, KAPPA, LARGE_GRID, levelAt, LV, MESO_PERSISTENCE, qsatP, RD, saturationAdjust, SCENARIOS, type SimConfig, weismanKlemp } from '../core'
import type { EnvironmentProfile } from '../core/environment'
import { SUMMER_DAY } from '../core/fixtures'

export interface Check {
  quantity: string; unit: string; value: number
  /** What the literature or the case's purpose says (a number with its source, or a statement). */
  reference: string
  /** The value must lie within (either end may be infinite). */
  bounds: readonly [number, number]
}
export interface CaseResult { checks: Check[]; note?: string }
export interface ValidationCase {
  id: string; title: string; source: string
  /** Rough minutes on one laptop core, for planning. */
  minutes: number
  run(): CaseResult
}

export const passes = (c: Check) => c.value >= c.bounds[0] && c.value <= c.bounds[1]
const check = (quantity: string, unit: string, value: number, reference: string, bounds: readonly [number, number]): Check => ({ quantity, unit, value, reference, bounds })

const DRY: SimConfig = { ...SUMMER_DAY, latitude: 0, solarMax: 0, bubble: 0, followStorm: false, microphysics: 'warm' }
const NEUTRAL: EnvironmentProfile = { theta: () => 300, rh: () => 0, wind: () => [0, 0] }

/**
 * Straka et al. (1993): a cold bubble (-15 K in temperature, 4 x 2 km half-widths, centred at 3 km) falls in a neutral
 * theta = 300 K atmosphere and spreads as a density current with three Kelvin-Helmholtz rotors, K = 75 m2/s, 900 s.
 * Converged solution (25 m): front (-1 K at the ground) 15.5 km from the centre, theta' min -9.8 K, u max 36 m/s,
 * w min -16 m/s. Here 2D (one row in y) on the full periodic 51.2 km domain, as in the paper.
 * Measured 2026-10-08 (front km / theta' min K / u max / w min m/s): 400 m 14.47 / -11.5 / 32.8 / -12.4; 200 m 14.85 /
 * -10.8 / 30.9 / -14.6; 100 m 14.99 / -9.81 / 32.6 / -15.2; 50 m 15.08 / -9.66 / 32.5 / -15.3. It converges, but to a
 * front ~0.45 km (3 %) behind and a u max ~10 % below the reference: an open question (roadmap A4). The step matters
 * too: at 200 m, dt 1 / 0.5 / 0.25 s give u max 30.9 / 32.7 / 33.7 m/s (front 14.85 / 14.88 / 14.89 km).
 * Since 22.10.2026 the buoyancy and the pressure act in every RK3 stage (model.ts pressureInStages): the u max no longer
 * depends on dt - 34.6-34.7 m/s at 200 m and dt 1 / 0.5 / 0.25 s, 34.7 at 100 m and at 50 m, w min -16.1 (the
 * reference -16) - so ~4 % below the reference is left, the grid's; the front is as it was (14.98 at 100 m, 15.08 at
 * 50 m), still the open question. `inStages` false: the old splitting, for comparison.
 */
export function straka(dx: number, step?: number, inStages?: boolean) {
  const nx = Math.round(51_200 / dx), nz = Math.round(6_400 / dx) + 1
  const model = new AtmosphereModel(DRY, createGrid({ nx, ny: 1, nz, width: 51_200, depth: dx, height: 6_400 }), NEUTRAL)
  model.fixedViscosity = 75; model.surfaceDrag = false; model.windRelaxation = 0; if (inStages !== undefined) model.pressureInStages = inStages
  const { zs, layer } = model.grid, cx = 25_600
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const l = Math.hypot((x * dx - cx) / 4000, (zs[z] - 3000) / 2000)
    if (l <= 1) model.theta[x + z * layer] = 300 - 15 * (1 + Math.cos(Math.PI * l)) / 2 / model.env.exner[z]
  }
  const dt = step ?? (dx <= 100 ? .5 : 1)
  for (let t = 0; t < 900 / dt; t++) model.step(dt)
  // Front: the farthest point right of the centre where theta' at the ground falls to -1 K (linear between nodes).
  let front = 0
  for (let x = Math.round(cx / dx); x < nx - 1; x++) {
    const a = model.theta[x] - 300, b = model.theta[x + 1] - 300
    if (a <= -1 && b > -1) front = (x + (-1 - a) / (b - a)) * dx - cx
  }
  let thetaMin = 0, uMax = 0, wMin = 0, wMax = 0
  for (let i = 0; i < model.grid.n; i++) {
    thetaMin = Math.min(thetaMin, model.theta[i] - 300); uMax = Math.max(uMax, model.u[i]); wMin = Math.min(wMin, model.w[i]); wMax = Math.max(wMax, model.w[i])
  }
  return { front: front / 1000, thetaMin, uMax, wMin, wMax }
}

/** Total water of the Bryan & Fritsch (2002) moist case, kg/kg. */
const QT = .02

/**
 * The saturated moist-neutral column of Bryan & Fritsch (2002): total water 20 g/kg everywhere, theta_e 320 K at the
 * ground. Built by lifting a saturated parcel in 10 m steps with the model's own saturation adjustment and the same
 * hydrostatic pressure as Environment, so the column is neutral for this model's thermodynamics.
 */
function moistNeutral(): EnvironmentProfile {
  const step = 10, p0 = 101_325, ex0 = (p0 / 1e5) ** KAPPA
  let lo = 270, hi = 310
  for (let k = 0; k < 60; k++) { const t = (lo + hi) / 2; if (t / ex0 * Math.exp(LV * qsatP(t - 273.15, p0) / (CP * t)) > 320) hi = t; else lo = t }
  const th = Float32Array.of(lo / ex0), q = Float32Array.of(qsatP(lo - 273.15, p0)), c = Float32Array.of(QT - q[0]), thetas = [th[0]]
  let lnp = Math.log(p0)
  for (let z = step; z <= 12_000; z += step) {
    lnp -= G * step / (RD * th[0] * Math.exp(KAPPA * (lnp - Math.log(1e5))) * (1 + .61 * q[0]))
    const p = Math.exp(lnp); saturationAdjust(th, q, c, 0, (p / 1e5) ** KAPPA, p); thetas.push(th[0])
  }
  return { theta: z => { const x = Math.min(z / step, thetas.length - 1.001), k = Math.floor(x); return thetas[k] + (thetas[k + 1] - thetas[k]) * (x - k) }, rh: () => 1, wind: () => [0, 0] }
}

/**
 * Bryan & Fritsch (2002): a warm bubble (theta' = 2 cos^2(pi L / 2) K, radius 2 km, centred at 2 km) rises for 1000 s in
 * a neutral atmosphere, dry (theta 300 K) or saturated (above; no rain, cloud water only condenses and evaporates). The
 * moist bubble gets the same initial buoyancy as the dry one (it still ends up stronger: its buoyancy grows as it rises). 2D, 20 x 10 km, no explicit diffusion (the paper used a weak filter).
 * Reference at 1000 s (Bryan & Fritsch 2002, as quoted by Duarte et al. 2014, arXiv:1311.4265): moist w max 15.7 m/s,
 * min -9.9, theta_e' max 4.10 K, min -0.31; dry (Duarte et al., 512 x 256) w max 13.9, theta' 2.21 / -0.13, top ~8 km.
 * Measured 2026-10-08 at 100 m (top / buoyancy-weighted centre km, w max m/s): dry 8.1 / 6.27 / 14.5 (theta' 2.13 /
 * -0.18), moist 8.7 / 6.92 / 16.2, theta_e minus the environment's -0.36 / 4.45 K (approximate theta_e: not the paper's
 * wet theta_e). Both within ~4 % of the reference w; the moist one 12 % stronger than the dry one, as in the reference
 * (13 %). Tried 2026-10-08: latent heat with the moist heat capacity and L(T) changed the moist centre by 0.02 km only.
 */
export function bryanFritsch(moist: boolean, dx = 100) {
  const nx = Math.round(20_000 / dx), nz = Math.round(10_000 / dx) + 1
  const model = new AtmosphereModel(DRY, createGrid({ nx, ny: 1, nz, width: 20_000, depth: dx, height: 10_000 }), moist ? moistNeutral() : NEUTRAL)
  model.fixedViscosity = 0; model.surfaceDrag = false; model.windRelaxation = 0; model.rainFormation = false
  const { zs, layer } = model.grid, e = model.env
  const qcEnv = Float64Array.from(e.q, qv => moist ? Math.max(0, QT - qv) : 0), thvEnv = Float64Array.from(e.theta, (t, z) => t * (1 + .61 * e.q[z]))
  // Buoyancy (over g) of a node as the model computes it, without the level-uniform loading of the cloudy environment.
  const buoyancy = (th: number, qv: number, qc: number, z: number) => (th * (1 + .61 * qv) - thvEnv[z]) / thvEnv[z] - (qc - qcEnv[z])
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const i = x + z * layer, l = Math.hypot((x * dx - 10_000) / 2000, (zs[z] - 2000) / 2000)
    if (moist) model.cloud[i] = qcEnv[z]
    if (l > 1) continue
    const target = 2 * Math.cos(Math.PI * l / 2) ** 2 / 300
    if (!moist) { model.theta[i] = 300 * (1 + target); continue }
    // Saturated with the same total water: the theta whose buoyancy equals the dry bubble's (bisection).
    const ex = e.exner[z], p = e.p[z], qv = (th: number) => Math.min(QT, qsatP(th * ex - 273.15, p))
    let lo = e.theta[z] - 1, hi = e.theta[z] + 10
    for (let k = 0; k < 60; k++) { const th = (lo + hi) / 2; if (buoyancy(th, qv(th), QT - qv(th), z) > target) hi = th; else lo = th }
    model.theta[i] = lo; model.q[i] = qv(lo); model.cloud[i] = QT - qv(lo)
  }
  // Range of theta_e minus that of the environment at the same level, the paper's theta_e' (theta_e itself is not
  // this model's invariant: its own reversibly neutral column above goes from 320 K at the ground to 322.5 K at 10 km.)
  const thetaE = (th: number, qv: number, z: number) => th * Math.exp(LV * qv / (CP * th * e.exner[z]))
  const teEnv = Float64Array.from(e.theta, (t, z) => thetaE(t, e.q[z], z))
  const thetaERange = () => {
    let min = Infinity, max = -Infinity
    for (let z = 0, i = 0; z < nz; z++) for (let x = 0; x < nx; x++, i++) {
      const d = thetaE(model.theta[i], model.q[i], z) - teEnv[z]; min = Math.min(min, d); max = Math.max(max, d)
    }
    return [min, max]
  }
  const [te0min, te0max] = thetaERange()
  for (let t = 0; t < 2000; t++) model.step(.5)
  // Top: the highest level with buoyancy above 1e-3 (theta' ~0.3 K); centre: the buoyancy-weighted height; max w.
  let top = 0, bz = 0, bs = 0, wMax = 0
  for (let z = 0, i = 0; z < nz; z++) for (let x = 0; x < nx; x++, i++) {
    const b = buoyancy(model.theta[i], model.q[i], model.cloud[i], z)
    if (b > 1e-3) top = zs[z]
    if (b > 0) { bz += b * zs[z]; bs += b }
    wMax = Math.max(wMax, model.w[i])
  }
  const [te1min, te1max] = thetaERange()
  return { top: top / 1000, centre: bz / bs / 1000, wMax, thetaE: [te0min, te0max, te1min, te1max] }
}

/** Local maxima of w at a level (w above `minW`, strongest within ±2 nodes), strongest first. */
export function updraftCores(model: AtmosphereModel, height: number, minW: number) {
  const { nx, ny, dx, dy, layer } = model.grid, l = Math.round(levelAt(model.grid, height)) * layer, cores: { x: number; y: number; w: number; uh: number }[] = []
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const w = model.w[x + nx * y + l]
    if (w < minW) continue
    let peak = true
    for (let oy = -2; oy <= 2 && peak; oy++) for (let ox = -2; ox <= 2; ox++) if ((ox || oy) && model.w[(x + ox + nx) % nx + nx * ((y + oy + ny) % ny) + l] > w) { peak = false; break }
    if (peak) cores.push({ x: x * dx, y: y * dy, w, uh: model.uhColumn[x + nx * y] })
  }
  return cores.sort((a, b) => b.w - a.w)
}

/**
 * Weisman & Klemp (1982) sounding with a 16 g/kg boundary layer (surface CAPE ~2300 J/kg for the app parcel) and the
 * quarter-circle hodograph (westerly shear, 30 m/s at 6 km). Models at ~1 km resolution split the storm by 40-60 min
 * into a right mover (south of the shear vector, cyclonic) and a weaker left mover (anticyclonic). With the trilinear
 * semi-Lagrangian transport the storm peaks at ~21 m/s and dies by 40 min without splitting; with WENO5 + RK3 it lives
 * past 70 min at ~30 m/s and splits at 30-45 min (2026-09-29). With ice (the default since 2026-10-03) in a fixed domain
 * the right mover crossed the periodic east edge at ~52 min into its own cold pool: the domain follows the right mover.
 * The 96 x 72 km domain since 2026-10-09: on 48 x 36 km the cold pool covered 91 % of the periodic domain by 60 min and
 * the cell, breathing its own outflow, fell to 13 m/s; on the large domain it covers 22 % and the cell is still ~41 m/s.
 */
export function weismanKlempSplit() {
  const model = new AtmosphereModel({ ...SUMMER_DAY, solarMax: 0, bubble: 0 }, createGrid(LARGE_GRID), weismanKlemp({ qvMax: .016 }))
  model.transport = 'weno'
  // STORMLAB_TURBULENCE=cube: the old cube-root filter width for the horizontal mixing (anisotropic is the default).
  if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.STORMLAB_TURBULENCE === 'cube') model.turbulenceWidth = 'cube'
  model.injectBubble(model.grid.width * .3, model.grid.depth * .5, 1.5)
  run(model, 35 * 60)
  const cores = updraftCores(model, 4500, 8), [right, left] = [...cores.slice(0, 2)].sort((a, b) => a.y - b.y)
  run(model, 25 * 60)
  const late = updraftCores(model, 4500, 0)
  return { cores: cores.length, separation: left && right ? (left.y - right.y) / 1000 : 0, rightW: right?.w ?? 0, leftW: left?.w ?? 0, rightUh: right?.uh ?? 0, leftUh: left?.uh ?? 0, w60: late[0]?.w ?? 0 }
}

function run(model: AtmosphereModel, seconds: number) {
  for (let k = 0; k < seconds; k += DT) { model.step(DT); model.time += DT }
}

/** Strongest updraught allowed in the scenarios not meant to be supercells, m/s (cloud run 10.10.2026: 20-50 m/s). */
export const MAX_ORDINARY_W = 55

/**
 * A scenario with a thermal for 40 min: the strongest updraught (every minute), UH, how long the mesocyclone held, the
 * wind at 100 m, rain and hail. STORMLAB_MICRO=warm runs it with Kessler warm rain.
 */
export function scenarioRun(values: Partial<SimConfig>) {
  const micro = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.STORMLAB_MICRO as SimConfig['microphysics']
  const model = new AtmosphereModel({ ...SUMMER_DAY, ...values, ...(micro ? { microphysics: micro } : {}) })
  let longest = 0, maxW = 0, maxUH = 0, gust = 0
  // Strongest wind over the ground at the 100 m level (outflow, microburst gusts).
  const { layer, zs } = model.grid, near = zs.findIndex(z => z >= 100) * layer, [fu, fv] = model.frame
  for (let t = 0; t < 40 * 60; t += DT) {
    model.step(DT); model.time += DT; longest = Math.max(longest, model.rotation.persisted); maxUH = Math.max(maxUH, model.rotation.uh)
    if (t % 60 === 0) maxW = Math.max(maxW, model.diagnostics().updraft)
    if (t % 30 === 0) for (let c = 0; c < layer; c++) gust = Math.max(gust, Math.hypot(model.u[near + c] + fu, model.v[near + c] + fv))
  }
  return { maxW, maxUH, longest, gust, rain: Math.max(...model.precipitation), hailAloft: Math.max(...model.hailSize) / 10, hailGround: Math.max(...model.hailGround), clipped: model.clipped }
}

/**
 * A ready situation (2.6) for `minutes`: the strongest updraught and the highest cloud top over the run, and over
 * [lateFrom, lateTo) min the mean of the minute maxima of the updraught and the heaviest rain at the ground.
 */
export function situationRun(values: Partial<SimConfig>, minutes: number, lateFrom = Infinity, lateTo = Infinity) {
  const model = new AtmosphereModel({ ...SUMMER_DAY, ...values })
  let maxW = 0, top = 0, late = 0, lateN = 0, lateRain = 0
  for (let t = DT; t <= minutes * 60; t += DT) {
    model.step(DT); model.time += DT
    if (t % 60) continue
    const d = model.diagnostics(); maxW = Math.max(maxW, d.updraft); top = Math.max(top, d.cloudTop)
    if (t > lateFrom * 60 && t <= lateTo * 60) { late += d.updraft; lateN++; lateRain = Math.max(lateRain, d.rainRate) }
  }
  return { maxW, top, late: lateN ? late / lateN : 0, lateRain, clipped: model.clipped }
}
/** The ready situations, each run with and without what drives its story (the slow test runs each in its own cloud job). */
export const SITUATIONS = ['Тёплый сектор и холодный фронт', 'Высотная ложбина', 'Тёплый воздух над слоем: гроз не будет']

const INF = Infinity
/** The scenarios the cases run: those with a thermal (the others start in the morning and take hours of heating). */
export const SHORT_SCENARIOS = SCENARIOS.filter(s => s.values.bubble !== 0)

export const CASES: ValidationCase[] = [
  {
    id: 'straka', title: 'Density current (Straka et al. 1993), 100 m, 900 s', source: 'Straka, Wilhelmson, Wicker, Anderson, Droegemeier 1993, Int. J. Numer. Methods Fluids 17; converged 25 m solution', minutes: 6,
    run() {
      const r = straka(100)
      return {
        checks: [
          check('front position (θ′ = −1 K at the ground)', 'km', r.front, '15.5 (25 m)', [14.7, 16]),
          check('θ′ min', 'K', r.thetaMin, '−9.8', [-11, -8.5]),
          check('u max', 'm/s', r.uMax, '36', [33.5, 40]),
          check('w min', 'm/s', r.wMin, '−16', [-19, -13.5]),
        ],
        note: 'Converges with the grid (400 → 50 m) to a front ~3 % behind and a u max ~4 % below the reference (34.7 against 36 m/s at 50 and 100 m; ~10 % below, and first-order in dt, before the pressure acted in every RK3 stage, 22.10.2026): known deviation, roadmap A4.',
      }
    },
  },
  {
    id: 'bryan-fritsch', title: 'Rising thermal, dry and saturated (Bryan & Fritsch 2002), 100 m, 1000 s', source: 'Bryan & Fritsch 2002, Mon. Wea. Rev. 130; numbers as quoted by Duarte et al. 2014 (arXiv:1311.4265)', minutes: 8,
    run() {
      const dry = bryanFritsch(false), moist = bryanFritsch(true)
      return {
        checks: [
          check('dry: top of the thermal', 'km', dry.top, '~8', [7.6, 8.6]),
          check('dry: buoyancy-weighted centre', 'km', dry.centre, '—', [5.8, 6.8]),
          check('dry: w max', 'm/s', dry.wMax, '13.9', [12.5, 15.5]),
          check('moist: w max', 'm/s', moist.wMax, '15.7', [14.2, 17.3]),
          check('moist / dry w max', '', moist.wMax / dry.wMax, '1.13', [1.03, 1.25]),
          check('moist: θe′ max', 'K', moist.thetaE[3], '4.10', [3.6, 4.9]),
          check('moist: θe′ min', 'K', moist.thetaE[2], '−0.31', [-.7, INF]),
        ],
        note: 'θe here is the approximate one (not the paper’s wet θe), so its extremes compare loosely.',
      }
    },
  },
  {
    id: 'weisman-klemp', title: 'Supercell split (Weisman & Klemp 1982), 96 × 72 km, 60 min', source: 'Weisman & Klemp 1982, Mon. Wea. Rev. 110: a split by 40–60 min into a stronger cyclonic right mover and an anticyclonic left mover', minutes: 25,
    run() {
      const r = weismanKlempSplit()
      return {
        checks: [
          check('updraught cores at 4.5 km, 35 min (w > 8 m/s)', '', r.cores, '≥ 2 (split)', [2, INF]),
          check('separation, left mover north of the right one', 'km', r.separation, '> 4 (two distinct cells)', [4, INF]),
          check('right mover w − left mover w', 'm/s', r.rightW - r.leftW, '> 0 (right mover dominant)', [0, INF]),
          check('right mover UH 2–5 km', 'm²/s²', r.rightUh, '> 0 (cyclonic)', [0, INF]),
          check('left mover UH 2–5 km', 'm²/s²', r.leftUh, '< 0 (anticyclonic)', [-INF, 0]),
          check('strongest updraught at 60 min', 'm/s', r.w60, '> 15 (long-lived)', [15, INF]),
        ],
      }
    },
  },
  ...SHORT_SCENARIOS.map((s, k): ValidationCase => ({
    id: `scenario-${k}`, title: `Scenario «${s.name}», 40 min`, source: s.mesocyclone === true ? 'meant to grow a supercell' : s.mesocyclone === false ? 'meant to grow no mesocyclone' : 'no rotation is asked of it', minutes: 10,
    run() {
      const r = scenarioRun(s.values)
      return {
        checks: [
          check('values clipped by the limiters', '', r.clipped, '0', [0, 0]),
          check('max updraught', 'm/s', r.maxW, s.mesocyclone === true ? '—' : `≤ ${MAX_ORDINARY_W} (observed storms ≤ ~0.6 √(2 CAPE))`, s.mesocyclone === true ? [0, INF] : [0, MAX_ORDINARY_W]),
          check('longest mesocyclone', 's', r.longest, s.mesocyclone === true ? `≥ ${MESO_PERSISTENCE}` : s.mesocyclone === false ? `< ${MESO_PERSISTENCE}` : '—', s.mesocyclone === true ? [MESO_PERSISTENCE, INF] : s.mesocyclone === false ? [0, MESO_PERSISTENCE - 1e-9] : [0, INF]),
        ],
        note: `UH max ${r.maxUH.toFixed(0)} m²/s², wind at 100 m ${r.gust.toFixed(1)} m/s, rain ${r.rain.toFixed(1)} mm, hail ${r.hailAloft.toFixed(1)} cm aloft / ${r.hailGround.toFixed(1)} mm at the ground.`,
      }
    },
  })),
  ...SITUATIONS.map((name, k): ValidationCase => {
    const values = SCENARIOS.find(x => x.name === name)!.values
    const run: Record<string, () => CaseResult> = {
      'Тёплый сектор и холодный фронт': () => {
        const front = situationRun(values, 120), none = situationRun({ ...values, frontLine: undefined }, 120)
        return { checks: [
          check('values clipped by the limiters', '', front.clipped, '0', [0, 0]),
          check('with the front: max updraught', 'm/s', front.maxW, 'storms on the front', [25, INF]),
          check('with the front: highest cloud top', 'km', front.top, 'deep storms', [10, INF]),
          check('without the front: max updraught', 'm/s', none.maxW, 'no storms (the cap holds)', [0, 10]),
        ] }
      },
      'Высотная ложбина': () => {
        // 12:10-12:50 (from 130 min): when the plain day's rain has ended and the trough's goes on.
        const trough = situationRun(values, 180, 130, 170), plain = situationRun({ ...values, largeScale: undefined }, 180, 130, 170)
        return { checks: [
          check('values clipped by the limiters', '', trough.clipped, '0', [0, 0]),
          check('with the trough: max updraught', 'm/s', trough.maxW, 'storms by 11:30', [20, INF]),
          check('without the trough: max updraught', 'm/s', plain.maxW, 'storms by 11:30 too', [15, INF]),
          check('with the trough: 12:10–12:50 mean updraught', 'm/s', trough.late, 'new cells keep going', [8, INF]),
          check('12:10–12:50 mean updraught, with − without the trough', 'm/s', trough.late - plain.late, 'the trough makes them last', [3, INF]),
          check('with the trough: heaviest rain 12:10–12:50', 'mm/h', trough.lateRain, 'downpours go on', [10, INF]),
          check('without the trough: heaviest rain 12:10–12:50', 'mm/h', plain.lateRain, 'the rain has ended by 12:20', [0, 5]),
        ], note: 'Recalibrated 22.10.2026 for 2.7.2’s ice from processes (the trough −4 K instead of −3, the window 12:10–12:50 instead of 12:30–13:00): late weak updraughts keep their cloud water supercooled and get less heat of freezing (tests/bench/glaciation.ts).' }
      },
      'Тёплый воздух над слоем: гроз не будет': () => {
        const capped = situationRun(values, 120), plain = situationRun({ ...values, largeScale: undefined }, 120)
        return { checks: [
          check('with the warm air aloft: max updraught', 'm/s', capped.maxW, 'no storms', [0, 8]),
          check('with the warm air aloft: highest cloud top', 'km', capped.top, 'shallow cumulus', [0, 4]),
          check('without it: max updraught', 'm/s', plain.maxW, 'storms', [20, INF]),
          check('without it: highest cloud top', 'km', plain.top, 'deep storms', [8, INF]),
        ] }
      },
    }
    return { id: `situation-${k}`, title: `Situation «${name}», with and without its trigger`, source: 'the situation’s story (2.6)', minutes: k === 1 ? 25 : 18, run: run[name] }
  }),
]
