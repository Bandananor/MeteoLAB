import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, DEFAULT_GRID, type SimConfig } from '.'

const summerDay: SimConfig = {
  surfaceTemp: 30, lapseLow: 8.4, lapseMid: 7.2, lapseUpper: 6.5, tropopause: 11, stratoWarming: 1.2,
  rhSurface: 72, rhLow: 60, rhMid: 42, rhUpper: 28, entrainment: .65,
  wind0: 2, wind3: 10, wind6: 20, wind10: 28, windDir0: 160, windDir3: 185, windDir6: 215, windDir10: 235,
  latitude: 45, turbulence: .55, hour: 13.5, solarMax: 900, soilMoisture: 45, surfaceType: 'grass',
  precipEfficiency: .85, evaporation: 1, coldPoolStrength: 1, speed: 8, seed: 42, bubble: 1,
}

const fields = ['u', 'v', 'w', 'theta', 'q', 'cloud', 'rain', 'cold', 'pressure'] as const
const allFinite = (m: AtmosphereModel) => fields.every(f => m[f].every(Number.isFinite))
const run = (m: AtmosphereModel, steps: number) => { for (let k = 0; k < steps; k++) { m.step(1); m.time += 1 } }

describe('AtmosphereModel', () => {
  it('runs without a browser on the default grid', () => {
    const m = new AtmosphereModel({ ...summerDay })
    run(m, 120)
    expect(allFinite(m)).toBe(true)
    expect(m.sounding.cape).toBeGreaterThan(0)
  })

  it('takes the grid size as a parameter', () => {
    const grid = createGrid({ nx: 20, ny: 16, nz: 12, width: 24_000, depth: 18_000, height: 15_000 })
    const m = new AtmosphereModel({ ...summerDay }, grid)
    expect(m.u.length).toBe(20 * 16 * 12)
    expect(m.uhColumn.length).toBe(20 * 16)
    run(m, 60)
    expect(allFinite(m)).toBe(true)
  })

  it('is deterministic for a given seed', () => {
    const a = new AtmosphereModel({ ...summerDay }), b = new AtmosphereModel({ ...summerDay })
    run(a, 60); run(b, 60)
    for (const f of fields) expect(a[f]).toEqual(b[f])
  })

  it('uses the documented default grid spacing', () => {
    const g = createGrid(DEFAULT_GRID)
    expect([g.dx, g.dy]).toEqual([1200, 1125])
    expect(g.dz).toBeCloseTo(15_000 / 23)
  })
})
