// A virtual weather station: a point fixed to the ground (the domain moves over it with the storm) that records, like a
// real automatic station, the air temperature and dewpoint, the pressure, the wind with its gusts and the precipitation,
// one record a model minute. A gust front passing shows as on a real barogram and thermogram: a pressure jump, a sharp
// temperature fall and a gust; a downpour as the rain rate and total.
import { G } from './constants'
import type { Environment } from './environment'
import type { Grid } from './grid'
import { mod } from './math'
import { dewpointAt } from './skewt'

/** What the station reads from a model (the running one or the UI's mirror of it). */
export interface StationSource {
  grid: Grid; env: Environment; frame: readonly [number, number]; time: number
  theta: ArrayLike<number>; q: ArrayLike<number>; u: ArrayLike<number>; v: ArrayLike<number>
  cloud: ArrayLike<number>; rain: ArrayLike<number>; ice: ArrayLike<number>; snow: ArrayLike<number>; graupel: ArrayLike<number>; hail: ArrayLike<number>
  /** Rain and hail on the ground since the start, mm, per ground column (fixed to the ground, see AtmosphereModel). */
  precipitation: ArrayLike<number>; hailGround: ArrayLike<number>
  /** The model's projection pressure (p'/rho0 at the dual cells, see PressureSolver), if it has one. */
  pressure?: ArrayLike<number>
}

/** A ground point (m from the ground origin) to the domain point (m from the domain corner) over it now, and back. */
export function domainPoint(m: Pick<StationSource, 'grid' | 'frame' | 'time'>, gx: number, gy: number) {
  const { width, depth } = m.grid
  return { x: mod(gx - m.frame[0] * m.time, width), y: mod(gy - m.frame[1] * m.time, depth) }
}
export function groundPoint(m: Pick<StationSource, 'grid' | 'frame' | 'time'>, x: number, y: number) {
  const { width, depth } = m.grid
  return { x: mod(x + m.frame[0] * m.time, width), y: mod(y + m.frame[1] * m.time, depth) }
}

/**
 * Surface pressure perturbation of every column, Pa: the model's own pressure (the anelastic projection: buoyancy and
 * the dynamic part together) in the lowest layer of cells, rho0 p', minus the domain mean. Under a narrow, deep column
 * the hydrostatic estimate (hydrostaticPressure) is 2-4 times too strong (a storm's updraught is no wide slab: the
 * reviewer's measurement on the classic supercell, 2.6.1); a mesocyclone's low is in it. Before the model's first step
 * (a run just opened from a file: the pressure is not saved) the hydrostatic estimate stands in.
 */
export function surfacePressure(m: StationSource) {
  const { nx, ny, layer } = m.grid, p = m.pressure, out = new Float64Array(layer)
  let any = false
  if (p && p.length >= layer) for (let c = 0; c < layer; c++) if (p[c] !== 0) { any = true; break }
  if (!any) return hydrostaticPressure(m)
  // The lowest cells lie between node levels 0 and 1, centred on the nodes' squares: average the four around a node.
  const rho = m.env.rho[0]
  let mean = 0
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const xm = (x + nx - 1) % nx, ym = (y + ny - 1) % ny, v = (p![x + nx * y] + p![xm + nx * y] + p![x + nx * ym] + p![xm + nx * ym]) / 4 * rho
    out[x + nx * y] = v; mean += v
  }
  mean /= layer
  for (let c = 0; c < layer; c++) out[c] -= mean
  return out
}

/**
 * Surface pressure perturbation of every column, Pa, hydrostatic: p'(0) = -∫ rho0 B dz with the buoyancy
 * B = g (θv'/θv0 - condensate), zero at the top, minus the domain mean (the anelastic model knows pressure only up to a
 * constant). A cold pool 5 K deep 1 km gives ~+2 hPa (a mesohigh); the dynamic part under a rotating updraught is not in it.
 */
