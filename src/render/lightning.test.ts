import { describe, expect, it } from 'vitest'
import type { Flash } from '../core'
import { mulberry32 } from '../core/math'
import { brightness, course, tortuous } from './lightning'

const flash = (kind: 'IC' | 'CG', charge: number) => ({ kind, charge }) as Flash

describe('the course of a flash in time (lightning.ts)', () => {
  it('gives a negative CG several strokes 5-300 ms apart (~60 ms geometric mean), 3.7 on average, and a positive CG one', () => {
    const rng = mulberry32(5), counts: number[] = [], gaps: number[] = []
    let withCc = 0, ccFirst = 0, forks = 0, multi = 0
    for (let k = 0; k < 4000; k++) {
      const c = course(flash('CG', -5), rng)
      counts.push(c.strokes.length)
      if (c.strokes.some(s => s.ccLength > 0)) withCc++
      if (c.strokes[0].ccLength > 0) ccFirst++
      if (c.strokes.length > 1) { multi++; if (c.strokes.some(s => s.path)) forks++ }
      expect(c.strokes[0].path).toBe(0)
      for (let i = 1; i < c.strokes.length; i++) gaps.push(c.strokes[i].at - c.strokes[i - 1].at - c.strokes[i - 1].ccLength)
    }
    const mean = counts.reduce((a, b) => a + b) / counts.length, geo = Math.exp(gaps.reduce((a, b) => a + Math.log(b), 0) / gaps.length)
    expect(mean).toBeGreaterThan(3.5); expect(mean).toBeLessThan(4)
    expect(counts.filter(n => n === 1).length / counts.length).toBeCloseTo(.18, 1)
    expect(Math.min(...counts)).toBe(1); expect(Math.max(...counts)).toBe(8)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(5 - 1e-9); expect(Math.max(...gaps)).toBeLessThanOrEqual(300 + 1e-9)
    expect(geo).toBeGreaterThan(50); expect(geo).toBeLessThan(70)
    expect(Math.max(...gaps)).toBeGreaterThan(150)
    // A new ground contact in 35-50% of the multiple-stroke flashes.
    expect(forks / multi).toBeGreaterThan(.35); expect(forks / multi).toBeLessThan(.55)
    // A long continuing current in ~30% of the flashes, never after the first stroke.
    expect(withCc / counts.length).toBeGreaterThan(.2); expect(withCc / counts.length).toBeLessThan(.4); expect(ccFirst).toBe(0)
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

  it('keeps an IC flash flickering for 0.2-0.7 s with K-changes much dimmer than a return stroke', () => {
    const rng = mulberry32(9)
    for (let k = 0; k < 200; k++) {
      const c = course(flash('IC', 3), rng), peak = Math.max(...Array.from({ length: 100 }, (_, i) => brightness(c, false, i * c.end / 100).main))
      expect(c.end).toBeGreaterThan(300); expect(c.end).toBeLessThan(800); expect(peak).toBeLessThan(.36)
      // Its K-changes come once the channel has grown.
      expect(c.strokes[0].at).toBeCloseTo(c.leader, 5); expect(c.strokes.every(s => s.at >= c.leader)).toBe(true)
    }
  })
})

describe('the shape of a channel (lightning.ts)', () => {
  it('runs in straight steps of tens of metres with sharp turns, ~16 deg on average, and ends where it should', () => {
    const rng = mulberry32(11), turns: number[] = [], steps: number[] = []
    for (let k = 0; k < 200; k++) {
      const to = [rng() * 2 - 1, -.5 - rng(), rng() * 2 - 1], pts = tortuous([0, 0, 0], to, rng)
      expect(pts[pts.length - 1]).toEqual(to)
      for (let i = 1; i < pts.length; i++) steps.push(Math.hypot(...[0, 1, 2].map(j => pts[i][j] - pts[i - 1][j])))
      for (let i = 2; i < pts.length - 1; i++) {
        const a = [0, 1, 2].map(j => pts[i - 1][j] - pts[i - 2][j]), b = [0, 1, 2].map(j => pts[i][j] - pts[i - 1][j])
        const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.hypot(...a) / Math.hypot(...b)
        turns.push(Math.acos(Math.min(1, Math.max(-1, c))) * 180 / Math.PI)
      }
    }
    const meanTurn = turns.reduce((a, b) => a + b) / turns.length, meanStep = steps.reduce((a, b) => a + b) / steps.length
    expect(meanTurn).toBeGreaterThan(12); expect(meanTurn).toBeLessThan(22)
    expect(meanStep).toBeGreaterThan(.03); expect(meanStep).toBeLessThan(.1)
  })
})

describe('leaders crossing the cloud (lightning.ts)', () => {
  it('lets a wide IC flash and a positive CG grow for hundreds of ms, at ~10^5 m/s', () => {
    const rng = mulberry32(21)
    const wide = course(flash('IC', 3), rng, 30), small = course(flash('IC', 3), rng, 2), pos = course(flash('CG', 5), rng, 25), neg = course(flash('CG', -5), rng, 25)
    expect(wide.leader).toBeCloseTo(300, 5); expect(small.leader).toBeLessThan(150)
    expect(wide.end).toBeGreaterThan(wide.leader + 150)
    expect(pos.leader).toBeCloseTo(250, 5); expect(neg.leader).toBeLessThan(36)
    expect(brightness(wide, false, 100).main).toBeGreaterThan(.2)
  })
})

describe('the lightning shader for GPUs that cannot build the full one', () => {
  it('reads no texture in the vertex shader and keeps everything else', async () => {
    const { lightningVertex, lightningVertexSimple, spriteVertex, spriteVertexSimple } = await import('./shaders')
    expect(lightningVertex).toMatch(/cloudBetween\(at\)/)
    expect(lightningVertexSimple).not.toMatch(/sampler3D|texture|cloudBetween/)
    expect(lightningVertexSimple).toContain('vSeen = 1.0;')
    // The channel itself is built the same way.
    for (const line of ['vCore = uPx', 'vHalo = uPx', 'gl_Position = vec4(s / hr * c.w, c.z, c.w);', 'vTint = exp(']) expect(lightningVertexSimple).toContain(line)
    // The sprites likewise.
    expect(spriteVertex).toMatch(/cloudBetween\(p\)/)
    expect(spriteVertexSimple).not.toMatch(/sampler3D|texture|cloudBetween/)
    expect(spriteVertexSimple).toContain('vSeen = 1.0;')
  })
})
