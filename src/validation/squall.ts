/**
 * A squall line by the numbers, set up as Weisman & Rotunno (2004, WR04) and Bryan, Knievel & Parker (2006): the WK82
 * sounding, shear `us` m/s over 0-`depth` km (none above), f = 0, no sun, one line thermal all along y, relaxed edges in
 * x and periodic in y (their 600 x 80-160 km at 1 km; here 288 x 72). Notes: .claude/literature/squall-line-initiation.md.
 * Every `every` minutes, from the y-mean (line-averaged) fields, as they measure it: the gust front (the y-mean ground
 * theta' of -1 K) and its ground speed; C from WR04 eq. 11, C^2 = -Bmin H (Bmin the lowest level's strongest negative
 * y-mean buoyancy within 20 km behind the front, H where B vanishes above it), and from the integral, eq. 10; C / dU
 * over 0-2.5 and 0-5 km; the updraught's tilt, x(1.5 km) - x(6 km) of the y-mean w's maximum measured forward from
 * behind the front (negative: the 6 km updraught lies rearward, upshear); w max; the share of rows along y with
 * w >= 5 m/s at 3 km. Used by the long validation cases (cases.ts LONG_CASES) and tests/bench/lines.ts.
 */
import { AtmosphereModel, createGrid, domainGrid, DT, G, SharedMemory, type SimConfig } from '../core'
import { SUMMER_DAY } from '../core/fixtures'

export interface SquallOptions {
  /** Shear, m/s over the layer. */ us: number
  /** Depth of the shear layer, km. */ depth?: number
  /** Grid step, km. */ dx?: number
  hours?: number
  /** Minutes between samples. */ every?: number
  /** Speed of the moving frame, m/s eastward (CM1's umove 12.5). */ speed?: number
  size?: readonly [number, number]
  /** Mixing ratio at the ground, g/kg (WR04's WK82: 14). */ qv?: number
}
export interface SquallSample {
  minutes: number
  /** Null until a -1 K line-averaged cold pool exists; then the numbers below are measured. */
  front: null | { km: number; speed: number; thetaMin: number; c: number; cIntegral: number; h: number; cdU25: number; cdU5: number; tilt: number; behind15: number; behind6: number; w15: number; w6: number }
  wMax: number; rows: number; gust: number
}
/** Starts helper threads on the model's shared memory; returns how to stop them. */
export type Threads = (model: AtmosphereModel, config: SimConfig, memory: SharedMemory) => () => void

export const squallConfig = ({ us, depth = 2.5, dx = 1, speed = 12.5, size = [288, 72], qv = 14 }: SquallOptions): SimConfig => ({
  ...SUMMER_DAY, profile: 'weisman-klemp', weismanKlemp: { qvMax: qv / 1000, u6: us, depth: depth * 1000 }, solarMax: 0, latitude: 0, bubble: 0,
  start: 'line-thermal', edges: 'relaxed-x', frameMotion: [speed, 0], domain: 'meso', domainSize: [size[0], size[1]], spacing: dx,
})
export const squallGrid = (c: SimConfig) => createGrid(domainGrid(c.domain, c.top, c.domainSize, c.spacing))

