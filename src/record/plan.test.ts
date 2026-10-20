import { describe, expect, it } from 'vitest'
import { bitrate, blendWeight, frameCount, frameStamp, frameTime, type RecordSettings, screenSize, stepsTo } from './plan'

const settings = (speed: number, fps = 60, seconds = 10): RecordSettings => ({ seconds, fps, speed, width: 1920, height: 1080, camera: 'still' })

/** The recorder's loop without the model: the two held states, the steps asked for, the frames' blends. */
function run(s: RecordSettings, dt = 3, start = 120) {
  let a = start, b = start, steps = 0
  const frames: { t: number; a: number; b: number; w: number }[] = []
  for (let k = 0; k < frameCount(s); k++) {
    const t = frameTime(start, k, s), n = stepsTo(t, b, dt)
    if (n) { a = b; b += n * dt; steps += n }
    frames.push({ t, a, b, w: blendWeight(a, b, t) })
  }
  return { frames, steps }
}

describe('recording plan', () => {
  it('gives 600 frames with even stamps for 10 s at 60 fps', () => {
    const s = settings(60)
    expect(frameCount(s)).toBe(600)
    const stamps = Array.from({ length: 600 }, (_, k) => frameStamp(k, 60)), gaps = stamps.slice(1).map((t, k) => t - stamps[k])
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1)
    expect(stamps[599]).toBe(9_983_333)
  })

  it('keeps every frame between the two states it blends, slowed down or sped up', () => {
    for (const speed of [10, 60, 180, 600]) {
      const { frames, steps } = run(settings(speed))
      for (const f of frames) { expect(f.a).toBeLessThanOrEqual(f.t + 1e-9); expect(f.b).toBeGreaterThanOrEqual(f.t - 1e-9) }
      // No more steps than the video's model time needs.
      const last = frames[frames.length - 1].t - 120
      expect(steps).toBe(Math.ceil(last / 3 - 1e-6))
    }
  })

  it('blends smoothly when slowed down: at 10 model s a second and 60 fps a step spreads over 18 frames', () => {
    const { frames } = run(settings(10))
    const rises = frames.slice(1).map((f, k) => f.a === frames[k].a && f.b === frames[k].b ? f.w - frames[k].w : null).filter((d): d is number => d !== null)
    expect(rises.length).toBeGreaterThan(500)
    for (const d of rises) expect(d).toBeCloseTo(1 / 18, 6)
  })

  it('needs no blend when a frame is whole steps', () => {
    for (const f of run(settings(180)).frames) expect(f.w).toBe(1)
  })

  it('makes even sizes in the view’s shape and a bit rate of streaming quality', () => {
    expect(screenSize(1000, 618, 1920)).toEqual([1920, 1186])
    expect(screenSize(390, 844, 1920)).toEqual([888, 1920])
    expect(bitrate(settings(60, 30))).toBe(Math.round(1920 * 1080 * 30 * .12))
    expect(bitrate({ ...settings(60, 60), width: 3840, height: 2160 })).toBe(50e6)
  })
})
