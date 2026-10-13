import { describe, expect, it } from 'vitest'
import { AtmosphereModel, contour, createGrid, DEFAULT_GRID, isobarStep, pressureCentres, stationPlots, surfacePressureField } from '.'
import { QUIET } from './fixtures'

describe('the surface analysis (2.6)', () => {
  it('contours of a cone are a closed ring at the right distance', () => {
    const nx = 21, ny = 21, field = Float64Array.from({ length: nx * ny }, (_, i) => 10 - Math.hypot(i % nx - 10, Math.floor(i / nx) - 10))
    const segs = contour(field, nx, ny, 4.5)
    expect(segs.length).toBeGreaterThan(20)
    for (const [x1, y1, x2, y2] of segs) { expect(Math.hypot(x1 - 10, y1 - 10)).toBeCloseTo(5.5, 0); expect(Math.hypot(x2 - 10, y2 - 10)).toBeCloseTo(5.5, 0) }
    // Every end point is shared by exactly two segments: the ring is closed.
    const key = (x: number, y: number) => `${x.toFixed(4)},${y.toFixed(4)}`, ends = new Map<string, number>()
    for (const [x1, y1, x2, y2] of segs) for (const k of [key(x1, y1), key(x2, y2)]) ends.set(k, (ends.get(k) ?? 0) + 1)
    expect([...ends.values()].every(n => n === 2)).toBe(true)
    expect(contour(field, nx, ny, 20)).toEqual([])
  })

  it('a high and a low are found where they are, a gentle slope gives none', () => {
    const nx = 30, ny = 20, bump = (x: number, y: number, cx: number, cy: number) => Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / 8)
    const field = Float64Array.from({ length: nx * ny }, (_, i) => { const x = i % nx, y = Math.floor(i / nx); return 1010 + 2 * bump(x, y, 8, 10) - 1.5 * bump(x, y, 21, 9) + .01 * x })
    const c = pressureCentres(field, nx, ny)
    expect(c).toHaveLength(2)
    expect(c.find(p => p.high)).toMatchObject({ x: 8, y: 10 }); expect(c.find(p => !p.high)).toMatchObject({ x: 21, y: 9 })
    expect(pressureCentres(Float64Array.from({ length: nx * ny }, (_, i) => 1010 + .01 * (i % nx)), nx, ny)).toEqual([])
    // A trough along y (as ahead of a front), with small dips along it: no low.
    const trough = Float64Array.from({ length: nx * ny }, (_, i) => { const x = i % nx, y = Math.floor(i / nx); return 1012 + .3 * Math.abs(x - 15) - .05 * Math.cos(y) })
    expect(pressureCentres(trough, nx, ny)).toEqual([])
    expect(isobarStep([1010, 1012])).toBe(.5); expect(isobarStep([1005, 1012])).toBe(1); expect(isobarStep([1000, 1015])).toBe(2)
  })

  it('a pool of cold air at the ground is a mesohigh on the chart; the stations read the cold and the base pressure', () => {
    const small = createGrid({ ...DEFAULT_GRID, nx: 20, ny: 16, width: 24_000, depth: 18_000 })
    const m = new AtmosphereModel({ ...QUIET, followStorm: false, bubble: 0 }, small), { nx, ny, layer, zs, dx, dy } = small
    // 5 K colder below 1 km in a disc of 4 km around (12, 9) km.
    for (let z = 0; zs[z] < 1000; z++) for (let c = 0; c < layer; c++) if (Math.hypot((c % nx) * dx - 12_000, Math.floor(c / nx) * dy - 9000) < 4000) m.theta[c + z * layer] -= 5
    const p = surfacePressureField(m), centres = pressureCentres(p, nx, ny, 3)
    const high = centres.find(c => c.high)!
    expect(high).toBeDefined(); expect(Math.abs(high.x * dx - 12_000)).toBeLessThanOrEqual(dx); expect(Math.abs(high.y * dy - 9000)).toBeLessThanOrEqual(dy)
    let lo = Infinity, hi = -Infinity; for (const v of p) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
    expect(hi - lo).toBeGreaterThan(1); expect(Math.abs((hi + lo) / 2 - m.env.p[0] / 100)).toBeLessThan(2)
    const plots = stationPlots(m, p, 6000)
    expect(plots).toHaveLength(4 * 3)
    const near = plots.find(s => Math.hypot(s.x - 9000, s.y - 9000) < 1)!, far = plots.find(s => s.x === 21_000 && s.y === 15_000)!
    expect(near.temp).toBeLessThan(far.temp - 3); expect(near.pressure).toBeGreaterThan(far.pressure)
    expect(far.dew).toBeLessThanOrEqual(far.temp); expect(far.rain).toBe(0); expect(far.thunder).toBe(false); expect(far.cloudy).toBe(false)
  })
})
