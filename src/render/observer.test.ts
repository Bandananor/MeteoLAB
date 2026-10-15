import { describe, expect, it } from 'vitest'
import { CAR_SPEED, Observer } from './observer'

describe('observer', () => {
  it('drives to a point at its speed in model time and stops there', () => {
    const o = new Observer({ x: 0, y: 0 })
    o.moveTo({ x: 3000, y: 4000 })
    expect(o.velocity[0]).toBeCloseTo(CAR_SPEED * .6); expect(o.velocity[1]).toBeCloseTo(CAR_SPEED * .8)
    o.step(100)
    expect(Math.hypot(o.x, o.y)).toBeCloseTo(CAR_SPEED * 100)
    o.step(1000)
    expect(o.x).toBe(3000); expect(o.y).toBe(4000); expect(o.moving).toBe(false)
  })

  it('stands still unless sent somewhere', () => {
    const o = new Observer({ x: 10, y: 20 })
    o.step(60)
    expect([o.x, o.y]).toEqual([10, 20])
    o.moveTo({ x: 1000, y: 20 }, 10); o.step(10); o.stop(); o.step(10)
    expect(o.x).toBeCloseTo(110)
  })
})
