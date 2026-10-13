import { describe, expect, it } from 'vitest'
import { applyState, AtmosphereModel, createGrid, DEFAULT_GRID, DT, readState, saveState } from '.'
import { QUIET, run, SUMMER_DAY } from './fixtures'

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

  it('keeps the storm charge: a run continued from a state flashes exactly as the original', () => {
    const config = { ...QUIET, seed: 7 }, original = new AtmosphereModel(config, smallGrid()), { nx, ny, nz, layer, zs, dx, dy } = original.grid
    // A charged cloud above the breakdown threshold (as in electrification.test.ts), a step so it has flashed.
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = x + y * nx + z * layer, r2 = ((x - nx / 2) * dx) ** 2 + ((y - ny / 2) * dy) ** 2, rho = original.env.rho[z]
      original.chargeIce[i] = 3e-9 * Math.exp(-r2 / 2500 ** 2 - ((zs[z] - 9000) / 700) ** 2) / rho
      original.chargeGraupel[i] = -3e-9 * Math.exp(-r2 / 2500 ** 2 - ((zs[z] - 6500) / 700) ** 2) / rho
    }
    original.step(DT); original.time += DT
    const buffer = saveState(original, config), restored = new AtmosphereModel(config, smallGrid())
    applyState(restored, readState(buffer))
    expect(restored.flashCount).toEqual(original.flashCount); expect(restored.chargeGround).toBe(original.chargeGround)
    const before = original.flashes.length
    expect(before).toBeGreaterThan(0)
    for (let k = 0; k < 3; k++) for (const m of [original, restored]) { m.step(DT); m.time += DT }
    expect(restored.flashes.map(f => [f.time, f.kind, f.charge])).toEqual(original.flashes.slice(before).map(f => [f.time, f.kind, f.charge]))
    expect(Array.from(restored.chargeGraupel)).toEqual(Array.from(original.chargeGraupel))
    // Back to the saved moment: the flashes after it are forgotten.
    applyState(original, readState(buffer))
    expect(original.flashes.length).toBe(before)
  })

  it('opens a version 1 file (before 2.3): no charge', () => {
    const config = { ...SUMMER_DAY }, model = new AtmosphereModel(config, smallGrid()), { n, layer } = model.grid
    const json = new TextEncoder().encode(JSON.stringify({ format: 'meteolab-state', version: 1, config, time: 60, persisted: 0, nx: 16, ny: 12, nz: model.grid.nz }))
    const start = Math.ceil((8 + json.length) / 4) * 4, buffer = new ArrayBuffer(start + (12 * n + 3 * layer) * 4), bytes = new Uint8Array(buffer)
    bytes.set(new TextEncoder().encode('MLAB')); new DataView(buffer).setUint32(4, json.length, true); bytes.set(json, 8)
    new Float32Array(buffer, start).fill(1)
    model.chargeIce.fill(5)
    applyState(model, readState(buffer))
    expect(model.time).toBe(60); expect(model.hail[0]).toBe(1)
    expect(model.chargeIce.every(c => c === 0)).toBe(true); expect(model.flashCount).toEqual({ ic: 0, cg: 0 })
  })

  it('refuses what is not a state file, a cut one and a different grid', () => {
    expect(() => readState(new TextEncoder().encode('hello world, not a state').buffer)).toThrow('не файл состояния')
    const model = new AtmosphereModel({ ...SUMMER_DAY }, smallGrid()), buffer = saveState(model, { ...SUMMER_DAY })
    expect(() => readState(buffer.slice(0, buffer.byteLength - 4))).toThrow('размер файла')
    const other = new AtmosphereModel({ ...SUMMER_DAY }, createGrid({ ...DEFAULT_GRID, nx: 20, ny: 12, width: 24_000, depth: 12 * 1125 }))
    expect(() => applyState(other, readState(buffer))).toThrow('сетка файла')
  })
})
