import { L } from '../i18n'
import { G } from './constants'
import type { AtmosphereModel } from './model'
import { reflectivity } from './radar'

/**
 * What the convection is organised into, from the low-level reflectivity (the strongest echo below ORG.level) and, for
 * lines, the model's winds. Notes: .claude/literature/convective-mode-classification.md (05.11.2026; most sources through
 * excerpts, not read in full). Published: an echo object at >= 40 dBZ; a line >= 75 km long and 3:1 (Gallus et al. 2008,
 * WAF 23, 101), a linear MCS > 100 km for > 3 h (Parker & Johnson 2000, MWR 128, 3413); a cluster as a QLCS below 3:1
 * (Smith et al. 2012, WAF 27, 1114); a discrete cell with a maximum >= 50 dBZ (Trapp et al. 2005, WAF 20, 23), a smaller
 * object without one is a weak echo, not a cell (a growing or decaying storm, showers); stratiform
 * >= 30 dBZ over at least twice the line's width, otherwise a line without stratiform (Gallus, after Hilgendorf & Johnson
 * 1998). Bow echoes have no published threshold of curvature (Burke & Schultz 2004 say so, Klimowski et al. 2003 sort them
 * by eye): 40-200 km comes from Klimowski and Weisman 1993. This project's choices, to be calibrated: the sagitta / chord
 * of the leading edge >= ORG.bowSagitta with its apex toward the motion, held ORG.bowHold min; a gap of ORG.gap km still
 * counts as one object ("nearly contiguous"); a broken line's cells at most ORG.brokenGap km apart; a stratiform share of
 * ORG.stratiformShare for trailing, leading or parallel; line-end vortices from ORG.vortex. Below 3 km because the model's graupel cores (63-69 dBZ) and ice
 * would swell the composite. Everything is in km, not in nodes: the field is first coarsened to about ORG.cell km.
 */
export const ORG = {
  /** Height the echo is taken below, m; size of the classifier's cell, km. */ level: 3000, cell: 1,
  core: 40, cellCore: 50, stratiform: 30, lineLength: 75, mcsLength: 100, mcsHours: 3, aspect: 3,
  bowMin: 40, bowMax: 200, bowSagitta: .1, bowHold: 30, gap: 5, brokenGap: 30, stratiformShare: .6,
  /** Rear inflow height, m, its reach behind the leading edge, km (Weisman 1993), and the line-end vorticity that counts, s-1. */
  rearLevel: 2500, rearFrom: 5, rearTo: 40, vortex: .002,
} as const

export type EchoKind = 'weak' | 'cell' | 'cluster' | 'broken-line' | 'line' | 'bow'
export type StratiformKind = 'trailing' | 'leading' | 'parallel' | 'none' | 'mixed'

export const ECHO_KINDS: Record<EchoKind, string> = {
  weak: L('эхо без ядра 50 dBZ', 'echo without a 50 dBZ core'), cell: L('ячейка', 'cell'), cluster: L('кластер', 'cluster'), 'broken-line': L('прерывистая линия', 'broken line'), line: L('линия', 'line'), bow: L('дуга (bow echo)', 'bow echo'),
}
export const STRATIFORM_KINDS: Record<StratiformKind, string> = {
  trailing: L('слоистые осадки сзади (TS)', 'trailing stratiform (TS)'), leading: L('слоистые осадки спереди (LS)', 'leading stratiform (LS)'), parallel: L('слоистые осадки вдоль линии (PS)', 'parallel stratiform (PS)'), none: L('без слоистых осадков', 'no stratiform'), mixed: L('слоистые осадки вокруг', 'stratiform around'),
}

