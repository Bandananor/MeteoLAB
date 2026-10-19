import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, DEFAULT_GRID, flankMask, mesocycloneColumn, outflowDeficit, stormFlanks } from '.'
import { QUIET } from './fixtures'

describe('the supercell’s flanks (2.8)', () => {
  it('names the downdraught ahead of the mesocyclone the FFD and the one behind and beside it the RFD', () => {
    const grid = createGrid({ ...DEFAULT_GRID, nx: 30, ny: 30, width: 30 * 1200, depth: 30 * 1200 })
    const model = new AtmosphereModel({ ...QUIET }, grid), { nx, layer, zs, dx } = model.grid, k = zs.findIndex(z => z >= 1500)
    // The mesocyclone at (15, 15); the storm moves east. Sinking at 1.5 km: 6 km ahead (FFD, under rain), 3 km south-west
    // (RFD, colder), 12 km behind (old outflow: neither).
    const meso = 15 + nx * 15, ahead = 20 + nx * 16, behind = 13 + nx * 13, far = 5 + nx * 15
    model.uhColumn[meso] = 500
    expect(mesocycloneColumn(model, 15 * dx + 1000, 15 * dx)).toBe(meso)
    model.w[ahead + k * layer] = -6; model.w[behind + k * layer] = -9; model.w[far + k * layer] = -5
    model.theta[behind] -= 4
    const rain = new Float32Array(layer); rain[ahead] = 80
    const f = stormFlanks(model, meso, 10, 0, rain, outflowDeficit(model))
    expect(f.ffd!.columns).toEqual([ahead]); expect(f.ffd!.down).toBeCloseTo(6, 5); expect(f.ffd!.rain).toBe(80)
    expect(f.ffd!.along).toBeCloseTo(5 * dx, 0); expect(f.ffd!.left).toBeGreaterThan(0)
    expect(f.rfd!.columns).toEqual([behind]); expect(f.rfd!.down).toBeCloseTo(9, 5); expect(f.rfd!.cold).toBeGreaterThan(3.5)
    expect(f.rfd!.along).toBeLessThan(0); expect(f.rfd!.left).toBeLessThan(0)
    const mask = flankMask(model.grid, f)
    expect([mask[ahead], mask[behind], mask[far], mask[meso]]).toEqual([1, 2, 0, 0])
    // Moving north instead, the same downdraught ahead-east is beside the mesocyclone: the RFD's.
    expect(stormFlanks(model, meso, 0, 10, rain, outflowDeficit(model)).rfd!.columns).toContain(ahead)
  })
})
