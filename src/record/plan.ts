/**
 * The video recording's clock (2.9): not a capture of the screen, but frame by frame — the run paused, every frame the
 * model steps to that frame's model time and the view is drawn for it as long as it takes, so the video plays evenly
 * at its fps however slowly the device draws. Between two of the model's states (DT apart) a frame shows their
 * blend, so a slowed-down video (fewer than DT model seconds a frame) moves smoothly instead of in steps.
 */

export type RecordCamera = 'still' | 'orbit' | 'ground'

export interface RecordSettings {
  /** Seconds of video, frames a second, model seconds a second of video. */
  seconds: number; fps: number; speed: number
  /** The picture, pixels (even: the H.264 encoders need it). */
  width: number; height: number
  /** As it is now, turning round the storm, or from the ground. */
  camera: RecordCamera
}

/** Turning round the storm: degrees a second of video (a turn a minute). */
export const ORBIT_SPEED = 6

export const frameCount = (s: RecordSettings) => Math.max(1, Math.round(s.seconds * s.fps))
/** The model time frame `k` shows, from the time the recording starts at. */
export const frameTime = (start: number, k: number, s: RecordSettings) => start + k * s.speed / s.fps
/** Frame `k`'s time stamp in the video, µs. */
export const frameStamp = (k: number, fps: number) => Math.round(k * 1e6 / fps)

/** Model steps (each `dt`) from the state at `held` to reach `target` (0 when it already has; a hair of rounding is not a step). */
export function stepsTo(target: number, held: number, dt: number) {
  return target <= held + 1e-6 ? 0 : Math.ceil((target - held) / dt - 1e-6)
}

/** How far between the states at `a` and `b` the time `t` lies (0-1; 1 when they coincide). */
export function blendWeight(a: number, b: number, t: number) {
  return b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 1
}

/**
 * Bits a second for a picture: ~0.12 bits a pixel a frame, as streaming services give H.264 (1080p30 ~7.5 Mbit/s),
 * at most 50 Mbit/s.
 */
export const bitrate = (s: RecordSettings) => Math.min(50e6, Math.round(s.width * s.height * s.fps * .12))

/** The picture sizes offered: [label, width, height]; 'screen' is the view's own shape. */
export const SIZES: [string, number, number][] = [['720p', 1280, 720], ['1080p', 1920, 1080], ['1440p', 2560, 1440], ['4K', 3840, 2160]]

/** A size in the view's own shape, its long side `long` pixels, both sides even. */
export function screenSize(viewWidth: number, viewHeight: number, long: number): [number, number] {
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2), wide = viewWidth >= viewHeight, r = wide ? viewHeight / viewWidth : viewWidth / viewHeight
  return wide ? [even(long), even(long * r)] : [even(long * r), even(long)]
}