export interface EchoObject {
  kind: EchoKind
  /** Centre and the leading edge's points, km, unwrapped from the object's first cell (may lie outside the domain). */
  x: number; y: number; edge: readonly (readonly [number, number])[]
  /** Length along the long axis, mean width (area / length), km; aspect; area, km²; strongest echo, dBZ; cores >= 50 dBZ. */
  length: number; width: number; aspect: number; area: number; peak: number; cores: number
  /** Axis (unit vector along it) and the normal toward the motion. */ axis: readonly [number, number]; normal: readonly [number, number]
  /** Sagitta / chord of the leading edge, positive when its middle leads. */ sagitta: number
  /** Stratiform echo around a line. */ stratiform: StratiformKind | null
  /** Whether it reaches round the periodic domain, so it may be cut (touches itself). */ wraps: boolean
}

/** The field coarsened by `step` nodes (the strongest echo in each block). */
function coarsen(field: Float32Array, nx: number, ny: number, step: number) {
  const w = Math.max(1, Math.floor(nx / step)), h = Math.max(1, Math.floor(ny / step)), out = new Float32Array(w * h).fill(-Infinity)
  for (let y = 0; y < h * step; y++) for (let x = 0; x < w * step; x++) { const c = Math.floor(x / step) + w * Math.floor(y / step), v = field[x + nx * y]; if (v > out[c]) out[c] = v }
  return { out, w, h }
}

const mod = (a: number, n: number) => ((a % n) + n) % n

/** The connected masks of `on` (8 neighbours, periodic), linked across `reach` cells: for each object its unwrapped cells. */
function components(on: (c: number) => boolean, w: number, h: number, reach: number) {
  const seen = new Uint8Array(w * h), objects: { x: number; y: number }[][] = []
  for (let c = 0; c < w * h; c++) {
    if (seen[c] || !on(c)) continue
    seen[c] = 1
    const cells = [{ x: c % w, y: Math.floor(c / w) }]
    for (let k = 0; k < cells.length; k++) {
      const p = cells[k]
      for (let j = -reach; j <= reach; j++) for (let i = -reach; i <= reach; i++) {
        const n = mod(p.x + i, w) + w * mod(p.y + j, h)
        if (!seen[n] && on(n)) { seen[n] = 1; cells.push({ x: p.x + i, y: p.y + j }) }
      }
    }
    objects.push(cells)
  }
  return objects
}

/**
 * Classifies the echo of a dBZ field `nx` x `ny` with spacing `dx`, `dy` (km), periodic: `motion` (km per unit, any scale)
 * gives the direction a line moves in for its leading edge; absent, the edge is taken toward the larger stratiform side's
 * opposite. Objects in order of decreasing area.
 */
