// The surface analysis (2.6): what a forecaster draws on a surface chart, from the model's lowest level — the pressure
// at the ground as isobars with its highs and lows, and station plots (temperature, dew point, pressure, wind, weather).
// The domain is ~50-150 km: these are the mesoscale features (the mesohigh under a storm's cold pool, the pressure
// jump behind a front, the mesolow ahead); a cyclone's isobars, hundreds of km across, do not fit in it.
import { type FrontConfig, frontDistance } from './fronts'
import type { Flash } from './lightning'
import { fallSpeed } from './microphysics'
import { mod } from './math'
import { dewpointAt } from './skewt'
import { type StationSource, surfacePressure } from './station'

/** The pressure at the ground of every column, hPa: the base state's plus the model's perturbation, smoothed. */
export function surfacePressureField(m: StationSource, passes = 2) {
  const { nx, ny, layer } = m.grid, p = surfacePressure(m), base = m.env.p[0] / 100
  let field = Float64Array.from(p, v => base + v / 100)
  // A 1-2-1 filter in x and y per pass (an analyst smooths the convective noise; the domain is periodic).
  for (let pass = 0; pass < passes; pass++) {
    const next = new Float64Array(layer)
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let s = 0
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += (2 - Math.abs(i)) * (2 - Math.abs(j)) * field[mod(x + i, nx) + nx * mod(y + j, ny)]
      next[x + nx * y] = s / 16
    }
    field = next
  }
  return field
}

/** Within this distance of the set front line, km, the analysis looks for the edge of the cold air (behind, ahead). */
export const FRONT_SEARCH = [-20, 30] as const

/**
 * Where the cold air really is at the ground (the roadmap's «front by the gradient of θ», 2.8): each column's θ at the
 * lowest level above the ground below the warm sector's (the 75th percentile of the columns ahead of the set line, so
 * neither the storms' cold pools nor a warm spot set it), smoothed like the isobars, K. The front is its contour at
 * half the set contrast: the edge of the air mass as it moves by itself (a density current runs at ~0.7 √(g' h),
 * ~19 m/s for 9 K over 2.5 km, against the line's set speed), not the line the forcing keeps. Outside FRONT_SEARCH of
 * the line, and within `edgeX`, `edgeY` m of relaxed domain edges (the transport is periodic: the cold air leaving the
 * west edge comes in at the east one, where the edge zone damps it — a false front): the full contrast behind, none
 * ahead (an outflow far from the front is no front).
 */
export function coldAirDeficit(m: StationSource & { theta: ArrayLike<number> }, f: FrontConfig, time: number, frame: readonly [number, number], edgeX = 0, edgeY = 0) {
  const { nx, ny, layer, dx, dy, width, depth } = m.grid, s = new Float64Array(layer), theta = new Float64Array(layer), ahead: number[] = []
  for (let c = 0; c < layer; c++) {
    s[c] = frontDistance(f, (c % nx) * dx + frame[0] * time, Math.floor(c / nx) * dy + frame[1] * time, time, width, depth)
    theta[c] = m.theta[c + layer]
  }
  const inEdge = (c: number) => { const x = (c % nx + .5) * dx, y = (Math.floor(c / nx) + .5) * dy; return Math.min(x, width - x) < edgeX || Math.min(y, depth - y) < edgeY }
  for (let c = 0; c < layer; c++) if (s[c] > 5 && s[c] < FRONT_SEARCH[1] && !inEdge(c)) ahead.push(theta[c])
  ahead.sort((a, b) => a - b)
  const warm = ahead.length ? ahead[Math.floor(ahead.length * .75)] : Math.max(...theta)
  let field = Float64Array.from(theta, (t, c) => s[c] < FRONT_SEARCH[0] || (inEdge(c) && s[c] < 0) ? f.contrast : s[c] > FRONT_SEARCH[1] || inEdge(c) ? 0 : warm - t)
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float64Array(layer)
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let sum = 0
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) sum += (2 - Math.abs(i)) * (2 - Math.abs(j)) * field[Math.min(nx - 1, Math.max(0, x + i)) + nx * Math.min(ny - 1, Math.max(0, y + j))]
      next[x + nx * y] = sum / 16
    }
    field = next
  }
  return field
}

/** The isobar interval, hPa: 0.5 when the pressure varies by less than 4 hPa over the domain, else 1 or 2. */
export function isobarStep(field: ArrayLike<number>) {
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < field.length; i++) { lo = Math.min(lo, field[i]); hi = Math.max(hi, field[i]) }
  const range = hi - lo
  return range < 4 ? .5 : range < 10 ? 1 : 2
}

/**
 * Contour segments of a field on the nodes (x, y in node units) at the given level: marching squares, the saddle
 * cells split by the cell's mean. Not across the periodic seam (the map shows one domain).
 */
