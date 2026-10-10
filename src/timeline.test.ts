import { describe, expect, it } from 'vitest'
import { SAMPLE, Timeline } from './timeline'

const at = (t: number) => ({ t, cape: 0, cin: 0, updraft: t / 60, uh: 0, rain: 0, rainTotal: 0, rotationHeld: 0 })

describe('storm timeline (src/timeline.ts)', () => {
  it('keeps one point per 30 model seconds and starts over after a restart', () => {
    const tl = new Timeline()
    for (let t = 0; t <= 600; t += 3) tl.record(at(t))
    expect(tl.points.length).toBe(600 / SAMPLE + 1)
    expect(tl.points.every((p, i) => p.t === i * SAMPLE)).toBe(true)
    // Time goes back (restart, new scenario): a new record.
    expect(tl.record(at(3))).toBe(true)
    expect(tl.points.map(p => p.t)).toEqual([3])
  })
})
