import { describe, it } from 'vitest'
import { AtmosphereModel, createGrid, DEFAULT_GRID, SCENARIOS, type SimConfig } from '.'
import { SUMMER_DAY } from './fixtures'

/**
 * A/B experiments, not a check: one scenario with one change undone, printing a time series. Run by the cloud workflow
 * (.github/workflows/experiments.yml) or locally:
 *   STORMLAB_EXPERIMENT=<variant> STORMLAB_SCENARIO=<index> npx vitest run --mode slow src/core/experiments.test.ts
 * Variants undo what changed after the realistic scenarios were calibrated on 2026-09-29 (updraughts then ~45-54 m/s):
 * `uniform` — the old 30 uniform 652 m levels instead of 50 stretched (2026-10-01); `warm` — Kessler warm rain instead
 * of ice (2026-10-03); `fixed` — no storm-following domain (2026-10-03); `old` — all three, the 2026-09-29 setup; `base`.
 * `aniso` — horizontal mixing with the horizontal filter width (Turbulence.anisotropic). STORMLAB_MINUTES sets the
 * model time (default 40).
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const variant = env.STORMLAB_EXPERIMENT, slow = (import.meta as { env?: { MODE?: string } }).env?.MODE === 'slow'
const UNIFORM = { ...DEFAULT_GRID, nz: 30, bottomSpacing: undefined }

describe('experiments', () => {
  it.runIf(slow && !!variant)(`${variant} on scenario ${env.STORMLAB_SCENARIO}`, async () => {
    const s = SCENARIOS[Number(env.STORMLAB_SCENARIO ?? 0)], old = variant === 'old'
    const config: SimConfig = { ...SUMMER_DAY, ...s.values }
    if (variant === 'warm' || old) config.microphysics = 'warm'
    if (variant === 'fixed' || old) config.followStorm = false
    const model = new AtmosphereModel(config, createGrid(variant === 'uniform' || old ? UNIFORM : DEFAULT_GRID))
    if (variant === 'aniso') model.turbulenceWidth = 'anisotropic'
    const { layer, zs } = model.grid, rows: string[] = []
    let longest = 0, peakW = 0, peakUH = 0
    for (let t = 1; t <= Number(env.STORMLAB_MINUTES ?? 40) * 60; t++) {
      model.step(1); model.time += 1; longest = Math.max(longest, model.rotation.persisted); peakUH = Math.max(peakUH, model.rotation.uh)
      if (t % 300) continue
      // Strongest updraught and its height; strongest cyclonic and anticyclonic UH; the column of the UH maximum.
      let w = 0, at = 0
      for (let i = 0; i < model.w.length; i++) if (model.w[i] > w) { w = model.w[i]; at = Math.floor(i / layer) }
      peakW = Math.max(peakW, w)
      const d = model.diagnostics(), r = model.rotation
      rows.push(`${String(t / 60).padStart(2)} min  w ${w.toFixed(1).padStart(5)} at ${(zs[at] / 1000).toFixed(1)} km  UH ${r.uh.toFixed(0).padStart(4)} anti ${r.anticyclonic.toFixed(0).padStart(4)}` +
        ` held ${String(r.persisted).padStart(4)} s  UH03 ${r.uh03.toFixed(0).padStart(4)}  down ${d.downdraft.toFixed(1)}  cold ${d.coldMax.toFixed(1)} K  cores ${d.cores}  top ${d.cloudTop.toFixed(1)} km  rain ${d.rainTotal.toFixed(1)} mm  at x${r.x} y${r.y}`)
    }
    const lines = [`EXPERIMENT ${s.name} / ${variant}: max w ${peakW.toFixed(1)} m/s, max UH ${peakUH.toFixed(0)}, mesocyclone ${longest} s, clipped ${model.clipped}`, ...rows]
    // Into a file (STORMLAB_RESULT, default experiment.txt): vitest does not show the console output of this test.
    const fs: { appendFileSync(path: string, data: string): void } = await import(/* @vite-ignore */ 'node:' + 'fs')
    fs.appendFileSync(env.STORMLAB_RESULT ?? 'experiment.txt', lines.join('\n') + '\n')
  }, 3_600_000)
})
