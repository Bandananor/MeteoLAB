/**
 * One member of an ensemble (2.9): the same settings with its own random seed (the surface pattern, the first
 * disturbances and thermals), run without a view as fast as one core goes. It keeps what the ensemble compares: every
 * SAMPLE_EVERY model seconds the domain's strongest values, and over the whole run, per ground column (the ground
 * under the moving domain, as the station's), the rain total, the largest hail, the strongest surface wind and the
 * strongest updraught helicity — the swaths the probability maps are made of.
 */
import { AtmosphereModel, DT, groundRepeats, type SimConfig } from '../core'
import { clamp, mod, mulberry32 } from '../core/math'

/** The domain's strongest values at one time. */
export interface MemberSample {
  t: number; updraft: number; uh: number; rain: number; gust: number; hail: number; flashes: number; rotationHeld: number; cores: number
  /** The outflow's θv deficit at the ground (rkw.ts outflowDeficit), K: the largest, and the largest under the low-level rotation (absent in older results). */
  outflow?: number; outflowLow?: number
}
export interface MemberResult {
  seed: number; samples: MemberSample[]
  /** The ground columns: nx x ny over the domain's size, m. */
  nx: number; ny: number; width: number; depth: number
  /** Per ground column over the run: rain total (mm), largest hail (mm), strongest surface wind (m/s), strongest UH 2-5 km (m²/s²). */
  rainTotal: Float32Array; hailSize: Float32Array; gustMax: Float32Array; uhMax: Float32Array
}

/** Model seconds between samples. */
export const SAMPLE_EVERY = 60

/**
 * The uncertainty of the starting data (standard deviations), as an analysis's errors: the temperature and humidity
 * near the ground, the wind at each level (so the shear too), and where and how strong the first thermal is. With the
 * seed alone the members hardly part: the thermals stand at the same places with the same strength, and the seed only
 * moves the surface pattern and a 0.02 K noise.
 */
export const UNCERTAINTY = { temperature: .5, humidity: 4, wind: 1.5, direction: 8, thermal: .1, offset: 1500 }

/** Normal deviates from a seeded generator (Box-Muller). */
function normal(rng: () => number) { return () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng()) }

/**
 * The settings with the starting data perturbed within UNCERTAINTY, drawn from the member's own seed: the profile's
 * surface temperature, the humidity below 1.5 km, the wind at its nodes; a real sounding's temperature, dew point and
 * vapour below 1.5 km and its wind (an error at 0, 3, 6 and 10 km, between them interpolated); the thermals' strength
 * and position.
 */
export function perturbConfig(config: SimConfig): SimConfig {
  const n = normal(mulberry32(config.seed ^ 0x5bd1e995)), U = UNCERTAINTY, c = structuredClone(config) as SimConfig & Record<string, unknown>
  const dT = n() * U.temperature, dRh = n() * U.humidity, nodes = [0, 3000, 6000, 10000], du = nodes.map(() => n() * U.wind), dv = nodes.map(() => n() * U.wind)
  c.surfaceTemp += dT
  c.rhSurface = clamp(c.rhSurface + dRh, 5, 100); c.rhLow = clamp(c.rhLow + dRh, 5, 100)
  for (const k of ['0', '05', '1', '3', '6', '10']) {
    const speed = `wind${k}`, dir = `windDir${k}`
    if (typeof c[speed] === 'number') c[speed] = Math.max(0, (c[speed] as number) + n() * U.wind)
    if (typeof c[dir] === 'number') c[dir] = mod((c[dir] as number) + n() * U.direction, 360)
  }
  if (c.sounding) {
    const at = (d: number[], z: number) => { let k = 0; while (k < nodes.length - 2 && z >= nodes[k + 1]) k++; return d[k] + (d[k + 1] - d[k]) * clamp((z - nodes[k]) / (nodes[k + 1] - nodes[k]), 0, 1) }
    c.sounding = { ...c.sounding, levels: c.sounding.levels.map(l => {
      const low = Math.max(0, 1 - l.z / 1500), dq = 1 + dRh / 100 * low
      return { ...l, t: l.t + dT * low, td: l.td === null ? null : l.td + dT * low, qv: l.qv === undefined ? undefined : l.qv * dq, u: l.u === null ? null : l.u + at(du, l.z), v: l.v === null ? null : l.v + at(dv, l.z) }
    }) }
  }
  c.bubble *= Math.max(.5, 1 + n() * U.thermal)
  c.startOffset = [n() * U.offset, n() * U.offset]
  return c
}

/** What the swaths need of a model. */
type Swathed = Pick<AtmosphereModel, 'grid' | 'frame' | 'time' | 'u' | 'v' | 'uhColumn' | 'edges'>

/** Folds the surface wind and the UH of every domain column now into the per-ground-column maxima. */
export function addSwaths(m: Swathed, gustMax: Float32Array, uhMax: Float32Array) {
  const { nx, ny, dx, dy } = m.grid, [fu, fv] = m.frame, [rx, ry] = groundRepeats(m)
  // The ground under the domain is the domain shifted by its motion so far (whole columns: the nearest one).
  const sx = Math.round(fu * m.time / dx), sy = Math.round(fv * m.time / dy)
  for (let y = 0; y < ny; y++) {
    let gy = y + sy
    if (ry) gy = mod(gy, ny); else if (gy < 0 || gy >= ny) continue
    for (let x = 0; x < nx; x++) {
      let gx = x + sx
      if (rx) gx = mod(gx, nx); else if (gx < 0 || gx >= nx) continue
      const c = x + nx * y, g = gx + nx * gy, wind = Math.hypot(m.u[c] + fu, m.v[c] + fv)
      if (wind > gustMax[g]) gustMax[g] = wind
      if (m.uhColumn[c] > uhMax[g]) uhMax[g] = m.uhColumn[c]
    }
  }
}

/** Runs one member for `minutes` of model time; `progress` hears the model time after every sample. */
export function runMember(config: SimConfig, minutes: number, progress?: (time: number) => void): MemberResult {
  const m = new AtmosphereModel(config), { nx, ny, layer, width, depth } = m.grid
  const gustMax = new Float32Array(layer), uhMax = new Float32Array(layer), samples: MemberSample[] = []
  let flashes = 0
  const sample = () => {
    const d = m.diagnostics(), total = m.flashCount.ic + m.flashCount.cg
    samples.push({ t: m.time, updraft: d.updraft, uh: m.rotation.uh, rain: d.rainRate, gust: d.gust, hail: d.hail, flashes: (total - flashes) * 60 / SAMPLE_EVERY, rotationHeld: m.rotation.persisted, cores: d.cores, outflow: d.outflow, outflowLow: d.outflowLow })
    flashes = total
    progress?.(m.time)
  }
  sample()
  const end = minutes * 60
  while (m.time < end - 1e-6) {
    m.step(DT); m.time += DT
    addSwaths(m, gustMax, uhMax)
    if (m.time - samples[samples.length - 1].t >= SAMPLE_EVERY - 1e-6) sample()
  }
  return { seed: config.seed, samples, nx, ny, width, depth, rainTotal: Float32Array.from(m.precipitation), hailSize: Float32Array.from(m.hailSize), gustMax, uhMax }
}
