import { describe, expect, it } from 'vitest'
import { AtmosphereModel, CP, createGrid, G, KAPPA, LV, qsatP, RD, saturationAdjust, type SimConfig } from '.'
import type { EnvironmentProfile } from './environment'
import { SUMMER_DAY } from './fixtures'

/**
 * Reference cases from the literature, at their own resolution (slow: `npx vitest run --mode slow src/core/reference.test.ts`).
 * Dry, no sun, no Coriolis, no surface drag, no wind relaxation, constant eddy viscosity: the dynamical core alone.
 */
const slow = (import.meta as { env?: { MODE?: string } }).env?.MODE === 'slow'
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
/** Appends a result line to the file STORMLAB_RESULT, if set (vitest does not show the console output of passing tests). */
async function report(line: string) {
  if (!env.STORMLAB_RESULT) return
  const fs: { appendFileSync(path: string, data: string): void } = await import(/* @vite-ignore */ 'node:' + 'fs')
  fs.appendFileSync(env.STORMLAB_RESULT, line + '\n')
}
const DRY: SimConfig = { ...SUMMER_DAY, latitude: 0, solarMax: 0, bubble: 0, followStorm: false, microphysics: 'warm' }
const NEUTRAL: EnvironmentProfile = { theta: () => 300, rh: () => 0, wind: () => [0, 0] }

/**
 * Straka et al. (1993): a cold bubble (-15 K in temperature, 4 x 2 km half-widths, centred at 3 km) falls in a neutral
 * theta = 300 K atmosphere and spreads as a density current with three Kelvin-Helmholtz rotors, K = 75 m2/s, 900 s.
 * Converged solution (25 m): front (-1 K at the ground) 15.5 km from the centre, theta' min -9.8 K, u max 36 m/s,
 * w min -16 m/s. Here 2D (one row in y) on the full periodic 51.2 km domain, as in the paper.
 * Measured 2026-10-08 (front km / theta' min K / u max / w min m/s): 400 m 14.47 / -11.5 / 32.8 / -12.4; 200 m 14.85 /
 * -10.8 / 30.9 / -14.6; 100 m 14.99 / -9.81 / 32.6 / -15.2; 50 m 15.08 / -9.66 / 32.5 / -15.3. It converges, but to a
 * front ~0.45 km (3 %) behind and a u max ~10 % below the reference: an open question (roadmap). The bounds hold today's
 * 100 m result with a margin and catch a regression; the reference itself is outside them. The step matters too: at
 * 200 m, dt 1 / 0.5 / 0.25 s give u max 30.9 / 32.7 / 33.7 m/s (front 14.85 / 14.88 / 14.89 km).
 */
function straka(dx: number) {
  const nx = Math.round(51_200 / dx), nz = Math.round(6_400 / dx) + 1
  const model = new AtmosphereModel(DRY, createGrid({ nx, ny: 1, nz, width: 51_200, depth: dx, height: 6_400 }), NEUTRAL)
  model.fixedViscosity = 75; model.surfaceDrag = false; model.windRelaxation = 0
  const { zs, layer } = model.grid, cx = 25_600
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const l = Math.hypot((x * dx - cx) / 4000, (zs[z] - 3000) / 2000)
    if (l <= 1) model.theta[x + z * layer] = 300 - 15 * (1 + Math.cos(Math.PI * l)) / 2 / model.env.exner[z]
  }
  const dt = dx <= 100 ? .5 : 1
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
function bryanFritsch(moist: boolean, dx = 100) {
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

describe('reference cases', () => {
  it.runIf(slow)('Straka density current at 100 m: front, coldest air and winds stay where the model converges', async () => {
    const r = straka(100)
    await report(`Straka 100 m: front ${r.front.toFixed(2)} km, theta' min ${r.thetaMin.toFixed(2)} K, u max ${r.uMax.toFixed(1)}, w ${r.wMin.toFixed(1)}..${r.wMax.toFixed(1)} m/s`)
    expect(r.front).toBeGreaterThan(14.7); expect(r.front).toBeLessThan(16)
    expect(r.thetaMin).toBeGreaterThan(-11); expect(r.thetaMin).toBeLessThan(-8.5)
    expect(r.uMax).toBeGreaterThan(30.5); expect(r.uMax).toBeLessThan(40)
    expect(r.wMin).toBeGreaterThan(-19); expect(r.wMin).toBeLessThan(-13.5)
  }, 600_000)

  it.runIf(slow)('Bryan-Fritsch bubble: dry and moist thermals near the reference', async () => {
    const dry = bryanFritsch(false), moist = bryanFritsch(true), f = (r: typeof dry) => `top ${r.top.toFixed(1)} km, centre ${r.centre.toFixed(2)} km, w max ${r.wMax.toFixed(1)} m/s`
    await report(`Bryan-Fritsch 100 m: dry ${f(dry)}; moist ${f(moist)}, theta_e - env ${moist.thetaE.map(t => t.toFixed(2)).join(' / ')} K`)
    expect(dry.top).toBeGreaterThan(7.6); expect(dry.top).toBeLessThan(8.6)
    expect(dry.centre).toBeGreaterThan(5.8); expect(dry.centre).toBeLessThan(6.8)
    expect(dry.wMax).toBeGreaterThan(12.5); expect(dry.wMax).toBeLessThan(15.5)
    // The reference: moist w max 15.7 m/s, theta_e' -0.31..4.10 K; the moist thermal stronger than the dry one by ~13 %.
    expect(moist.wMax).toBeGreaterThan(14.2); expect(moist.wMax).toBeLessThan(17.3)
    expect(moist.wMax / dry.wMax).toBeGreaterThan(1.03); expect(moist.wMax / dry.wMax).toBeLessThan(1.25)
    expect(moist.thetaE[3]).toBeGreaterThan(3.6); expect(moist.thetaE[3]).toBeLessThan(4.9); expect(moist.thetaE[2]).toBeGreaterThan(-.7)
  }, 1_200_000)
})
