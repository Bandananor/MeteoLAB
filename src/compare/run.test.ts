import { describe, expect, it } from 'vitest'
import { MESO_PERSISTENCE, reflectivity, type SimConfig } from '../core'
import type { TimelinePoint } from '../timeline'
import { atTime, configChanges, echoDbz, echoMap, EchoMaps, MAP_EVERY, peaks } from './run'

const point = (t: number, o: Partial<TimelinePoint> = {}): TimelinePoint => ({ t, cape: 0, cin: 0, updraft: 0, uh: 0, rain: 0, rainTotal: 0, rotationHeld: 0, flashes: 0, gust: 0, hail: 0, ...o })

/** A 3 x 2 x 2 column model: rain in one cell of the lower layer, hail above another column. */
function model(time = 0) {
  const layer = 6, n = layer * 2, f = () => new Float32Array(n)
  const m = { grid: { nx: 3, ny: 2, nz: 2, layer, width: 3000, depth: 2000 }, env: { rho: [1.1, .9], exner: [1, .9] }, time, theta: f().fill(300), rain: f(), snow: f(), graupel: f(), hail: f() }
  m.rain[4] = 2e-3; m.hail[layer + 1] = 1e-3
  return m
}

describe('comparing runs (src/compare/run.ts)', () => {
  it('maps the strongest echo over each column, nothing where no precipitation', () => {
    const map = echoMap(model(120))
    expect([map.t, map.nx, map.ny, map.width, map.depth]).toEqual([120, 3, 2, 3000, 2000])
    expect(echoDbz(map.dbz[4])).toBeCloseTo(reflectivity(1.1, 2e-3, 0, 0, 300 - 273.15), 0)
    expect(echoDbz(map.dbz[1])).toBeCloseTo(reflectivity(.9, 0, 0, 0, 300 * .9 - 273.15, 1e-3), 0)
    expect([0, 2, 3, 5].map(c => echoDbz(map.dbz[c]))).toEqual([NaN, NaN, NaN, NaN])
  })

  it('keeps a map every MAP_EVERY model seconds, starts anew after a restart and drops the rewound ones', () => {
    const maps = new EchoMaps()
    for (let t = 0; t <= 600; t += 3) maps.record(model(t))
    expect(maps.maps.map(m => m.t)).toEqual(Array.from({ length: 600 / MAP_EVERY + 1 }, (_, k) => k * MAP_EVERY))
    maps.truncate(250); expect(maps.maps.at(-1)!.t).toBe(240)
    expect(maps.record(model(3))).toBe(true); expect(maps.maps.map(m => m.t)).toEqual([3])
  })

  it('finds the latest item at or before a time', () => {
    const items = [10, 20, 30].map(t => ({ t }))
    expect([5, 10, 19, 20, 29, 30, 99].map(t => atTime(items, t)!.t)).toEqual([10, 10, 10, 20, 20, 30, 30])
    expect(atTime([], 5)).toBeNull()
  })

  it('reads the highlights: peaks, the mesocyclone from when its rotation began, the first rain', () => {
    const pts = [point(0), point(600, { updraft: 20, rain: .5 }), point(1200, { updraft: 35, rain: 40, rotationHeld: 300, gust: 22 }), point(1800, { updraft: 30, rotationHeld: MESO_PERSISTENCE + 60, hail: 12, rainTotal: 8, flashes: 30 })]
    const p = peaks(pts)
    expect([p.updraft, p.rain, p.gust, p.hail, p.rainTotal, p.flashes, p.minutes]).toEqual([35, 40, 22, 12, 8, 30, 30])
    expect(p.mesocyclone).toBe(1800 - MESO_PERSISTENCE - 60); expect(p.firstRain).toBe(1200)
    expect(peaks([point(0)]).mesocyclone).toBeNull()
  })

  it('lists the settings that differ, but not the page’s speed', () => {
    const a = { surfaceTemp: 30, wind6: 20, speed: 4, seed: 1, zones: [{ x: 1 }] } as unknown as SimConfig
    expect(configChanges(a, { ...a, speed: 16 })).toEqual([])
    expect(configChanges(a, { ...a, wind6: 25, seed: 2, zones: [{ x: 1 }] } as unknown as SimConfig)).toEqual(['wind6', 'seed'])
    expect(configChanges(a, { ...a, capStrength: 2 })).toEqual(['capStrength'])
  })
})
