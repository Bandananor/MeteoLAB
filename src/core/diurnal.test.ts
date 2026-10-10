import { describe, expect, it } from 'vitest'
import { AtmosphereModel, CellTracker, DT, SCENARIOS, type SimConfig } from '.'
import { SUMMER_DAY } from './fixtures'

// The release 2.0 diurnal-cycle minimum: the «Суточный ход» scenario starts at dawn (06:00) under a night inversion
// with no thermal. Nothing may grow before the sun has burnt the inversion off; the first cumulus and the first
// thunderstorm (a numbered cell: deep convection, see cells.ts) must come at sensible times of day. Slow (~15-25 min on
// a laptop: six simulated hours, the storms the costliest): `npm run test:diurnal`, or in the cloud
// (.github/workflows/slow-tests.yml). Calibration run 2026-10-10: first cumulus 11:57, first thunderstorm 12:31.
const slow = (import.meta as { env?: { MODE?: string } }).env?.MODE === 'slow'
const hourOf = (config: SimConfig, time: number) => config.hour + time / 3600

describe('diurnal cycle', () => {
  it.runIf(slow)('nothing before the sun burns the inversion off, then cumulus and a thunderstorm at sensible hours', () => {
    const scenario = SCENARIOS.find(s => s.name === 'Суточный ход')!, config: SimConfig = { ...SUMMER_DAY, ...scenario.values }
    const model = new AtmosphereModel(config), cells = new CellTracker()
    let firstCloud = NaN, firstStorm = NaN, quietW = 0
    for (let t = DT; t <= 9 * 3600 && Number.isNaN(firstStorm); t += DT) {
      model.step(DT); model.time += DT
      if (t % 60) continue
      const d = model.diagnostics(), hour = hourOf(config, t)
      if (hour < 10) quietW = Math.max(quietW, d.updraft)
      if (Number.isNaN(firstCloud) && d.maxCloud > 1e-4) firstCloud = hour
      cells.update(model)
      if (cells.cells.length) firstStorm = hour
    }
    console.log(`Суточный ход: strongest updraught before 10:00 ${quietW.toFixed(1)} m/s, first cumulus ${firstCloud.toFixed(2)} h, first thunderstorm ${firstStorm.toFixed(2)} h, clipped ${model.clipped}`)
    expect(model.clipped).toBe(0)
    // Before 10:00 only the dry eddies of the growing mixed layer (a few m/s), no cloud.
    expect(quietW).toBeLessThan(6)
    expect(firstCloud).toBeGreaterThanOrEqual(10)
    expect(firstCloud).toBeLessThan(13)
    expect(firstStorm).toBeGreaterThanOrEqual(11)
    expect(firstStorm).toBeLessThan(14)
  }, 3_600_000)
})