export function contour(field: ArrayLike<number>, nx: number, ny: number, level: number) {
  const out: [number, number, number, number][] = []
  const at = (a: number, b: number) => (level - a) / (b - a)
  for (let y = 0; y + 1 < ny; y++) for (let x = 0; x + 1 < nx; x++) {
    const v0 = field[x + nx * y], v1 = field[x + 1 + nx * y], v2 = field[x + 1 + nx * (y + 1)], v3 = field[x + nx * (y + 1)]
    const code = (v0 > level ? 1 : 0) | (v1 > level ? 2 : 0) | (v2 > level ? 4 : 0) | (v3 > level ? 8 : 0)
    if (code === 0 || code === 15) continue
    // Edge points: bottom (0-1), right (1-2), top (3-2), left (0-3).
    const e = [[x + at(v0, v1), y], [x + 1, y + at(v1, v2)], [x + at(v3, v2), y + 1], [x, y + at(v0, v3)]] as const
    const seg = (a: number, b: number) => out.push([e[a][0], e[a][1], e[b][0], e[b][1]])
    switch (code) {
      case 1: case 14: seg(3, 0); break
      case 2: case 13: seg(0, 1); break
      case 3: case 12: seg(3, 1); break
      case 4: case 11: seg(1, 2); break
      case 6: case 9: seg(0, 2); break
      case 7: case 8: seg(3, 2); break
      case 5: case 10: {
        const mid = (v0 + v1 + v2 + v3) / 4, high = mid > level
        if ((code === 5) === high) { seg(3, 2); seg(0, 1) } else { seg(3, 0); seg(1, 2) }
        break
      }
    }
  }
  return out
}

/**
 * Highs and lows: nodes that are the extreme within `radius` nodes and stand out from the mean around them by at least
 * `least` hPa (the domain's interior only: an extreme on the edge is a slope going on outside).
 */
export function pressureCentres(field: ArrayLike<number>, nx: number, ny: number, radius = 4, least = .3) {
  const out: { x: number; y: number; high: boolean; value: number }[] = []
  for (let y = radius; y < ny - radius; y++) for (let x = radius; x < nx - radius; x++) {
    const v = field[x + nx * y]
    let max = true, min = true, sum = 0, n = 0
    for (let j = -radius; j <= radius; j++) for (let i = -radius; i <= radius; i++) {
      if (!i && !j) continue
      const w = field[x + i + nx * (y + j)]
      if (w >= v) max = false
      if (w <= v) min = false
      sum += w; n++
    }
    // Closed in both directions: a trough or a ridge (a line of small extremes, as along a front) is not a centre.
    const along = (i: number, j: number) => ((field[x + i + nx * (y + j)] + field[x - i + nx * (y - j)]) / 2 - v) * (max ? -1 : 1)
    if ((max || min) && Math.abs(v - sum / n) >= least && along(radius, 0) >= least / 2 && along(0, radius) >= least / 2) out.push({ x, y, high: max, value: v })
  }
  return out
}

/** A station plot: where (m in the domain), °C, °C, hPa, wind (ground-relative, m/s; meteorological direction °), rain at the ground (mm/h), a thunderstorm nearby, cloud cover (0-1). */
export interface StationPlot { x: number; y: number; temp: number; dew: number; pressure: number; speed: number; dir: number; rain: number; thunder: boolean; cloud: number }

/** The sky a station sees for its cloud cover: columns within this distance, m. */
export const SKY_RADIUS = 4000

/** Rain at the ground of a column, mm/h: rho0 q_r V_t at the lowest level (as ModelDiagnostics.rainRate, rain only). */
export function groundRain(m: Pick<StationSource, 'env' | 'rain'>, c: number) {
  const rho0 = m.env.rho[0]
  return rho0 * m.rain[c] * fallSpeed(m.rain[c], rho0, rho0) * 3600
}

/** How close (m) and how recent (s) a flash makes a thunderstorm at a station (thunder is heard ~10-15 km away). */
export const THUNDER_RANGE = 10_000, THUNDER_TIME = 600

/**
 * Station plots on a regular network every `spacing` m (offset half a spacing from the domain's corner), from the
 * lowest model level. `flashes` with `where` (the flash's point in the domain now) give the thunderstorm symbol.
 */
export function stationPlots(m: StationSource, pressure: ArrayLike<number>, spacing: number, flashes: readonly Flash[] = [], where?: (f: Flash) => { x: number; y: number }) {
  const { nx, ny, dx, dy, width, depth } = m.grid, e = m.env, out: StationPlot[] = []
  const recent = where ? flashes.filter(f => f.time > m.time - THUNDER_TIME).map(where) : []
  for (let y = spacing / 2; y < depth; y += spacing) for (let x = spacing / 2; x < width; x += spacing) {
    const c = Math.min(nx - 1, Math.round(x / dx)) + nx * Math.min(ny - 1, Math.round(y / dy))
    const temp = m.theta[c] * e.exner[0] - 273.15, q = Math.max(1e-6, m.q[c]), u = m.u[c] + m.frame[0], v = m.v[c] + m.frame[1]
    const rain = groundRain(m, c)
    let seen = 0, cloudy = 0
    const rx = Math.ceil(SKY_RADIUS / dx), ry = Math.ceil(SKY_RADIUS / dy), cx = c % nx, cy = Math.floor(c / nx)
    for (let j = -ry; j <= ry; j++) for (let i = -rx; i <= rx; i++) {
      if ((i * dx) ** 2 + (j * dy) ** 2 > SKY_RADIUS ** 2) continue
      const col = mod(cx + i, nx) + nx * mod(cy + j, ny)
      let any = false
      for (let k = col; k < m.cloud.length && !any; k += nx * ny) any = m.cloud[k] + m.ice[k] > 1e-5
      seen++; if (any) cloudy++
    }
    out.push({
      x, y, temp, dew: Math.min(temp, dewpointAt(q, e.p[0])), pressure: pressure[c], speed: Math.hypot(u, v),
      dir: mod(270 - Math.atan2(v, u) * 180 / Math.PI, 360), rain, thunder: recent.some(p => Math.hypot(p.x - x, p.y - y) < THUNDER_RANGE), cloud: cloudy / seen,
    })
  }
  return out
}
