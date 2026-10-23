import { describe, expect, it } from 'vitest'
import { AtmosphereModel, applyState, decodeFrame, DT, encodeFrame, frameIndex, framesHeader, readFramesHeader, RECORD_HEAD, STATE_COLUMNS, STATE_FIELDS } from '.'
import { SUMMER_DAY } from './fixtures'

describe('light frames of a precise run (frames.ts, roadmap C2)', () => {
  it('a frame decodes to the fields within a byte of each level\'s range, weak rain kept, and the columns exactly', async () => {
    const m = new AtmosphereModel({ ...SUMMER_DAY })
    for (let k = 0; k < 5; k++) { m.step(DT); m.time += DT }
    // Rain from 1e-6 to 5e-3 kg/kg in a corner (weak echo next to a core), negative charge, a ground total.
    const { layer, nz } = m.grid
    for (let z = 0; z < nz; z++) for (let c = 0; c < 200; c++) { m.rain[c + z * layer] = 1e-6 * 5000 ** (c / 199); m.chargeAir[c + z * layer] = (c - 100) * 1e-10 }
    m.precipitation[7] = 12.34; m.rotation.persisted = 321; m.flashCount = { ic: 5, cg: 2 }
    const record = await encodeFrame(m), view = new DataView(record.buffer)
    expect(view.getFloat32(4, true)).toBeCloseTo(m.time, 3)
    const state = await decodeFrame(record.slice(RECORD_HEAD), { format: 'meteolab-frames', version: 1, config: m.config, nx: m.grid.nx, ny: m.grid.ny, nz, every: 30 })
    expect(state.header).toMatchObject({ time: m.time, persisted: 321, flashCount: { ic: 5, cg: 2 } })
    const copy = new AtmosphereModel({ ...SUMMER_DAY })
    applyState(copy, state)
    for (const key of STATE_FIELDS) {
      const a = m[key], b = copy[key]
      for (let z = 0; z < nz; z += 7) {
        let lo = Infinity, hi = -Infinity, err = 0
        for (let i = z * layer; i < (z + 1) * layer; i++) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); err = Math.max(err, Math.abs(a[i] - b[i])) }
        // Linear: half a step of 1/255 of the range; rooted: the step of the root near the top.
        expect(err, `${key} at level ${z}`).toBeLessThanOrEqual((hi - lo) / 255 + 1e-6 * Math.max(1, Math.abs(hi)))
      }
    }
    // Weak rain (1e-6 kg/kg) survives beside 5e-3: within 30 %, not rounded to zero.
    expect(copy.rain[0]).toBeGreaterThan(.7e-6); expect(copy.rain[0]).toBeLessThan(1.3e-6)
    for (const key of STATE_COLUMNS) expect(Array.from(copy[key])).toEqual(Array.from(m[key]))
    // Size: a byte a node, then gzip.
    expect(record.length).toBeLessThan(STATE_FIELDS.length * m.grid.n * .6)
  })

  it('the file\'s header and the index of its records; a record cut short at the end is left out', async () => {
    const m = new AtmosphereModel({ ...SUMMER_DAY }), head = framesHeader(m.config, m.grid, 30), records: Uint8Array[] = []
    for (let k = 0; k < 3; k++) { records.push(await encodeFrame(m)); for (let s = 0; s < 10; s++) { m.step(DT); m.time += DT } }
    const cut = records[2].slice(0, 20), file = new Uint8Array([...head, ...records[0], ...records[1], ...cut])
    const { header, start } = readFramesHeader(file)
    expect(header).toMatchObject({ format: 'meteolab-frames', nx: 40, ny: 32, nz: 50, every: 30 })
    const index = await frameIndex(async (o, n) => file.slice(o, o + n), file.length, start)
    expect(index.map(f => f.time)).toEqual([0, 30])
    const second = await decodeFrame(file.slice(index[1].offset, index[1].offset + index[1].length), header)
    expect(second.header.time).toBe(30)
    expect(() => readFramesHeader(new Uint8Array(16))).toThrow()
  })
})
