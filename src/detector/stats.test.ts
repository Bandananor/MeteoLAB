import { describe, expect, it } from 'vitest'
import { createGrid, DEFAULT_GRID, type Flash } from '../core'
import { flashDensity, flashFacts, flashPoint, flashRates, lightningJumps, type RateBin } from './stats'

const grid = createGrid(DEFAULT_GRID), { nx, layer, dx, dy } = grid
const node = (x: number, y: number, z: number) => x + y * nx + z * layer
/** A flash with a straight channel through the given nodes, each grown from the one before. */
function flash(time: number, kind: 'IC' | 'CG', nodes: number[], charge = kind === 'CG' ? -5 : 8): Flash {
  return { time, kind, start: nodes[0], nodes: Int32Array.from(nodes), parent: Int32Array.from(nodes, (_, k) => k - 1), polarity: Int8Array.from(nodes, (_, k) => k % 2 ? 1 : -1), potential: -3e7, charge, ground: kind === 'CG' ? nodes[nodes.length - 1] : -1, moment: 0 }
}

describe('lightning detector statistics', () => {
  it('a CG is located where it struck; the domain moves on, so the strike stays behind on the ground', () => {
    const f = flash(600, 'CG', [node(10, 10, 20), node(10, 10, 10), node(11, 10, 0)])
    expect(flashPoint({ grid, frame: [0, 0], time: 600 }, f)).toMatchObject({ x: 11 * dx, y: 10 * dy, z: 0 })
    // Ten minutes later the domain (and the storm) has gone 6 km east at 10 m/s: the strike is 6 km further west in it.
    expect(flashPoint({ grid, frame: [10, 0], time: 1200 }, f).x).toBeCloseTo(11 * dx - 6000)
  })

  it('an IC is placed at the centre of its channel, across the periodic edge too', () => {
    const f = flash(60, 'IC', [node(nx - 1, 5, 20), node(0, 5, 20), node(1, 5, 20)])
    const p = flashPoint({ grid, frame: [0, 0], time: 60 }, f)
    expect(p.x === 0 || Math.abs(p.x - nx * dx) < 1e-6 || Math.abs(p.x) < 1e-6).toBe(true)
  })

  it('counts the flashes by minute and kind', () => {
    const fl = [flash(3, 'IC', [0]), flash(60, 'IC', [0]), flash(63, 'CG', [node(0, 0, 1), 0]), flash(66, 'CG', [node(0, 0, 1), 0], 4), flash(200, 'IC', [0])]
    const bins = flashRates(fl, 0, 179)
    expect(bins).toEqual([{ t: 0, ic: 2, cgNeg: 0, cgPos: 0 }, { t: 60, ic: 0, cgNeg: 1, cgPos: 1 }, { t: 120, ic: 0, cgNeg: 0, cgPos: 0 }])
  })

  it('finds a lightning jump (2σ) when the rate shoots up, not in a steady or a weak storm', () => {
    const series = (rates: number[]): RateBin[] => rates.map((r, k) => ({ t: k * 60, ic: r, cgNeg: 0, cgPos: 0 }))
    const steady = Array.from({ length: 30 }, (_, k) => 12 + (k % 3))
    expect(lightningJumps(series(steady))).toEqual([])
    const jump = [...steady.slice(0, 20), 20, 30, 42, 50, 52, 52, 51, 52, 52, 51]
    const found = lightningJumps(series(jump))
    expect(found.length).toBe(1); expect(found[0]).toBeGreaterThanOrEqual(20 * 60); expect(found[0]).toBeLessThanOrEqual(22 * 60)
    // The same shape at a tenth of the rate stays below the 10 a minute floor.
    expect(lightningJumps(series(jump.map(r => Math.round(r / 10))))).toEqual([])
  })

  it('flash density: flashes per km² of their squares, only the recent ones', () => {
    const m = { grid, frame: [0, 0] as const, time: 600 }, cg = (t: number) => flash(t, 'CG', [node(4, 4, 3), node(4, 4, 0)])
    const { cols, density } = flashDensity(m, [cg(500), cg(550), cg(100)], 300, 4800)
    const c = Math.floor(4 * dx / (grid.width / cols)) + Math.floor(4 * dy / (grid.depth / Math.round(grid.depth / 4800))) * cols
    const area = grid.width / cols * grid.depth / Math.round(grid.depth / 4800) / 1e6
    expect(density[c]).toBeCloseTo(2 / area, 5)
    expect(density.reduce((a, b) => a + b, 0)).toBeCloseTo(2 / area, 5)
  })

  it('the card of a flash: its heights, length and reach', () => {
    const f = flash(60, 'CG', [node(10, 10, 20), node(11, 10, 20), node(11, 10, 0)]), facts = flashFacts({ grid, frame: [0, 0], time: 60 }, f)
    expect(facts.kind).toContain('−CG')
    expect(facts.start).toBeCloseTo(grid.zs[20] / 1000); expect(facts.low).toBe(0)
    expect(facts.reach).toBeCloseTo(dx / 1000)
    expect(facts.length).toBeCloseTo((dx + grid.zs[20]) / 1000)
  })
})
