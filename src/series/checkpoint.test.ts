import { describe, expect, it } from 'vitest'
import type { MemberResult } from '../ensemble/member'
import { checkpointHeader, checkpointLine, readCheckpoint, seriesFingerprint } from './checkpoint'

const result = (seed: number): MemberResult => ({
  seed, nx: 3, ny: 2, width: 3600, depth: 2250,
  samples: [{ t: 60, updraft: 12.5, uh: 40, rain: 3, gust: 9, hail: 0, flashes: 0, rotationHeld: 0, cores: 1, outflow: 1.25 }],
  rainTotal: Float32Array.of(0, 1.1, 2.2, 3.3, 4.4, Math.PI), hailSize: new Float32Array(6), gustMax: Float32Array.of(1e-7, 5, 6, 7, 8, 9), uhMax: new Float32Array(6).fill(250.5),
})

describe('series checkpoint (tools/series.ts resume)', () => {
  const text = '{"scenario":"Летний день","vary":[["shear_0_6km_ms",[0,20]]],"seeds":[1,2]}'

  it('gives back each kept run bit for bit and skips a torn last line', () => {
    const file = [checkpointHeader(text, 4, 'v2.10.1'), checkpointLine(2, result(7)), checkpointLine(0, result(8)), checkpointLine(3, result(9)).slice(0, 40)].join('\n')
    const read = readCheckpoint(file, text, 4)
    if ('error' in read) throw new Error(read.error)
    expect(read.header.version).toBe('v2.10.1')
    expect([...read.results.keys()].sort()).toEqual([0, 2])
    const r = read.results.get(2)!
    expect(r.seed).toBe(7); expect(r.samples).toEqual(result(7).samples)
    expect(r.rainTotal).toBeInstanceOf(Float32Array)
    expect(Array.from(r.rainTotal)).toEqual(Array.from(result(7).rainTotal))
    expect(Array.from(r.gustMax)).toEqual(Array.from(result(7).gustMax))
    expect(Array.from(r.uhMax)).toEqual(Array.from(result(7).uhMax))
  })

  it('refuses a checkpoint of another series file or another number of runs', () => {
    const file = checkpointHeader(text, 4, 'v') + '\n'
    expect(readCheckpoint(file, text + ' ', 4)).toHaveProperty('error')
    expect(readCheckpoint(file, text, 5)).toHaveProperty('error')
    expect(readCheckpoint('{"a":1}', text, 4)).toHaveProperty('error')
    expect(seriesFingerprint(text)).toMatch(/^[0-9a-f]{8}$/)
  })
})
