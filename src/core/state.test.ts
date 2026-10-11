import { describe, expect, it } from 'vitest'
import { applyState, AtmosphereModel, createGrid, DEFAULT_GRID, DT, readState, saveState } from '.'
import { run, SUMMER_DAY } from './fixtures'

const smallGrid = () => createGrid({ ...DEFAULT_GRID, nx: 16, ny: 12, width: 16 * 1200, depth: 12 * 1125 })

describe('saved state (.meteolab files)', () => {
  it('continues a run exactly where it was saved', () => {
    const config = { ...SUMMER_DAY, seed: 7 }, original = new AtmosphereModel(config, smallGrid())
    run(original, 600)
    const state = readState(saveState(original, config))
    expect(state.header.time).toBe(600)
    expect(state.header.config).toEqual(config)
    const restored = new AtmosphereModel(state.header.config as typeof config, smallGrid())
    applyState(restored, state)
    expect(restored.time).toBe(600)
    for (let k = 0; k < 5; k++) for (const m of [original, restored]) { m.step(DT); m.time += DT }
    let diff = 0
    for (let i = 0; i < original.w.length; i++) diff = Math.max(diff, Math.abs(original.w[i] - restored.w[i]), Math.abs(original.theta[i] - restored.theta[i]))
    expect(diff).toBe(0)
    expect(Array.from(restored.precipitation)).toEqual(Array.from(original.precipitation))
  })

  it('refuses what is not a state file, a cut one and a different grid', () => {
    expect(() => readState(new TextEncoder().encode('hello world, not a state').buffer)).toThrow('не файл состояния')
    const model = new AtmosphereModel({ ...SUMMER_DAY }, smallGrid()), buffer = saveState(model, { ...SUMMER_DAY })
    expect(() => readState(buffer.slice(0, buffer.byteLength - 4))).toThrow('размер файла')
    const other = new AtmosphereModel({ ...SUMMER_DAY }, createGrid({ ...DEFAULT_GRID, nx: 20, ny: 12, width: 24_000, depth: 12 * 1125 }))
    expect(() => applyState(other, readState(buffer))).toThrow('сетка файла')
  })
})
