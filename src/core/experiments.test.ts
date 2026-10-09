import { describe, it } from 'vitest'
import { AtmosphereModel, createGrid, DEFAULT_GRID, DT, SCENARIOS, type SimConfig } from '.'
import { SUMMER_DAY } from './fixtures'

/**
 * A/B experiments, not a check: one scenario with one change undone, printing a time series. Run by the cloud workflow
 * (.github/workflows/experiments.yml) or locally:
 *   STORMLAB_EXPERIMENT=<variant> STORMLAB_SCENARIO=<index> npx vitest run --mode slow src/core/experiments.test.ts
 * Variants undo what changed after the realistic scenarios were calibrated on 2026-09-29 (updraughts then ~45-54 m/s):
 * `uniform` — the old 30 uniform 652 m levels instead of 50 stretched (2026-10-01); `warm` — Kessler warm rain instead
 * of ice (2026-10-03); `fixed` — no storm-following domain (2026-10-03); `old` — all three, the 2026-09-29 setup; `base`.
 * `aniso` — horizontal mixing with the horizontal filter width (Turbulence.anisotropic); wind controls: `calm` (no wind),
 * `calm-eq` (no wind, no Coriolis), `half` and `double` (the wind profile x0.5, x2); `narrow` (2.5 km thermal), `nosun`
 * (no solar heating), `narrow-nosun`. STORMLAB_MINUTES sets the
 * model time (default 40).
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const variant = env.STORMLAB_EXPERIMENT, slow = (import.meta as { env?: { MODE?: string } }).env?.MODE === 'slow'
const UNIFORM = { ...DEFAULT_GRID, nz: 30, bottomSpacing: undefined }
const ZETAS = [.002, .003, .004, .005, .006]

describe('experiments', () => {
  it.runIf(slow && !!variant)(`${variant} on scenario ${env.STORMLAB_SCENARIO}`, async () => {
    const s = SCENARIOS[Number(env.STORMLAB_SCENARIO ?? 0)], old = variant === 'old'
    const config: SimConfig = { ...SUMMER_DAY, ...s.values }
    // Wind controls: no wind at all (no shear to tilt), and the same without Coriolis; the wind profile scaled by 0.5 or 2.
    const scale = variant === 'calm' || variant === 'calm-eq' ? 0 : variant === 'half' ? .5 : variant === 'double' ? 2 : 1
    if (scale !== 1) for (const k of ['wind0', 'wind05', 'wind1', 'wind3', 'wind6', 'wind10'] as const) if (config[k] !== undefined) config[k] = config[k]! * scale
    if (variant === 'calm-eq') config.latitude = 0
    // Thermal and sun: a narrow starting thermal (2.5 km instead of 4.2 km radius), no solar heating, or both.
    if (variant === 'narrow' || variant === 'narrow-nosun') config.bubbleRadius = 2.5
    if (variant === 'nosun' || variant === 'narrow-nosun') config.solarMax = 0
    if (variant === 'warm' || old) config.microphysics = 'warm'
    if (variant === 'fixed' || old) config.followStorm = false
    const model = new AtmosphereModel(config, createGrid(variant === 'uniform' || old ? UNIFORM : DEFAULT_GRID))
    if (variant === 'aniso') model.turbulenceWidth = 'anisotropic'
    const { layer, zs } = model.grid, rows: string[] = []
    let longest = 0, peakW = 0, peakUH = 0, peakGust = 0
    // Air at 100 m away from the storm (no cold pool): theta and vapour, to see whether the sun built up CAPE meanwhile.
    const level = zs.findIndex(z => z >= 100), surfaceAir = () => {
      let th = 0, q = 0, n = 0
      for (let c = 0; c < layer; c++) { const i = c + level * layer; if (model.cold[i] > .1) continue; th += model.theta[i]; q += model.q[i]; n++ }
      return [th / n, q / n * 1000]
    }
    const [th0, q0] = surfaceAir()
    const gust = () => { let g = 0; const [fu, fv] = model.frame; for (let c = 0; c < layer; c++) g = Math.max(g, Math.hypot(model.u[c + level * layer] + fu, model.v[c + level * layer] + fv)); return g }
    const held = ZETAS.map(() => 0), heldMax = ZETAS.map(() => 0)
    for (let t = 1; t <= Number(env.STORMLAB_MINUTES ?? 40) * 60; t += DT) {
      model.step(DT); model.time += DT; longest = Math.max(longest, model.rotation.persisted); peakUH = Math.max(peakUH, model.rotation.uh)
      // How long the updraught-core vorticity stays above each candidate threshold (a mesocyclone criterion to calibrate).
      // Strongest wind over the ground at 100 m (outflow and microburst gusts), every 30 s.
      if (model.time % 30 === 0) peakGust = Math.max(peakGust, gust())
      ZETAS.forEach((z, k) => { held[k] = model.rotation.coreZeta >= z ? held[k] + DT : 0; heldMax[k] = Math.max(heldMax[k], held[k]) })
      if (t % 300) continue
      // Strongest updraught and its height; strongest cyclonic and anticyclonic UH; the column of the UH maximum.
      let w = 0, at = 0
      for (let i = 0; i < model.w.length; i++) if (model.w[i] > w) { w = model.w[i]; at = Math.floor(i / layer) }
      peakW = Math.max(peakW, w)
      // Strongest cyclonic and anticyclonic vertical vorticity at 2-5 km (s-1): is the vortex too strong, or only the updraught?
      let zMax = 0, zMin = 0
      for (let z = model.uhLevels[0]; z <= model.uhLevels[1]; z++) for (let y = 0; y < model.grid.ny; y++) for (let x = 0; x < model.grid.nx; x++) {
        const zeta = model.zeta(x, y, z); zMax = Math.max(zMax, zeta); zMin = Math.min(zMin, zeta)
      }
      const d = model.diagnostics(), r = model.rotation, g = gust()
      rows.push(`${String(t / 60).padStart(2)} min  w ${w.toFixed(1).padStart(5)} at ${(zs[at] / 1000).toFixed(1)} km  UH ${r.uh.toFixed(0).padStart(4)} anti ${r.anticyclonic.toFixed(0).padStart(4)}` +
        ` gust ${g.toFixed(1)}  zeta ${(zMax * 1000).toFixed(1)}/${(zMin * 1000).toFixed(1)}e-3  held ${String(r.persisted).padStart(4)} s  coreZ ${(r.coreZeta * 1000).toFixed(1).padStart(4)}e-3 coreUH ${r.coreUH.toFixed(0).padStart(4)}  UH03 ${r.uh03.toFixed(0).padStart(4)}  down ${d.downdraft.toFixed(1)}  cold ${d.coldMax.toFixed(1)} K  cores ${d.cores}  top ${d.cloudTop.toFixed(1)} km  rain ${d.rainTotal.toFixed(1)} mm  at x${r.x} y${r.y}`)
    }
    const [th1, q1] = surfaceAir()
    const lines = [`EXPERIMENT ${s.name} / ${variant}: max w ${peakW.toFixed(1)} m/s, max UH ${peakUH.toFixed(0)}, mesocyclone ${longest} s, wind at 100 m ${peakGust.toFixed(1)} m/s, clipped ${model.clipped}`,
      `air at 100 m away from the storm: theta ${(th1 - th0 >= 0 ? '+' : '') + (th1 - th0).toFixed(2)} K, vapour ${(q1 - q0 >= 0 ? '+' : '') + (q1 - q0).toFixed(2)} g/kg over the run`,
      `core zeta held (s) at ${ZETAS.map((z, k) => `${z * 1000}e-3: ${heldMax[k]}`).join(', ')}`, ...rows]
    // Into a file (STORMLAB_RESULT, default experiment.txt): vitest does not show the console output of this test.
    const fs: { appendFileSync(path: string, data: string): void } = await import(/* @vite-ignore */ 'node:' + 'fs')
    fs.appendFileSync(env.STORMLAB_RESULT ?? 'experiment.txt', lines.join('\n') + '\n')
  }, 3_600_000)
})
