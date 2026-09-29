import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, Environment, MESO_PERSISTENCE, parcelIndices, SCENARIOS, type SimConfig } from '.'
import { SUMMER_DAY } from './fixtures'

const config = (values: Partial<SimConfig>): SimConfig => ({ ...SUMMER_DAY, ...values })

describe('scenarios: realistic environments', () => {
  // The ~1 km model gets close to parcel theory: SB CAPE above ~4 kJ/kg drives updraughts into the 60 m/s limiter.
  for (const s of SCENARIOS.filter(s => !s.values.profile)) it(`${s.name}: SB CAPE at most 4 kJ/kg`, () => {
    const grid = createGrid(), i = parcelIndices(new Environment(config(s.values), grid), grid.height)
    expect(i.sb.cape).toBeLessThan(4000)
  })

  it('Заряженное ружьё is capped: ML CIN over 100 J/kg', () => {
    const s = SCENARIOS.find(s => s.name === 'Заряженное ружьё')!, grid = createGrid()
    expect(parcelIndices(new Environment(config(s.values), grid), grid.height).ml.cin).toBeGreaterThan(100)
  })
})

// Slow (~25 min: 40 simulated minutes per scenario, WENO for the sheared ones): `npm run test:slow`.
const slow = (import.meta as { env?: { MODE?: string } }).env?.MODE === 'slow'

describe('scenarios: rotation only where a supercell is intended (calibration)', () => {
  for (const s of SCENARIOS) it.runIf(slow)(`${s.name}: ${s.mesocyclone === undefined ? 'no limiter hits' : s.mesocyclone ? 'a mesocyclone persists' : 'no mesocyclone'}`, () => {
    const model = new AtmosphereModel(config(s.values))
    let longest = 0
    for (let t = 0; t < 40 * 60; t++) { model.step(1); model.time += 1; longest = Math.max(longest, model.rotation.persisted) }
    expect(model.clipped).toBe(0)
    if (s.mesocyclone === true) expect(longest).toBeGreaterThanOrEqual(MESO_PERSISTENCE)
    if (s.mesocyclone === false) expect(longest).toBeLessThan(MESO_PERSISTENCE)
  }, 900_000)
})
