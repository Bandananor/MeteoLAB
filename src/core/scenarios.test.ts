import { describe, expect, it } from 'vitest'
import { createGrid, Environment, parcelIndices, SCENARIOS, type SimConfig } from '.'
import { SUMMER_DAY } from './fixtures'
import { CASES, passes, SHORT_SCENARIOS as SHORT } from '../validation/cases'

// STORMLAB_MICRO=warm runs the scenarios with Kessler warm rain; STORMLAB_SCENARIO=<index> runs only that scenario of
// SHORT (the CI workflow runs each in its own job, in parallel). The scenarios without a thermal start from the morning
// and take hours of heating (diurnal.test.ts checks them).
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const micro = env.STORMLAB_MICRO as SimConfig['microphysics'], only = env.STORMLAB_SCENARIO
const selected = only ? [SHORT[Number(only)]] : SHORT
const config = (values: Partial<SimConfig>): SimConfig => ({ ...SUMMER_DAY, ...values, ...(micro ? { microphysics: micro } : {}) })

describe('scenarios: realistic environments', () => {
  // The ~1 km model gets close to parcel theory (w ~0.7-0.8 sqrt(2 CAPE), real storms ~0.5-0.6): scenarios keep SB CAPE
  // at most 4 kJ/kg so their updraughts stay near the strongest observed ones.
  for (const s of SCENARIOS.filter(s => !s.values.profile)) it(`${s.name}: SB CAPE at most 4 kJ/kg`, () => {
    const grid = createGrid(), i = parcelIndices(new Environment(config(s.values), grid), grid.height)
    expect(i.sb.cape).toBeLessThan(4000)
  })
})

// Slow (~10 min per scenario on a laptop: 40 simulated minutes each): `npm run test:scenarios`, or in the cloud
// (.github/workflows/slow-tests.yml, all scenarios in parallel). The run and its checks: src/validation/cases.ts.
const slow = (import.meta as { env?: { MODE?: string } }).env?.MODE === 'slow'

describe('scenarios: rotation only where a supercell is intended (calibration)', () => {
  for (const s of selected) it.runIf(slow)(`${s.name}: ${s.mesocyclone === undefined ? 'no limiter hits' : s.mesocyclone ? 'a mesocyclone persists' : 'no mesocyclone'}`, () => {
    const c = CASES.find(x => x.id === `scenario-${SHORT.indexOf(s)}`)!, r = c.run(), [clipped, w, meso] = r.checks
    console.log(`${s.name}: max w ${w.value.toFixed(1)} m/s, mesocyclone ${meso.value} s, ${r.note} clipped ${clipped.value}`)
    expect(r.checks.filter(x => !passes(x)).map(x => `${x.quantity} = ${x.value}`)).toEqual([])
  }, 900_000)
})
