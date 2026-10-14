import { describe, expect, it } from 'vitest'
import type { Flash } from '../core'
import { mulberry32 } from '../core/math'
import { brightness, course } from './lightning'

const flash = (kind: 'IC' | 'CG', charge: number) => ({ kind, charge }) as Flash

describe('the course of a flash in time (lightning.ts)', () => {
  it('gives a negative CG several strokes 15-120 ms apart, about 3-4 on average, and a positive CG one', () => {
    const rng = mulberry32(5), counts: number[] = [], gaps: number[] = []
    for (let k = 0; k < 2000; k++) {
      const c = course(flash('CG', -5), rng)
      counts.push(c.strokes.length)
      for (let i = 1; i < c.strokes.length; i++) gaps.push(c.strokes[i].at - c.strokes[i - 1].at - c.strokes[i - 1].ccLength)
    }
    const mean = counts.reduce((a, b) => a + b) / counts.length
    expect(mean).toBeGreaterThan(3); expect(mean).toBeLessThan(4.2)
    expect(Math.min(...counts)).toBe(1); expect(Math.max(...counts)).toBe(8)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(15); expect(Math.max(...gaps)).toBeLessThanOrEqual(120)
    for (let k = 0; k < 50; k++) { const c = course(flash('CG', 5), rng); expect(c.strokes.length).toBe(1); expect(c.strokes[0].ccLength).toBeGreaterThanOrEqual(100) }
  })

  it('grows the leader dimly, then flashes the main channel at the return stroke and the branches with the first only', () => {
    const c = course(flash('CG', -5), mulberry32(3)), first = c.strokes[0]
    const leader = brightness(c, true, c.leader / 2)
    expect(leader.reveal).toBeCloseTo(.5, 5); expect(leader.main).toBeLessThan(.2)
    const stroke = brightness(c, true, first.at + 1)
    expect(stroke.main).toBeGreaterThan(.9); expect(stroke.branch).toBeGreaterThan(.4); expect(stroke.reveal).toBe(1)
    if (c.strokes.length > 1) { const next = brightness(c, true, c.strokes[1].at + 1); expect(next.main).toBeGreaterThan(.55); expect(next.branch).toBeLessThan(.1) }
    expect(brightness(c, true, c.end).main).toBeLessThan(.02)
  })

  it('keeps an IC flash dimmer and flickering for 200-500 ms', () => {
    const rng = mulberry32(9)
    for (let k = 0; k < 200; k++) {
      const c = course(flash('IC', 3), rng), peak = Math.max(...Array.from({ length: 100 }, (_, i) => brightness(c, false, i * c.end / 100).main))
      expect(c.end).toBeGreaterThan(300); expect(c.end).toBeLessThan(650); expect(peak).toBeLessThan(.65)
    }
  })
})
