import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, DEFAULT_GRID, DT, LARGE_GRID, SCENARIOS } from '.'
import { SUMMER_DAY } from './fixtures'
import { CASES, passes } from '../validation/cases'

// Slow (~15 min on the large domain at the 3 s step): run with `npm run test:slow` (vitest --mode slow); skipped by `npm test`.
const slow = (import.meta as { env?: { MODE?: string } }).env?.MODE === 'slow'

describe('Weisman-Klemp supercell (calibration)', () => {
  // The case, its history and its checks: src/validation/cases.ts (weismanKlempSplit).
  it.runIf(slow)('splits into a dominant cyclonic right mover and an anticyclonic left mover (WENO transport)', () => {
    const r = CASES.find(c => c.id === 'weisman-klemp')!.run()
    expect(r.checks.filter(c => !passes(c)).map(c => `${c.quantity} = ${c.value}`)).toEqual([])
  }, 3_000_000)
})

describe('large domain = standard domain by physics (release 2.0 check)', () => {
  // The WK scenario on 48 x 36 and 96 x 72 km (2026-10-10): identical to a few per cent for the first 20 min; then the
  // standard domain's far air warms 3-4.5 K at 6-9 km by 40 min (the subsidence around the storm, trapped in a 4x smaller
  // periodic box) against 1-1.5 K, which takes buoyancy from the updraught (42 against 61 m/s at 40 min). Rain and UH
  // stay close. So differences after ~25 min are the small box, not the large domain.
  it.runIf(slow)('gives the same storm for 20 min, and its far air warms at most half as much by 40 min', () => {
    const wk = SCENARIOS.find(s => s.name === 'Суперячейка WK')!.values
    const run = (large: boolean) => {
      const model = new AtmosphereModel({ ...SUMMER_DAY, ...wk }, createGrid(large ? LARGE_GRID : DEFAULT_GRID)), { layer, zs } = model.grid
      // Mean theta' at 9 km of the air away from the storm (no cloud, |w| < 0.5 m/s).
      const far = () => {
        const l = zs.findIndex(z => z >= 9000), env = model.env.thetaEnv(zs[l]); let sum = 0, n = 0
        for (let c = 0; c < layer; c++) { const i = l * layer + c; if (Math.abs(model.w[i]) < .5 && model.cloud[i] + model.ice[i] < 1e-6) { sum += model.theta[i] - env; n++ } }
        return sum / n
      }
      let w20 = 0, uh20 = 0
      for (let t = DT; t <= 40 * 60; t += DT) {
        model.step(DT); model.time += DT
        if (t === 20 * 60) { w20 = model.diagnostics().updraft; uh20 = model.rotation.uh }
      }
      return { w20, uh20, far40: far(), rain40: model.diagnostics().rainTotal }
    }
    const standard = run(false), large = run(true)
    expect(Math.abs(large.w20 / standard.w20 - 1)).toBeLessThan(.1)
    expect(Math.abs(large.uh20 / standard.uh20 - 1)).toBeLessThan(.1)
    expect(Math.abs(large.rain40 / standard.rain40 - 1)).toBeLessThan(.2)
    expect(large.far40).toBeLessThan(standard.far40 / 2)
  }, 3_000_000)
})
