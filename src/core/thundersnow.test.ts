import { describe, expect, it } from 'vitest'
import { createGrid, elevatedSnowSounding, Environment, environmentProfile, parcelIndices, SCENARIOS } from '.'
import { SUMMER_DAY } from './fixtures'

describe('the elevated thundersnow scenario (13.11.2026)', () => {
  const s = SCENARIOS.find(x => x.name === 'Снежная гроза')!, config = { ...SUMMER_DAY, ...s.values }, grid = createGrid()
  const env = new Environment(config, grid, environmentProfile(config, grid.height)), k = parcelIndices(env, grid.height)
  const levels = elevatedSnowSounding()

  it('keeps every level below 0 °C, so the snow does not melt on its way down', () => {
    expect(Math.max(...levels.map(l => l.t))).toBeLessThan(0)
  })
  it('is unstable only above the cold layer: SB CAPE 0, MU CAPE ~160 J/kg from above 1 km', () => {
    expect(k.sb.cape).toBeLessThan(1)
    expect(k.mu.cape).toBeGreaterThan(100); expect(k.mu.cape).toBeLessThan(250)
    expect(k.mu.start).toBeGreaterThan(1)
  })
  it('has its -10 °C level above ~1.8 km, where winter storms electrify (Kitagawa & Michimoto 1994)', () => {
    expect(levels.find(l => l.t <= -10)!.z).toBeGreaterThan(1800)
  })
  it('starts by a weak nudging of the updraught, one storm, no sun', () => {
    expect(s.values).toMatchObject({ start: 'nudge', nudge: 5, single: true, solarMax: 0 })
  })
})