export function classifyEcho(field: Float32Array, nx: number, ny: number, dx: number, dy: number, motion: readonly [number, number] = [0, 0]): EchoObject[] {
  const step = Math.max(1, Math.round(ORG.cell / Math.min(dx, dy))), { out: z, w, h } = coarsen(field, nx, ny, step), cx = dx * step, cy = dy * step
  const reach = Math.max(1, Math.ceil(ORG.gap / 2 / Math.min(cx, cy)))
  const objects = components(c => z[c] >= ORG.core, w, h, reach), echoes: EchoObject[] = []
  // The >= ORG.stratiform echo in joined pieces: a line's stratiform is only what is joined to it.
  const joined = new Int32Array(w * h).fill(-1)
  components(c => z[c] >= ORG.stratiform, w, h, 1).forEach((piece, k) => { for (const p of piece) joined[mod(p.x, w) + w * mod(p.y, h)] = k })
  for (const cells of objects) {
    const area = cells.length * cx * cy
    if (area < cx * cy * 3) continue
    let sx = 0, sy = 0
    for (const p of cells) { sx += p.x * cx; sy += p.y * cy }
    const mx = sx / cells.length, my = sy / cells.length
    let xx = 0, yy = 0, xy = 0
    for (const p of cells) { const a = p.x * cx - mx, b = p.y * cy - my; xx += a * a; yy += b * b; xy += a * b }
    const angle = .5 * Math.atan2(2 * xy, xx - yy), axis: [number, number] = [Math.cos(angle), Math.sin(angle)]
    let normal: [number, number] = [-axis[1], axis[0]]
    if (normal[0] * motion[0] + normal[1] * motion[1] < 0) normal = [-normal[0], -normal[1]]
    let lo = Infinity, hi = -Infinity, peak = -Infinity
    for (const p of cells) { const s = (p.x * cx - mx) * axis[0] + (p.y * cy - my) * axis[1]; lo = Math.min(lo, s); hi = Math.max(hi, s); peak = Math.max(peak, z[mod(p.x, w) + w * mod(p.y, h)]) }
    const length = hi - lo + Math.min(cx, cy), width = area / length, aspect = length / width
    // The leading edge: per 2 km along the axis the cell farthest along the normal.
    const bins = Math.max(1, Math.ceil(length / 2)), front = new Float64Array(bins).fill(-Infinity)
    for (const p of cells) {
      const a = p.x * cx - mx, b = p.y * cy - my, s = a * axis[0] + b * axis[1], n = a * normal[0] + b * normal[1], k = Math.min(bins - 1, Math.floor((s - lo) / 2))
      if (n > front[k]) front[k] = n
    }
    const edge: [number, number][] = []
    for (let k = 0; k < bins; k++) if (front[k] > -Infinity) { const s = lo + (k + .5) * 2; edge.push([mx + axis[0] * s + normal[0] * front[k], my + axis[1] * s + normal[1] * front[k]]) }
    const along = (a: number, b: number) => { let sum = 0, n = 0; for (let k = Math.floor(a * bins); k < Math.ceil(b * bins); k++) if (front[k] > -Infinity) { sum += front[k]; n++ } return n ? sum / n : 0 }
    const sagitta = (along(.4, .6) - (along(0, .05) + along(.95, 1)) / 2) / length
    // Cores: the >= 50 dBZ parts of the object.
    const inside = new Set(cells.map(p => mod(p.x, w) + w * mod(p.y, h)))
    const cores = components(c => inside.has(c) && z[c] >= ORG.cellCore, w, h, 1).length
    const line = length >= ORG.lineLength && aspect >= ORG.aspect
    const bow = aspect >= ORG.aspect && length >= ORG.bowMin && length <= ORG.bowMax && sagitta >= ORG.bowSagitta
    const kind: EchoKind = bow ? 'bow' : line ? 'line' : cores >= 2 || length >= ORG.mcsLength ? 'cluster' : cores ? 'cell' : 'weak'
    const wraps = hi - lo >= (Math.abs(axis[0]) * w * cx + Math.abs(axis[1]) * h * cy) * .9
    echoes.push({ kind, x: mx, y: my, edge, length, width, aspect, area, peak, cores, axis, normal, sagitta, stratiform: line || bow ? stratiformOf(z, w, h, cx, cy, mx, my, axis, normal, lo, hi, width, joined, joined[mod(cells[0].x, w) + w * mod(cells[0].y, h)]) : null, wraps })
  }
  echoes.sort((a, b) => b.area - a.area)
  return [...echoes, ...brokenLines(echoes, w * cx, h * cy, motion)].sort((a, b) => b.area - a.area)
}

/**
 * Where the stratiform echo lies around a line: behind, ahead or along it (the share of ORG.stratiformShare), none if too
 * little. Only the 30-40 dBZ echo joined to the line (piece `own` of `joined`) within 120 km counts, not other cells' edges.
 */
