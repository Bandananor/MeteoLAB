import { describe, expect, it } from 'vitest'
import { createGrid, parseSounding, soundingProfile } from '../core'
import { STORM_DAYS } from './days'

describe('«Гроза дня» (roadmap M2)', () => {
  it('reads every day’s sounding to the model top, each with its story', () => {
    const grid = createGrid()
    expect(new Set(STORM_DAYS.map(d => d.id)).size).toBe(STORM_DAYS.length)
    for (const d of STORM_DAYS) {
      const file = parseSounding(d.text)
      expect(file.levels.length).toBeGreaterThan(10)
      expect(() => soundingProfile(file, grid.height + 2000)).not.toThrow()
      expect(d.title().length && d.observed().length && d.compare().length && d.profile().length && d.sources().length).toBeTruthy()
      expect(file.latitude ?? d.latitude).toBeDefined()
    }
  })
})
