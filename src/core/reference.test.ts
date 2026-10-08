import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, type SimConfig } from '.'
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

describe('reference cases', () => {
  it.runIf(slow)('Straka density current at 100 m: front, coldest air and winds stay where the model converges', async () => {
    const r = straka(100)
    await report(`Straka 100 m: front ${r.front.toFixed(2)} km, theta' min ${r.thetaMin.toFixed(2)} K, u max ${r.uMax.toFixed(1)}, w ${r.wMin.toFixed(1)}..${r.wMax.toFixed(1)} m/s`)
    expect(r.front).toBeGreaterThan(14.7); expect(r.front).toBeLessThan(16)
    expect(r.thetaMin).toBeGreaterThan(-11); expect(r.thetaMin).toBeLessThan(-8.5)
    expect(r.uMax).toBeGreaterThan(30.5); expect(r.uMax).toBeLessThan(40)
    expect(r.wMin).toBeGreaterThan(-19); expect(r.wMin).toBeLessThan(-13.5)
  }, 600_000)
})