function stratiformOf(z: Float32Array, w: number, h: number, cx: number, cy: number, mx: number, my: number, axis: readonly [number, number], normal: readonly [number, number], lo: number, hi: number, width: number, joined: Int32Array, own: number): StratiformKind {
  const reach = 120
  let behind = 0, ahead = 0, ends = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = z[x + w * y]
    if (v < ORG.stratiform || v >= ORG.core || joined[x + w * y] !== own) continue
    const a = wrap(x * cx - mx, w * cx), b = wrap(y * cy - my, h * cy), s = a * axis[0] + b * axis[1], n = a * normal[0] + b * normal[1]
    if (Math.abs(n) > reach || s < lo - reach || s > hi + reach) continue
    if (s < lo || s > hi) ends++
    else if (n < 0) behind++
    else ahead++
  }
  const area = (behind + ahead + ends) * cx * cy, all = behind + ahead + ends
  if (area < 2 * width * (hi - lo)) return 'none'
  return behind / all >= ORG.stratiformShare ? 'trailing' : ahead / all >= ORG.stratiformShare ? 'leading' : ends / all >= ORG.stratiformShare ? 'parallel' : 'mixed'
}

const wrap = (a: number, n: number) => a - n * Math.round(a / n)

/** Discrete cells in a row: chains of cells and clusters at most ORG.brokenGap km apart that make a line by their centres. */
function brokenLines(echoes: EchoObject[], width: number, depth: number, motion: readonly [number, number]) {
  // Weak echoes count too: a broken line's cells may be growing or decaying (Gallus et al. 2008 classify by 40 dBZ).
  const parts = echoes.filter(e => e.kind === 'weak' || e.kind === 'cell' || e.kind === 'cluster'), used = new Set<number>(), out: EchoObject[] = []
  const near = (a: EchoObject, b: EchoObject) => Math.hypot(wrap(a.x - b.x, width), wrap(a.y - b.y, depth)) - (a.length + b.length) / 2 <= ORG.brokenGap
  for (let i = 0; i < parts.length; i++) {
    if (used.has(i)) continue
    const group = [i]
    used.add(i)
    for (let k = 0; k < group.length; k++) for (let j = 0; j < parts.length; j++) if (!used.has(j) && near(parts[group[k]], parts[j])) { used.add(j); group.push(j) }
    if (group.length < 3) continue
    const first = parts[group[0]], at = group.map(g => [first.x + wrap(parts[g].x - first.x, width), first.y + wrap(parts[g].y - first.y, depth)] as const)
    const mx = at.reduce((s, p) => s + p[0], 0) / at.length, my = at.reduce((s, p) => s + p[1], 0) / at.length
    let xx = 0, yy = 0, xy = 0
    for (const [a, b] of at) { xx += (a - mx) ** 2; yy += (b - my) ** 2; xy += (a - mx) * (b - my) }
    const angle = .5 * Math.atan2(2 * xy, xx - yy), axis: [number, number] = [Math.cos(angle), Math.sin(angle)]
    let normal: [number, number] = [-axis[1], axis[0]]
    if (normal[0] * motion[0] + normal[1] * motion[1] < 0) normal = [-normal[0], -normal[1]]
    const along = at.map(p => (p[0] - mx) * axis[0] + (p[1] - my) * axis[1]), across = at.map(p => (p[0] - mx) * normal[0] + (p[1] - my) * normal[1])
    const length = Math.max(...along) - Math.min(...along) + group.reduce((s, g) => s + parts[g].length, 0) / group.length, wide = 2 * Math.max(...across.map(Math.abs)) + group.reduce((s, g) => s + parts[g].width, 0) / group.length
    if (length < ORG.lineLength || length / wide < ORG.aspect) continue
    const edge = at.map((p, k) => [k, along[k], p] as const).sort((a, b) => a[1] - b[1]).map(e => e[2])
    out.push({ kind: 'broken-line', x: mx, y: my, edge, length, width: wide, aspect: length / wide, area: group.reduce((s, g) => s + parts[g].area, 0), peak: Math.max(...group.map(g => parts[g].peak)), cores: group.reduce((s, g) => s + parts[g].cores, 0), axis, normal, sagitta: 0, stratiform: null, wraps: false })
  }
  return out
}

