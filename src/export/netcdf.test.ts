import { describe, expect, it } from 'vitest'
import { AtmosphereModel, DT } from '../core'
import { SUMMER_DAY } from '../core/fixtures'
import { modelNetCDF } from './fields'
import { writeNetCDF } from './netcdf'

/** A small NetCDF classic reader: dimensions, attributes and each variable's type, shape and values (to check the writer). */
function readNetCDF(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), text = new TextDecoder()
  let at = 0
  const int = () => { const v = view.getInt32(at); at += 4; return v }
  const name = () => { const n = int(), s = text.decode(bytes.subarray(at, at + n)); at += (n + 3) & ~3; return s }
  const attrs = () => {
    const out: Record<string, unknown> = {}, tag = int(), n = int()
    if (!tag) return out
    for (let k = 0; k < n; k++) {
      const key = name(), type = int(), count = int(), size = { 2: 1, 4: 4, 5: 4, 6: 8 }[type]!
      if (type === 2) out[key] = text.decode(bytes.subarray(at, at + count))
      else out[key] = Array.from({ length: count }, (_, i) => type === 4 ? view.getInt32(at + i * 4) : type === 5 ? view.getFloat32(at + i * 4) : view.getFloat64(at + i * 8))
      at += (count * size + 3) & ~3
    }
    return out
  }
  expect(text.decode(bytes.subarray(0, 3))).toBe('CDF'); expect(bytes[3]).toBe(1); at = 4
  expect(int()).toBe(0)
  const dims: [string, number][] = []
  if (int()) { const n = int(); for (let k = 0; k < n; k++) dims.push([name(), int()]) } else int()
  const global = attrs(), vars: Record<string, { dims: string[]; attrs: Record<string, unknown>; values: number[] }> = {}
  if (int()) {
    const n = int()
    for (let k = 0; k < n; k++) {
      const v = name(), rank = int(), ids = Array.from({ length: rank }, () => int()), a = attrs(), type = int(), vsize = int(), begin = int()
      const count = ids.reduce((c, i) => c * dims[i][1], 1), size = { 4: 4, 5: 4, 6: 8 }[type]!
      expect(vsize).toBe((count * size + 3) & ~3)
      vars[v] = { dims: ids.map(i => dims[i][0]), attrs: a, values: Array.from({ length: count }, (_, i) => type === 4 ? view.getInt32(begin + i * 4) : type === 5 ? view.getFloat32(begin + i * 4) : view.getFloat64(begin + i * 8)) }
    }
  }
  return { dims: Object.fromEntries(dims), global, vars }
}

describe('NetCDF export (src/export)', () => {
  it('writes a classic file that reads back: dimensions, attributes, values', () => {
    const bytes = writeNetCDF({ dims: { z: 2, x: 3 }, attrs: { title: 'тест', seed: 7, offset: [1.5, -2] },
      vars: [{ name: 'f', dims: ['z', 'x'], type: 'float', data: [1, 2, 3, 4, 5, 6.5], attrs: { units: 'K' } }, { name: 'z', dims: ['z'], type: 'double', data: [0, 100] }] })
    const f = readNetCDF(bytes)
    expect(f.dims).toEqual({ z: 2, x: 3 }); expect(f.global).toEqual({ title: 'тест', seed: [7], offset: [1.5, -2] })
    expect(f.vars.f.values).toEqual([1, 2, 3, 4, 5, 6.5]); expect(f.vars.f.attrs.units).toBe('K'); expect(f.vars.z.values).toEqual([0, 100])
    expect(() => writeNetCDF({ dims: { x: 2 }, attrs: {}, vars: [{ name: 'g', dims: ['x'], type: 'float', data: [1] }] })).toThrow()
  })

  it('exports the model: ground-relative wind, fields in C order, base state, settings and seed', () => {
    const config = { ...SUMMER_DAY, seed: 12 }, m = new AtmosphereModel(config)
    for (let k = 0; k < 10; k++) { m.step(DT); m.time += DT }
    const f = readNetCDF(modelNetCDF(m, { version: 'test', seed: 12, scenario: 'Летний день', config }))
    const { nx, ny, nz } = m.grid
    expect(f.dims).toEqual({ time: 1, z: nz, y: ny, x: nx })
    expect(f.global.Conventions).toBe('CF-1.8'); expect(f.global.seed).toEqual([12]); expect(JSON.parse(f.global.settings_json as string).seed).toBe(12)
    expect(f.vars.theta.dims).toEqual(['time', 'z', 'y', 'x'])
    // Node (x 5, y 7, z 3): the model's index x + nx (y + ny z) is the file's C order.
    const i = 5 + nx * (7 + ny * 3)
    expect(f.vars.theta.values[i]).toBeCloseTo(m.theta[i], 4); expect(f.vars.w.values[i]).toBeCloseTo(m.w[i], 5)
    expect(f.vars.u.values[i]).toBeCloseTo(m.u[i] + m.frame[0], 4)
    expect(f.vars.z.values[3]).toBeCloseTo(m.grid.zs[3], 2); expect(f.vars.p0.values[0]).toBeCloseTo(m.env.p[0], -1)
    expect(Math.max(...f.vars.dbz.values)).toBeLessThan(80)
  })
})