export function hydrostaticPressure(m: StationSource) {
  const { nz, layer, hz } = m.grid, e = m.env, out = new Float64Array(layer)
  for (let k = 0; k < nz; k++) {
    const thv0 = e.theta[k] * (1 + .61 * e.q[k]), w = e.rho[k] * G * hz[k]
    for (let c = 0, i = k * layer; c < layer; c++, i++) {
      const b = m.theta[i] * (1 + .61 * m.q[i]) / thv0 - 1 - m.cloud[i] - m.rain[i] - m.ice[i] - m.snow[i] - m.graupel[i] - m.hail[i]
      out[c] -= w * b
    }
  }
  let mean = 0
  for (let c = 0; c < layer; c++) mean += out[c]
  mean /= layer
  for (let c = 0; c < layer; c++) out[c] -= mean
  return out
}

/** One record: model time (s), °C, °C, hPa, m/s (mean over the minute), m/s (strongest), ° (from), mm/h, mm, mm. */
export interface StationRecord { t: number; temp: number; dew: number; pressure: number; wind: number; gust: number; dir: number; rainRate: number; rainTotal: number; hail: number }

/** Seconds of model time per record. */
export const STATION_RECORD = 60

export class Station {
  readonly records: StationRecord[] = []
  private gust = 0; private su = 0; private sv = 0; private n = 0; private start = NaN; private lastTotal = 0
  /** Ground position, m (it stays put while the domain moves over it). */
  readonly x: number; readonly y: number
  constructor(x: number, y: number) { this.x = x; this.y = y }

  /** Bilinear value of a ground-level field at the station now. */
  private sample(m: StationSource, f: ArrayLike<number>) {
    const { nx, ny, dx, dy } = m.grid, p = domainPoint(m, this.x, this.y), fx = p.x / dx, fy = p.y / dy
    const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0, x1 = (x0 + 1) % nx, y1 = (y0 + 1) % ny, r0 = (y0 % ny) * nx, r1 = y1 * nx
    return (1 - ax) * (1 - ay) * f[x0 % nx + r0] + ax * (1 - ay) * f[x1 + r0] + (1 - ax) * ay * f[x0 % nx + r1] + ax * ay * f[x1 + r1]
  }

  /** The ground column under the station (precipitation is kept per ground column). */
  private groundColumn(m: StationSource) { const { nx, ny, dx, dy } = m.grid; return mod(Math.round(this.x / dx), nx) + nx * mod(Math.round(this.y / dy), ny) }

  /** Call after every model update: keeps the gust and the mean wind, writes a record every STATION_RECORD s. */
  observe(m: StationSource) {
    if (this.records.length && m.time < this.records[this.records.length - 1].t) { this.records.length = 0; this.start = NaN }
    const u = this.sample(m, m.u) + m.frame[0], v = this.sample(m, m.v) + m.frame[1]
    this.gust = Math.max(this.gust, Math.hypot(u, v)); this.su += u; this.sv += v; this.n++
    if (Number.isNaN(this.start)) { this.start = m.time; this.lastTotal = m.precipitation[this.groundColumn(m)]; this.write(m, 0); return }
    const last = this.records[this.records.length - 1]
    if (m.time - last.t >= STATION_RECORD) this.write(m, m.time - last.t)
  }

  private write(m: StationSource, span: number) {
    const e = m.env, g = this.groundColumn(m), total = m.precipitation[g], q = this.sample(m, m.q)
    const temp = this.sample(m, m.theta) * e.exner[0] - 273.15, pressure = (e.p[0] + this.sample(m, surfacePressure(m))) / 100
    const wu = this.su / this.n, wv = this.sv / this.n
    this.records.push({
      t: m.time, temp, dew: Math.min(temp, dewpointAt(Math.max(1e-6, q), e.p[0])), pressure,
      wind: Math.hypot(wu, wv), gust: this.gust, dir: mod(270 - Math.atan2(wv, wu) * 180 / Math.PI, 360),
      rainRate: span > 0 ? (total - this.lastTotal) / span * 3600 : 0, rainTotal: total, hail: m.hailGround[g],
    })
    this.lastTotal = total; this.gust = 0; this.su = this.sv = 0; this.n = 0
  }
}
