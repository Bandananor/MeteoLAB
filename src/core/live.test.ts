import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, DEFAULT_GRID, liveSounding, parcelIndices, SCENARIOS } from '.'
import { SUMMER_DAY } from './fixtures'

const smallGrid = () => createGrid({ ...DEFAULT_GRID, nx: 16, ny: 12, width: 16 * 1200, depth: 12 * 1125 })

describe('live sounding', () => {
  it('is the starting environment before anything has happened', () => {
    const config = { ...SUMMER_DAY, ...SCENARIOS.find(s => s.name === 'Суточный ход')!.values }, model = new AtmosphereModel(config, smallGrid())
    const live = liveSounding(model), h = model.grid.height
    expect(live.quiet).toBe(1); expect(live.all).toBe(false)
    // Not at the inversion top (400 m, between two model levels): the model resolves its kink only to its levels.
    for (const z of [0, 200, 1000, 3000, 8000]) {
      expect(live.env.temperatureEnv(z)).toBeCloseTo(model.env.temperatureEnv(z), 1)
      expect(live.env.qEnv(z) / model.env.qEnv(z)).toBeCloseTo(1, 2)
      expect(live.env.windUV(z)[0]).toBeCloseTo(model.env.windUV(z)[0], 2)
    }
    const a = parcelIndices(live.env, h), b = parcelIndices(model.env, h)
    expect(Math.abs(a.sb.cape / b.sb.cape - 1)).toBeLessThan(.03)
    expect(Math.abs(a.sb.cin - b.sb.cin)).toBeLessThan(10)
  })

  it('leaves out the columns with cloud or a cold pool', () => {
    const model = new AtmosphereModel({ ...SUMMER_DAY, bubble: 0 }, smallGrid()), { layer, nz } = model.grid
    const before = liveSounding(model).env.temperatureEnv(0)
    // A "storm" in the first 20 columns: much colder air under cloud, and an outflow next to it.
    for (let c = 0; c < 20; c++) { for (let k = 0; k < nz; k++) model.theta[c + k * layer] -= 8; model.cloud[c + 5 * layer] = 1e-3 }
    for (let c = 20; c < 30; c++) { model.theta[c] -= 8; model.cold[c] = 3 }
    const live = liveSounding(model)
    expect(live.quiet).toBeCloseTo((layer - 30) / layer, 6)
    expect(live.env.temperatureEnv(0)).toBeCloseTo(before, 3)
  })

  it('averages the whole domain when almost every column is stormy', () => {
    const model = new AtmosphereModel({ ...SUMMER_DAY, bubble: 0 }, smallGrid()), { layer } = model.grid
    for (let c = 0; c < layer; c++) model.cloud[c + 5 * layer] = 1e-3
    expect(liveSounding(model).all).toBe(true)
  })
})