export function squallLine(options: SquallOptions, threads?: Threads, onSample?: (s: SquallSample, model: AtmosphereModel) => void): SquallSample[] {
  const { hours = 4, every = 30, speed = 12.5 } = options, config = squallConfig(options), memory = new SharedMemory()
  const model = new AtmosphereModel(structuredClone(config), squallGrid(config), undefined, { memory }), stop = threads?.(model, config, memory)
  try {
    const grid = model.grid, { nx, ny, nz, zs, hz, layer } = grid, km = grid.dx / 1000, e = model.env, level = (z: number) => zs.findIndex(h => h >= z)
    const [u0] = e.windUV(0), [u25] = e.windUV(2500), [u5] = e.windUV(5000), dU25 = Math.abs(u25 - u0), dU5 = Math.abs(u5 - u0)
    const b = new Float64Array(nx * nz), th = new Float64Array(nx), meanW = new Float64Array(nx * nz), samples: SquallSample[] = []
    const at = (x: number) => ((x % nx) + nx) % nx, period = nx * grid.dx
    let last: { pos: number; t: number } | null = null
    for (let t = DT; t <= hours * 3600 + 1e-6; t += DT) {
      model.step(DT); model.time += DT
      if (Math.round(t) % (every * 60)) continue
      b.fill(0); th.fill(0); meanW.fill(0)
      for (let z = 0; z < nz; z++) {
        const thv0 = e.theta[z] * (1 + .61 * e.q[z])
        for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
          const i = x + nx * (y + ny * z)
          b[x + nx * z] += G * (model.theta[i] * (1 + .61 * model.q[i]) / thv0 - 1 - model.cloud[i] - model.rain[i] - model.ice[i] - model.snow[i] - model.graupel[i] - model.hail[i]) / ny
          meanW[x + nx * z] += model.w[i] / ny
          if (z === 0) th[x] += (model.theta[i] - e.theta[0]) / ny
        }
      }
      // The front: east from the coldest column through columns of <= -1 K (gaps of 3 km allowed).
      let cold = 0
      for (let x = 0; x < nx; x++) if (th[x] < th[cold]) cold = x
      let front: number | null = null
      if (th[cold] <= -1) {
        let gap = 0
        front = cold
        for (let d = 1; d < nx; d++) { const x = (cold + d) % nx; if (th[x] <= -1) { front = cold + d; gap = 0 } else if (++gap * km > 3) break }
      }
      const sample: SquallSample = { minutes: Math.round(t / 60), front: null, wMax: 0, rows: 0, gust: 0 }
      if (front !== null) {
        let bmin = 0, bx = at(front), c2 = 0, h = 0
        for (let d = 0; d * km <= 20; d++) { const x = at(front - d); if (b[x] < bmin) { bmin = b[x]; bx = x } }
        for (let z = 0; z < nz; z++) { const v = b[bx + nx * z]; if (v >= 0) break; c2 -= 2 * v * hz[z]; h = zs[z] + hz[z] / 2 }
        const c = Math.sqrt(Math.max(0, -bmin * h)), pos = front * grid.dx
        const moved = last ? ((pos - last.pos + period / 2) % period + period) % period - period / 2 : 0
        const up = last ? moved / (t - last.t) + speed : NaN
        last = { pos, t }
        // The updraught near the front: within 60 km behind it to 20 km ahead.
        const peak = (height: number) => { const z = level(height); let best = -1, ax = 0; for (let d = -20; d * km <= 60; d++) { const v = meanW[at(front! - d) + nx * z]; if (v > best) { best = v; ax = d } } return [best, ax * km] }
        const [w15, x15] = peak(1500), [w6, x6] = peak(6000)
        sample.front = { km: pos / 1000, speed: up, thetaMin: th[cold], c, cIntegral: Math.sqrt(c2), h: h / 1000, cdU25: c / dU25, cdU5: c / dU5, tilt: x15 - x6, behind15: x15, behind6: x6, w15, w6 }
      }
      const l3 = level(3000), l100 = level(100), [fu, fv] = model.frame
      let rows = 0
      for (let y = 0; y < ny; y++) {
        let r = 0
        for (let x = 0; x < nx; x++) { const c = x + nx * y; r = Math.max(r, model.w[c + l3 * layer]); sample.gust = Math.max(sample.gust, Math.hypot(model.u[c + l100 * layer] + fu, model.v[c + l100 * layer] + fv)) }
        if (r >= 5) rows++
      }
      sample.rows = rows / ny
      for (let i = 0; i < model.w.length; i++) if (model.w[i] > sample.wMax) sample.wMax = model.w[i]
      samples.push(sample); onSample?.(sample, model)
    }
    return samples
  } finally { stop?.() }
}
