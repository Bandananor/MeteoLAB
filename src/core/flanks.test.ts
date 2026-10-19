import { describe, expect, it } from 'vitest'
import { AtmosphereModel, anvilPoint, createGrid, DEFAULT_GRID, flankMask, INFLOW_DISTANCE, inflowPoint, mesocycloneColumn, outflowDeficit, stormFlanks } from '.'
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

  it('finds where the inflow comes from and where the anvil spreads, for the labels of the 3D view', () => {
    const grid = createGrid({ ...DEFAULT_GRID, nx: 40, ny: 30, width: 40 * 1200, depth: 30 * 1200 })
    const model = new AtmosphereModel({ ...QUIET, wind0: 0, wind05: 0, wind1: 0, wind3: 0, wind6: 0, wind10: 0 }, grid), { nx, layer, zs, dx } = model.grid
    const f = stormFlanks(model, 15 + nx * 15, 1, 0, new Float32Array(layer), outflowDeficit(model))
    // Calm air and a storm moving east at 10 m/s: relative to it the air comes from the east, so the inflow is east of it.
    const [ix, iy] = inflowPoint(model, f, [10, 0])
    expect(ix - 15 * dx).toBeCloseTo(INFLOW_DISTANCE, -1); expect(iy - 15 * dx).toBeCloseTo(0, -1)
    // A storm moving west at 10 m/s in calm air: at the anvil's level the wind relative to it blows east, so the anvil
    // spreads east. Ice at ~10 km in the columns 8-15 km east of it: the label halfway out, at its level; none without ice.
    expect(anvilPoint(model, f, [-10, 0])).toBeNull()
    const k = zs.findIndex(z => z >= 10_000)
    for (let x = 21; x <= 28; x++) for (let y = 13; y <= 17; y++) model.ice[x + nx * y + k * layer] = 2e-4
    const a = anvilPoint(model, f, [-10, 0])!
    expect((a.x - 15 * dx) / 1000).toBeGreaterThan(10); expect((a.x - 15 * dx) / 1000).toBeLessThan(13); expect(Math.abs(a.y - 15 * dx)).toBeLessThan(600); expect(a.z).toBe(zs[k])
  })
})