/** The strongest echo below ORG.level in each column of the model (dBZ, row-major nx x ny). */
export function lowEcho(m: Pick<AtmosphereModel, 'grid' | 'env' | 'theta' | 'rain' | 'snow' | 'graupel' | 'hail'>) {
  const { nx, ny, layer, zs, nz } = m.grid, e = m.env, out = new Float32Array(layer).fill(-30)
  for (let z = 0; z < nz && zs[z] <= ORG.level; z++) {
    const rho = e.rho[z], exner = e.exner[z]
    for (let c = 0, i = z * layer; c < nx * ny; c++, i++) {
      const rain = m.rain[i], snow = m.snow[i], graupel = m.graupel[i], hail = m.hail[i]
      if (rain <= 0 && snow <= 0 && graupel <= 0 && hail <= 0) continue
      const d = reflectivity(rho, rain, snow, graupel, m.theta[i] * exner - 273.15, hail)
      if (d > out[c]) out[c] = d
    }
  }
  return out
}

export interface LineDynamics {
  /** Cold pool at the leading edge (0-10 km behind the middle third): speed, m/s, depth, km; the low-level shear across the line, m/s; C / du. */
  c: number; depth: number; shear: number; balance: number
  /** Strongest system-relative wind toward the front at ORG.rearLevel, 5-40 km behind the middle third and 0-5 km behind it, m/s. */
  rear: number; atFront: number
  /** Strongest cyclonic and anticyclonic vorticity at that level near each end of the line (s-1), and whether they make a pair. */
  ends: [[number, number], [number, number]]; bookends: boolean
}

/** The system behind a line: its cold pool against the shear (RKW), the rear inflow and the line-end vortices. `speed`: its ground speed along the normal, m/s. */
export function lineDynamics(m: AtmosphereModel, line: EchoObject, speed: number): LineDynamics | null {
  const g = m.grid, { nx, ny, nz, dx, dy, zs, hz, layer } = g, e = m.env, [fu, fv] = m.frame, n = line.edge.length
  if (n < 5) return null
  const [nu, nv] = line.normal, k25 = zs.findIndex(z => z >= ORG.rearLevel), node = (xkm: number, ykm: number) => mod(Math.round(xkm * 1000 / dx), nx) + nx * mod(Math.round(ykm * 1000 / dy), ny)
  const column = (c: number) => {
    let integral = 0, top = 0
    for (let k = 0, i = c; k < nz; k++, i += layer) {
      const b = G * (m.theta[i] * (1 + .61 * m.q[i]) / (e.theta[k] * (1 + .61 * e.q[k])) - 1 - m.cloud[i] - m.rain[i] - m.ice[i] - m.snow[i] - m.graupel[i] - m.hail[i])
      if (b >= 0) break
      integral -= b * hz[k]; top = zs[k] + hz[k] / 2
    }
    return [Math.sqrt(2 * integral), top / 1000]
  }
  let cSum = 0, depthSum = 0, count = 0, rear = -Infinity, atFront = -Infinity
  for (let k = Math.floor(n / 3); k < Math.ceil(2 * n / 3); k++) {
    const [ex, ey] = line.edge[k]
    for (let b = 0; b <= ORG.rearTo; b += 2) {
      const c = node(ex - nu * b, ey - nv * b)
      if (b <= 10 && m.theta[c] - e.theta[0] <= -1) { const [s, h] = column(c); cSum += s; depthSum += h; count++ }
      const i = c + k25 * layer, wind = (m.u[i] + fu) * nu + (m.v[i] + fv) * nv - speed
      if (b >= ORG.rearFrom) rear = Math.max(rear, wind)
      if (b <= ORG.rearFrom) atFront = Math.max(atFront, wind)
    }
  }
  const [u0, v0] = e.windUV(0), [u1, v1] = e.windUV(2500), shear = Math.abs((u1 - u0) * nu + (v1 - v0) * nv), c = count ? cSum / count : 0
  const ends: [[number, number], [number, number]] = [[0, 0], [0, 0]]
  for (const [side, from, to] of [[0, 0, Math.ceil(n * .25)], [1, Math.floor(n * .75), n]] as const) for (let k = from; k < to; k++) {
    const [ex, ey] = line.edge[k]
    for (let b = -4; b <= 30; b += 2) {
      const c = node(ex - nu * b, ey - nv * b), z = m.zeta(c % nx, Math.floor(c / nx), k25)
      ends[side][0] = Math.max(ends[side][0], z); ends[side][1] = Math.min(ends[side][1], z)
    }
  }
  // Bookends as Weisman (1993): cyclonic at the left end looking along the motion, anticyclonic at the right. Side 0 is
  // the low end of the axis; it is the left one when the axis points to the right of the motion.
  const left = line.axis[0] * -nv + line.axis[1] * nu < 0 ? 0 : 1
  return { c, depth: count ? depthSum / count : 0, shear, balance: shear > .1 ? c / shear : 0, rear, atFront, ends, bookends: ends[left][0] >= ORG.vortex && ends[1 - left][1] <= -ORG.vortex }
}

