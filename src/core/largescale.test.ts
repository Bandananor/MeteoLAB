import { describe, expect, it } from 'vitest'
import { advected, advectedProfile, AtmosphereModel, createGrid, DEFAULT_GRID, DT, Environment, environmentProfile, layerShare, parcelIndices, timeShare } from '.'
import { QUIET, SUMMER_DAY } from './fixtures'

const grid = createGrid(DEFAULT_GRID)

describe('large-scale advection (2.6)', () => {
  it('a change covers its layer, fades out over 500 m beyond it and comes at a steady rate', () => {
    const c = { quantity: 'temperature' as const, bottom: 3, top: 6, amount: -2, start: 1, hours: 2 }
    expect(layerShare(c, 4500)).toBe(1); expect(layerShare(c, 2750)).toBeCloseTo(.5); expect(layerShare(c, 6250)).toBeCloseTo(.5); expect(layerShare(c, 1000)).toBe(0)
    expect(layerShare({ bottom: 0, top: 1 }, 0)).toBe(1)
    expect(timeShare(c, 3600)).toBe(0); expect(timeShare(c, 2 * 3600)).toBeCloseTo(.5); expect(timeShare(c, 5 * 3600)).toBe(1)
    expect(advected([c, { ...c, quantity: 'moisture', amount: 3 }], 4500, 2 * 3600)).toEqual([-1, .0015])
    expect(advected(undefined, 0, 1e4)).toEqual([0, 0])
  })

  it('the environment ahead: moisture in the lowest kilometre gives more CAPE, cold aloft more, warmth just above the cloud base more CIN', () => {
    const env = new Environment(SUMMER_DAY, grid, environmentProfile(SUMMER_DAY, grid.height))
    const sb = (changes: Parameters<typeof advectedProfile>[1], hours = 2) => parcelIndices(new Environment(SUMMER_DAY, grid, advectedProfile(env, changes, hours * 3600)), grid.height).sb
    const base = parcelIndices(env, grid.height).sb, same = sb([])
    expect(Math.abs(same.cape - base.cape)).toBeLessThan(.03 * base.cape + 20)
    const moist = sb([{ quantity: 'moisture', bottom: 0, top: 1, amount: 2, start: 0, hours: 2 }])
    const cold = sb([{ quantity: 'temperature', bottom: 4, top: 9, amount: -3, start: 0, hours: 2 }])
    const lid = sb([{ quantity: 'temperature', bottom: .5, top: 1.5, amount: 3, start: 0, hours: 2 }])
    expect(moist.cape).toBeGreaterThan(base.cape + 300); expect(cold.cape).toBeGreaterThan(base.cape + 300)
    expect(lid.cin).toBeGreaterThan(base.cin + 40)
    // Half-way through, about half of it.
    const half = sb([{ quantity: 'moisture', bottom: 0, top: 1, amount: 2, start: 0, hours: 2 }], 1)
    expect(half.cape).toBeGreaterThan(base.cape + 100); expect(half.cape).toBeLessThan(moist.cape - 100)
  })

  it('in the model the whole layer warms by the change, the air outside it does not, and the warmth is not buoyancy', () => {
    const small = createGrid({ ...DEFAULT_GRID, nx: 20, ny: 16, width: 24_000, depth: 18_000 })
    const minutes = 3, change = { quantity: 'temperature' as const, bottom: 3, top: 6, amount: 2, start: 0, hours: minutes / 60 }
    const m = new AtmosphereModel({ ...QUIET, followStorm: false, largeScale: [change, { ...change, quantity: 'moisture', bottom: 0, top: 1, amount: 1 }] }, small)
    const still = new AtmosphereModel({ ...QUIET, followStorm: false }, small)
    for (let k = 0; k < minutes * 60 / DT + 2; k++) { m.step(DT); m.time += DT; still.step(DT); still.time += DT }
    const { zs, layer } = small, level = (z: number) => zs.findIndex(h => h >= z)
    const mean = (field: Float32Array, z: number) => { let s = 0; for (let i = z * layer; i < (z + 1) * layer; i++) s += field[i]; return s / layer }
    const warm = (z: number) => (mean(m.theta, z) - mean(still.theta, z)) * m.env.exner[z]
    expect(warm(level(4500))).toBeCloseTo(2, 1); expect(Math.abs(warm(level(1000)))).toBeLessThan(.05); expect(Math.abs(warm(level(8000)))).toBeLessThan(.05)
    expect((mean(m.q, 0) - mean(still.q, 0)) * 1000).toBeCloseTo(1, 1)
    // The reference moved with the air: no layer-wide updraught.
    let wMax = 0; for (let i = 0; i < m.w.length; i++) wMax = Math.max(wMax, Math.abs(m.w[i] - still.w[i]))
    expect(wMax).toBeLessThan(.05)
    expect(m.envNow(level(4500))[0] - m.env.theta[level(4500)]).toBeCloseTo(2 / m.env.exner[level(4500)], 2)
  })
})
