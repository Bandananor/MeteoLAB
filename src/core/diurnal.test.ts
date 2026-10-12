import { describe, expect, it } from 'vitest'
import { AtmosphereModel, CellTracker, DT, liveSounding, parcelIndices, SCENARIOS, type SimConfig } from '.'
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
    const cinAt = () => parcelIndices(liveSounding(model).env, model.grid.height).sb.cin, dawnCin = cinAt()
    let firstCloud = NaN, firstStorm = NaN, quietW = 0, lateCin = NaN
    for (let t = DT; t <= 9 * 3600 && Number.isNaN(firstStorm); t += DT) {
      model.step(DT); model.time += DT
      if (t % 60) continue
      const d = model.diagnostics(), hour = hourOf(config, t)
      if (hour < 10) quietW = Math.max(quietW, d.updraft)
      // The live sounding: by 11:00 the sun has removed the dawn's CIN (calibration run: 119 J/kg at dawn, 8 at 11:15).
      if (t === 5 * 3600) lateCin = cinAt()
      if (Number.isNaN(firstCloud) && d.maxCloud > 1e-4) firstCloud = hour
      cells.update(model)
      if (cells.cells.length) firstStorm = hour
    }
    console.log(`Суточный ход: SB CIN of the live sounding ${dawnCin.toFixed(0)} J/kg at dawn, ${lateCin.toFixed(0)} at 11:00, strongest updraught before 10:00 ${quietW.toFixed(1)} m/s, first cumulus ${firstCloud.toFixed(2)} h, first thunderstorm ${firstStorm.toFixed(2)} h, clipped ${model.clipped}`)
    expect(model.clipped).toBe(0)
    // Before 10:00 only the dry eddies of the growing mixed layer (a few m/s), no cloud.
    expect(quietW).toBeLessThan(6)
    expect(dawnCin).toBeGreaterThan(100)
    expect(lateCin).toBeLessThan(25)
    expect(firstCloud).toBeGreaterThanOrEqual(10)
    expect(firstCloud).toBeLessThan(13)
    expect(firstStorm).toBeGreaterThanOrEqual(11)
    expect(firstStorm).toBeLessThan(14)
  }, 3_600_000)

  // The loaded gun (2.1): from 09:00 under a 3 K lid with ~3 kJ/kg of CAPE below it and no thermal. The towers that
  // grow from midday die under the lid; only in the afternoon does the heating of the day break through, at once into a
  // violent storm. Calibration run 2026-10-12 (tests/bench/scout.ts «gun4»): towers to 9-10 km at w 10-24 m/s from
  // 12:10, w >= 30 m/s at 14:55, then 47-63 m/s, gusts 33 m/s, the first rain at the ground ~15:20. Slow (~30 min on a
  // laptop: seven and a half simulated hours).
  it.runIf(slow)('loaded gun: the lid holds through midday, then the heating breaks it into a violent storm in the afternoon', () => {
    const scenario = SCENARIOS.find(s => s.name === 'Заряженное ружьё')!, config: SimConfig = { ...SUMMER_DAY, ...scenario.values }
    const model = new AtmosphereModel(config)
    let middayW = 0, fired = NaN, firstRain = NaN, maxW = 0, gust = 0
    for (let t = DT; t <= 8 * 3600; t += DT) {
      model.step(DT); model.time += DT
      if (t % 60) continue
      const d = model.diagnostics(), hour = hourOf(config, t)
      if (hour < 13) middayW = Math.max(middayW, d.updraft)
      if (Number.isNaN(fired) && d.updraft >= 30) fired = hour
      if (Number.isNaN(firstRain) && d.rainTotal >= .5) firstRain = hour
      if (!Number.isNaN(fired)) { maxW = Math.max(maxW, d.updraft); gust = Math.max(gust, d.gust) }
      if (hour >= fired + 1) break
    }
    console.log(`Заряженное ружьё: strongest updraught before 13:00 ${middayW.toFixed(1)} m/s, w >= 30 m/s at ${fired.toFixed(2)} h, first rain ${firstRain.toFixed(2)} h, then w up to ${maxW.toFixed(1)} m/s, gusts ${gust.toFixed(1)} m/s, clipped ${model.clipped}`)
    expect(model.clipped).toBe(0)
    // Before 13:00 only towers dying under the lid.
    expect(middayW).toBeLessThan(25)
    expect(fired).toBeGreaterThanOrEqual(14); expect(fired).toBeLessThan(16.5)
    expect(firstRain).toBeGreaterThan(fired - .5)
    // The break-through is violent: the updraught near parcel theory and a gust front.
    expect(maxW).toBeGreaterThan(40); expect(gust).toBeGreaterThan(20)
  }, 5_400_000)
})