export interface TrackedEcho extends EchoObject {
  /** Model minutes it has been of this kind; ground velocity of the object, m/s, when known; whether it has held long enough. */
  minutes: number; motion: readonly [number, number] | null; held: boolean
  dynamics: LineDynamics | null
}

/** Follows the classified objects through a run: how long each stays what it is, how it moves, whether it counts as held. */
export class EchoTracker {
  private last: { x: number; y: number; kind: EchoKind; since: number; bowSince: number; time: number; motion: readonly [number, number] | null }[] = []

  update(m: AtmosphereModel): TrackedEcho[] {
    const { nx, ny, dx, dy, width, depth } = m.grid, time = m.time, [fu, fv] = m.frame, [ox, oy] = m.frameOffset()
    const mean = this.last.find(o => o.motion)?.motion ?? (fu || fv ? [fu, fv] as const : m.env.windUV(3000))
    const objects = classifyEcho(lowEcho(m), nx, ny, dx / 1000, dy / 1000, mean), next: typeof this.last = []
    const out: TrackedEcho[] = objects.map(o => {
      const gx = o.x + ox / 1000, gy = o.y + oy / 1000, W = width / 1000, D = depth / 1000
      let best: (typeof this.last)[number] | null = null, nearest = 30
      for (const p of this.last) { const d = Math.hypot(wrap(gx - p.x, W), wrap(gy - p.y, D)); if (d < nearest) { nearest = d; best = p } }
      const dt = best ? time - best.time : 0
      const motion = best && dt > 0 ? smooth(best.motion, [wrap(gx - best.x, W) * 1000 / dt, wrap(gy - best.y, D) * 1000 / dt]) : null
      const since = best && same(best.kind, o.kind) ? best.since : time, minutes = (time - since) / 60, bowSince = best && best.kind === 'bow' && o.kind === 'bow' ? best.bowSince : time
      next.push({ x: gx, y: gy, kind: o.kind, since, bowSince, time, motion })
      const held = o.kind === 'bow' ? (time - bowSince) / 60 >= ORG.bowHold : o.kind === 'line' ? minutes >= ORG.mcsHours * 60 : true
      const lineLike = o.kind === 'line' || o.kind === 'bow'
      const speed = motion ? motion[0] * o.normal[0] + motion[1] * o.normal[1] : 0
      return { ...o, minutes, motion, held, dynamics: lineLike ? lineDynamics(m, o, speed) : null }
    })
    this.last = next
    return out
  }
}

const same = (a: EchoKind, b: EchoKind) => a === b || (a === 'line' && b === 'bow') || (a === 'bow' && b === 'line')
const smooth = (a: readonly [number, number] | null, b: readonly [number, number]): readonly [number, number] => a ? [a[0] * .7 + b[0] * .3, a[1] * .7 + b[1] * .3] : b
