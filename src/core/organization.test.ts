import { describe, expect, it } from 'vitest'
import { classifyEcho, ORG } from '.'

const NX = 200, NY = 200, D = 1
/** A dBZ field with `paint(x, y)` over the background, km. */
const field = (paint: (x: number, y: number) => number) => { const f = new Float32Array(NX * NY).fill(-20); for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) f[x + NX * y] = paint(x, y); return f }
const blob = (x: number, y: number, cx: number, cy: number, r: number, peak = 55) => Math.hypot(x - cx, y - cy) < r ? peak : -20

describe('the organisation of convection from the echo (organization.ts)', () => {
  it('finds a discrete cell and a cluster of two cores', () => {
    const one = classifyEcho(field((x, y) => blob(x, y, 100, 100, 8)), NX, NY, D, D)
    expect(one.map(o => o.kind)).toEqual(['cell'])
    const two = classifyEcho(field((x, y) => Math.max(45 * +(Math.hypot(x - 100, y - 100) < 20), blob(x, y, 92, 100, 4, 58), blob(x, y, 108, 100, 4, 58))), NX, NY, D, D)
    expect(two[0].kind).toBe('cluster'); expect(two[0].cores).toBe(2)
  })

  it('finds a line >= 75 km and 3:1, not a shorter or fatter one', () => {
    const bar = (len: number, wide: number) => classifyEcho(field((x, y) => Math.abs(y - 100) < len / 2 && Math.abs(x - 100) < wide / 2 ? 50 : -20), NX, NY, D, D, [1, 0])[0]
    const line = bar(120, 12)
    expect(line.kind).toBe('line'); expect(line.length).toBeCloseTo(120, -1); expect(line.aspect).toBeGreaterThan(9)
    expect(line.normal[0]).toBeCloseTo(1, 3); expect(line.sagitta).toBeCloseTo(0, 1)
    expect(bar(60, 12).kind).not.toBe('line'); expect(bar(120, 60).kind).not.toBe('line')
  })

  it('calls a line bowed toward its motion a bow, and one bowed backward a line', () => {
    // A circular arc through y 40-160 km with a sagitta of 15 km (0.125 of the chord), bulging east.
    const arc = (sign: number) => field((x, y) => { const s = (y - 100) / 60; return Math.abs(s) < 1 && Math.abs(x - (100 + sign * 15 * (1 - s * s))) < 6 ? 50 : -20 })
    const bow = classifyEcho(arc(1), NX, NY, D, D, [1, 0])[0], back = classifyEcho(arc(-1), NX, NY, D, D, [1, 0])[0]
    expect(bow.kind).toBe('bow'); expect(bow.sagitta).toBeGreaterThan(ORG.bowSagitta)
    expect(back.kind).toBe('line'); expect(back.sagitta).toBeLessThan(0)
  })

  it('tells the stratiform: behind, ahead, none', () => {
    const line = (x: number, y: number) => Math.abs(y - 100) < 50 && Math.abs(x - 100) < 6 ? 50 : -20
    const trailing = classifyEcho(field((x, y) => Math.max(line(x, y), Math.abs(y - 100) < 50 && x > 50 && x < 100 ? 35 : -20)), NX, NY, D, D, [1, 0])[0]
    const leading = classifyEcho(field((x, y) => Math.max(line(x, y), Math.abs(y - 100) < 50 && x > 100 && x < 150 ? 35 : -20)), NX, NY, D, D, [1, 0])[0]
    expect(trailing.stratiform).toBe('trailing'); expect(leading.stratiform).toBe('leading')
    expect(classifyEcho(field(line), NX, NY, D, D, [1, 0])[0].stratiform).toBe('none')
    // 30-40 dBZ behind but cut off from the line by a 4 km gap: another cell's edge, not the line's stratiform.
    const apart = classifyEcho(field((x, y) => Math.max(line(x, y), Math.abs(y - 100) < 50 && x > 50 && x < 90 ? 35 : -20)), NX, NY, D, D, [1, 0])
    expect(apart.find(o => o.kind === 'line')!.stratiform).toBe('none')
  })

  it('finds a broken line of discrete cells and leaves scattered ones alone', () => {
    const row = classifyEcho(field((x, y) => Math.max(...[40, 65, 90, 115, 140, 165].map(c => blob(x, y, 100, c, 6)))), NX, NY, D, D, [1, 0])
    expect(row.map(o => o.kind)).toContain('broken-line')
    const apart = classifyEcho(field((x, y) => Math.max(blob(x, y, 30, 30, 6), blob(x, y, 150, 60, 6), blob(x, y, 60, 160, 6))), NX, NY, D, D)
    expect(apart.map(o => o.kind)).not.toContain('broken-line')
  })

  it('joins an echo across the periodic edge, and in km whatever the grid', () => {
    const across = classifyEcho(field((x, y) => (x < 6 || x >= NX - 6) && Math.abs(y - 100) < 50 ? 50 : -20), NX, NY, D, D, [1, 0])
    expect(across.length).toBe(1); expect(across[0].kind).toBe('line')
    const fine = new Float32Array(800 * 800).fill(-20)
    for (let y = 0; y < 800; y++) for (let x = 0; x < 800; x++) if (Math.abs(y - 400) < 240 && Math.abs(x - 400) < 24) fine[x + 800 * y] = 50
    expect(classifyEcho(fine, 800, 800, .25, .25, [1, 0])[0].length).toBeCloseTo(120, -1)
  })
})
