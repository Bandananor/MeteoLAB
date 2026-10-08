import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, Environment, MESO_PERSISTENCE, parcelIndices, SCENARIOS, type SimConfig } from '.'
import { SUMMER_DAY } from './fixtures'

// STORMLAB_MICRO=warm runs the scenarios with Kessler warm rain; STORMLAB_SCENARIO=<index> runs only that scenario of
// SCENARIOS (the CI workflow runs each in its own job, in parallel).
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const micro = env.STORMLAB_MICRO as SimConfig['microphysics'], only = env.STORMLAB_SCENARIO
const selected = only ? [SCENARIOS[Number(only)]] : SCENARIOS
const config = (values: Partial<SimConfig>): SimConfig => ({ ...SUMMER_DAY, ...values, ...(micro ? { microphysics: micro } : {}) })

describe('scenarios: realistic environments', () => {
  // The ~1 km model gets close to parcel theory (w ~0.7-0.8 sqrt(2 CAPE), real storms ~0.5-0.6): scenarios keep SB CAPE
  // at most 4 kJ/kg so their updraughts stay near the strongest observed ones.
  for (const s of SCENARIOS.filter(s => !s.values.profile)) it(`${s.name}: SB CAPE at most 4 kJ/kg`, () => {
    const grid = createGrid(), i = parcelIndices(new Environment(config(s.values), grid), grid.height)
    expect(i.sb.cape).toBeLessThan(4000)
  })

  it('Заряженное ружьё is capped: ML CIN over 100 J/kg', () => {
    const s = SCENARIOS.find(s => s.name === 'Заряженное ружьё')!, grid = createGrid()
    expect(parcelIndices(new Environment(config(s.values), grid), grid.height).ml.cin).toBeGreaterThan(100)
  })
})

// Slow (~10 min per scenario on a laptop: 40 simulated minutes each): `npm run test:scenarios`, or in the cloud
// (.github/workflows/slow-tests.yml, all scenarios in parallel).
const slow = (import.meta as { env?: { MODE?: string } }).env?.MODE === 'slow'

describe('scenarios: rotation only where a supercell is intended (calibration)', () => {
  for (const s of selected) it.runIf(slow)(`${s.name}: ${s.mesocyclone === undefined ? 'no limiter hits' : s.mesocyclone ? 'a mesocyclone persists' : 'no mesocyclone'}`, () => {
    const model = new AtmosphereModel(config(s.values))
    let longest = 0, maxW = 0, maxUH = 0, gust = 0
    // Strongest wind over the ground at the 100 m level (outflow, microburst gusts).
    const { layer, zs } = model.grid, near = zs.findIndex(z => z >= 100) * layer, [fu, fv] = model.frame
    for (let t = 0; t < 40 * 60; t++) {
      model.step(1); model.time += 1; longest = Math.max(longest, model.rotation.persisted); maxUH = Math.max(maxUH, model.rotation.uh)
      if (t % 60 === 0) maxW = Math.max(maxW, model.diagnostics().updraft)
      if (t % 30 === 0) for (let c = 0; c < layer; c++) gust = Math.max(gust, Math.hypot(model.u[near + c] + fu, model.v[near + c] + fv))
    }
    console.log(`${s.name}: max w ${maxW.toFixed(1)} m/s, max UH ${maxUH.toFixed(0)}, mesocyclone ${longest} s, wind at 100 m ${gust.toFixed(1)} m/s, rain ${Math.max(...model.precipitation).toFixed(1)} mm, hail ${(Math.max(...model.hailSize) / 10).toFixed(1)} cm / ${Math.max(...model.hailGround).toFixed(1)} mm, clipped ${model.clipped}`)
    expect(model.clipped).toBe(0)
    if (s.mesocyclone === true) expect(longest).toBeGreaterThanOrEqual(MESO_PERSISTENCE)
    if (s.mesocyclone === false) expect(longest).toBeLessThan(MESO_PERSISTENCE)
  }, 900_000)
})
