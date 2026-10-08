import { graupelFallSpeed } from './graupel'
import { hailFallSpeed } from './hail'
import { snowFallSpeed } from './ice'
import { fallSpeed } from './microphysics'
import { type AtmosphereModel, MESO_CORE_ZETA, MESO_PERSISTENCE, UH_ROTATING } from './model'

/** Updraught core of a cell: columns with w above this (m/s) in cloud somewhere between CORE_BASE and CORE_TOP. */
export const CELL_W = 4
/** A new cell needs at least this updraught in its core, m/s (weaker cores only carry on cells already tracked). */
export const CELL_START_W = 6
const CORE_BASE = 1500, CORE_TOP = 10_000
/** Columns up to this distance (m) from a cell's centre, and nearer to it than to any other cell, form its storm area. */
export const CELL_REACH = 10_000
/** Rain (and melting ice) reaching the ground in the storm area that makes a cell mature, mm/h. */
export const MATURE_RAIN = 1
/** Cold-pool indicator at the ground (K) under the low-level rotation that marks an occlusion: the RFD gust front under it. */
export const OCCLUSION_COLD = 2
/** A new stage must hold this long (s of model time) before the cell switches to it, so noise does not flip it back and forth. */
export const STAGE_HOLD = 60
/** A core gets a number once it has lasted this long, s: fragments that split off a storm and merge back within a minute or two do not. */
export const CELL_CONFIRM = 120
/** Motion is the displacement of the centre over this window, s. */
const MOTION_WINDOW = 300

export type CellStage = 'growing' | 'mature' | 'dissipating' | 'rotating' | 'supercell' | 'occluding' | 'cycling' | 'supercell-weak' | 'supercell-decay' | 'left-supercell'

export const CELL_STAGES: Record<CellStage, { name: string; hint: string }> = {
  growing: { name: 'Кучевая стадия', hint: 'восходящий поток растёт, осадки ещё не дошли до земли' },
  mature: { name: 'Зрелая стадия', hint: 'дождь у земли; восходящий и нисходящий потоки рядом' },
  dissipating: { name: 'Распад', hint: 'восходящий поток ослаб, преобладают нисходящий поток и дождь' },
  rotating: { name: 'Развитие мезоциклона', hint: 'восходящий поток сам вращается циклонически (завихренность ядра на 2–5 км выше порога)' },
  supercell: { name: 'Суперячейка: зрелая', hint: 'мезоциклон держится 10 минут и дольше' },
  occluding: { name: 'Суперячейка: окклюзия', hint: 'холодный отток подтёк под низкое вращение, мезоциклон слабеет' },
  cycling: { name: 'Суперячейка: новый мезоциклон', hint: 'после окклюзии вращение снова усилилось — циклический перезапуск' },
  'supercell-weak': { name: 'Суперячейка: вращение ослабло', hint: 'поток ещё сильный, но вращение ядра ниже порога мезоциклона' },
  'supercell-decay': { name: 'Суперячейка: распад', hint: 'и восходящий поток, и вращение ослабли' },
  'left-supercell': { name: 'Левая суперячейка', hint: 'антициклоническое вращение 10+ минут — левая ячейка после расщепления' },
}

/** Statistics of one cell over its storm area (the core plus the columns around it that are nearest to it). */
export interface CellStats {
  /** Strongest up- and downdraught, m/s. */ updraft: number; downdraft: number
  /** Largest cyclonic and anticyclonic updraft helicity 2-5 km, m2/s2. */ uh: number; anticyclonic: number
  /** Largest cyclonic updraft helicity 0-1 and 0-3 km, m2/s2. */ uh01: number; uh03: number
  /** Highest cloud (water or ice), km. */ cloudTop: number
  /** Heaviest precipitation at the ground, mm/h. */ rainRate: number
  /** Strongest cold-pool indicator below 1.5 km, K. */ coldPool: number
  /** Cold-pool indicator at the ground under the low-level rotation (or the updraught when there is none), K. */ coldUnder: number
  /** Area of the updraught core, km2. */ area: number
  /**
   * Rotation of the updraught core itself: w-weighted mean vertical vorticity at 2-5 km over the core's columns (s-1;
   * negative = anticyclonic), as RotationState.coreZeta; a vortex pair on the flanks cancels.
   */
  coreZeta: number
}

export interface Cell {
  /** Number of the cell, from 1; 0 while it is new and not yet confirmed (see CELL_CONFIRM). */
  id: number
  /** The cell this one split from, or null. */ parent: number | null
  /** How it started: from a thermal, by splitting off another cell, or on a gust front (cold air under its core). */ origin: 'thermal' | 'split' | 'gust-front'
  /** Model time of the first detection, s. */ born: number
  /** Centre of the updraught core, m from the domain corner, and its motion, m/s. */ x: number; y: number; u: number; v: number
  stats: CellStats
  stage: CellStage; /** Model time the stage began, s. */ since: number
  peakW: number; peakUH: number
  /** Time the cyclonic (anticyclonic) mesocyclone criterion has held without a break, s. */ meso: number; antiMeso: number
  /** Has been a supercell (the mesocyclone held MESO_PERSISTENCE), a left mover, has gone through an occlusion. */
  supercell: boolean; leftMover: boolean; occluded: boolean
  /** Grid columns of the updraught core. */ columns: Int32Array
  pending: CellStage; pendingSince: number
  /** Recent centres, unwrapped across the periodic edges, for the motion. */ trail: { t: number; x: number; y: number }[]
}

/** What the cell's numbers say its stage is now (before the STAGE_HOLD smoothing). */
export function cellStage(c: Pick<Cell, 'supercell' | 'leftMover' | 'occluded' | 'peakW' | 'peakUH'> & { age: number; stage?: CellStage }, s: CellStats): CellStage {
  // The updraught core itself must rotate (its own columns only, so a left mover splitting off does not cancel it).
  const weak = s.updraft < .45 * c.peakW, rotating = s.coreZeta >= MESO_CORE_ZETA
  if (c.supercell) {
    if (weak && !rotating) return 'supercell-decay'
    if (s.coldUnder >= OCCLUSION_COLD && s.uh < .7 * c.peakUH) return 'occluding'
    if (rotating) return c.occluded ? 'cycling' : 'supercell'
    return 'supercell-weak'
  }
  if (c.leftMover && !weak) return 'left-supercell'
  if ((weak && c.age > 300) || (s.downdraft > s.updraft && s.rainRate >= MATURE_RAIN)) return 'dissipating'
  if (rotating) return 'rotating'
  return s.rainRate >= MATURE_RAIN ? 'mature' : 'growing'
}

interface Region { cols: number[]; x: number; y: number; peak: number; uh: number }

/**
 * Finds the convective cells (connected updraught cores) in every snapshot and follows them in time, so that a cell keeps
 * its number and its statistics while it moves. A cell continues where its core, shifted by its own motion, overlaps a
 * new core; when a core splits, the part with the strongest cyclonic rotation (otherwise the larger overlap) keeps the
 * number (the right mover stays the same cell) and the rest become new cells; when cores merge, the supercell, then the
 * older cell keeps the number. Each cell gets a stage (see CELL_STAGES) from its own storm area.
 */
export class CellTracker {
  /** All followed cores, including the new ones not yet confirmed (id 0). */
  private tracks: Cell[] = []
  /** The confirmed cells: cores that have lasted CELL_CONFIRM, in the order of their numbers. */
  get cells() { return this.tracks.filter(c => c.id > 0) }
  /** Cells that ended at the last update: merged into another (`into`) or decayed (null). */
  ended: { id: number; into: number | null }[] = []
  time = NaN
  private nextId = 1

  /** The cell nearest to a ground point (m) within `reach` m, or null. */
  nearest(x: number, y: number, model: AtmosphereModel, reach = 8000) {
    let best: Cell | null = null, bestD = reach
    for (const c of this.cells) { const d = distance(model, x, y, c.x, c.y); if (d < bestD) { bestD = d; best = c } }
    return best
  }

  find(id: number | null) { return id === null ? null : this.cells.find(c => c.id === id) ?? null }

  update(m: AtmosphereModel) {
    const { nx, ny, nz, layer, dx, dy, zs, hz } = m.grid, time = m.time
    if (time === this.time) return
    if (!(time > this.time)) { this.tracks = []; this.nextId = 1 }
    const dt = Number.isNaN(this.time) || !(time > this.time) ? 0 : time - this.time
    this.time = time; this.ended = []
    // Per column: the updraught core, the strongest up/downdraught, cloud top, ground rain, cold pool and low-level UH.
    const core = new Float32Array(layer), up = new Float32Array(layer), down = new Float32Array(layer), top = new Float32Array(layer)
    const rain = new Float32Array(layer), cold = new Float32Array(layer), uh01 = new Float32Array(layer), uh03 = new Float32Array(layer)
    const rho0 = m.env.rho[0], top1 = zs.findLastIndex(z => z <= 1000), top3 = zs.findLastIndex(z => z <= 3000)
    for (let c = 0; c < layer; c++) {
      const r = m.rain[c], s = m.snow[c], g = m.graupel[c], h = m.hail[c]
      rain[c] = rho0 * (r * fallSpeed(r, rho0, rho0) + s * snowFallSpeed(s, rho0, rho0) + g * graupelFallSpeed(g, rho0) + h * hailFallSpeed(h, rho0)) * 3600
    }
    for (let z = 0, i = 0; z < nz; z++) {
      const alt = zs[z], inCore = alt >= CORE_BASE && alt <= CORE_TOP
      for (let c = 0; c < layer; c++, i++) {
        const w = m.w[i], condensate = m.cloud[i] + m.ice[i]
        if (w > up[c]) up[c] = w
        if (-w > down[c]) down[c] = -w
        if (condensate > 7e-5) top[c] = alt / 1000
        if (inCore && condensate > 1e-5 && w > core[c]) core[c] = w
        if (alt < 1500 && m.cold[i] > cold[c]) cold[c] = m.cold[i]
      }
    }
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let low = 0
      for (let z = 1; z <= top3; z++) { low += m.w[x + nx * y + z * layer] * m.zeta(x, y, z) * hz[z]; if (z === top1) uh01[x + nx * y] = low }
      uh03[x + nx * y] = low
    }

    // Connected cores (8 neighbours, periodic), with the centre weighted by the updraught and unwrapped across the edges.
    const label = new Int32Array(layer).fill(-1), regions: Region[] = [], ux = new Int32Array(layer), uy = new Int32Array(layer)
    for (let start = 0; start < layer; start++) {
      if (core[start] < CELL_W || label[start] >= 0) continue
      const id = regions.length, cols: number[] = [], stack = [start]
      label[start] = id; ux[start] = start % nx; uy[start] = Math.floor(start / nx)
      let sw = 0, sx = 0, sy = 0, peak = 0, uh = 0
      while (stack.length) {
        const a = stack.pop()!, x = a % nx, y = Math.floor(a / nx), wt = core[a] - CELL_W + .5
        cols.push(a); sw += wt; sx += wt * ux[a]; sy += wt * uy[a]; peak = Math.max(peak, core[a]); uh = Math.max(uh, m.uhColumn[a])
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const b = mod(x + ox, nx) + nx * mod(y + oy, ny)
          if (label[b] >= 0 || core[b] < CELL_W) continue
          label[b] = id; ux[b] = ux[a] + ox; uy[b] = uy[a] + oy; stack.push(b)
        }
      }
      regions.push({ cols, x: mod(sx / sw, nx) * dx, y: mod(sy / sw, ny) * dy, peak, uh })
    }

    // Each old cell, shifted by its motion, claims the new core it overlaps most (the most cyclonic one after a split).
    const overlaps = this.tracks.map(c => {
      const sx = Math.round(c.u * dt / dx), sy = Math.round(c.v * dt / dy), hits = new Map<number, number>()
      for (const a of c.columns) { const l = label[mod(a % nx + sx, nx) + nx * mod(Math.floor(a / nx) + sy, ny)]; if (l >= 0) hits.set(l, (hits.get(l) ?? 0) + 1) }
      if (!hits.size) {
        // No overlap (a small core that moved a full column): the nearest core within 4 km of where it should be now.
        const px = c.x + c.u * dt, py = c.y + c.v * dt
        let best = -1, bestD = 4000
        regions.forEach((r, k) => { const d = distance(m, px, py, r.x, r.y); if (d < bestD) { bestD = d; best = k } })
        if (best >= 0) hits.set(best, 1)
      }
      return hits
    })
    const claims = new Map<number, number[]>()
    this.tracks.forEach((_, k) => {
      const hits = [...overlaps[k]]
      if (!hits.length) return
      const rotating = hits.filter(([r]) => regions[r].uh >= UH_ROTATING)
      const [choice] = rotating.length ? rotating.sort((a, b) => regions[b[0]].uh - regions[a[0]].uh)[0] : hits.sort((a, b) => b[1] - a[1] || regions[b[0]].peak - regions[a[0]].peak)[0]
      claims.set(choice, [...(claims.get(choice) ?? []), k])
    })
    const next: Cell[] = [], taken = new Set<number>()
    for (const [r, ks] of claims) {
      // Merger: a confirmed cell, then the supercell, then the older cell keeps its number.
      const [winner, ...losers] = ks.sort((a, b) => Number(this.tracks[b].id > 0) - Number(this.tracks[a].id > 0) || Number(this.tracks[b].supercell) - Number(this.tracks[a].supercell) || this.tracks[a].born - this.tracks[b].born)
      const c = this.tracks[winner]
      c.columns = Int32Array.from(regions[r].cols); this.move(c, m, regions[r], time, losers.some(k => this.tracks[k].id > 0))
      next.push(c); taken.add(winner)
      for (const k of losers) { if (this.tracks[k].id) this.ended.push({ id: this.tracks[k].id, into: c.id }); taken.add(k) }
    }
    this.tracks.forEach((c, k) => { if (!taken.has(k) && c.id) this.ended.push({ id: c.id, into: null }) })
    regions.forEach((r, k) => {
      if (claims.has(k)) return
      // A core no cell claimed: split off the cell it overlaps most, or a new cell if it is strong enough.
      let parent = -1, most = 0
      overlaps.forEach((hits, j) => { const h = hits.get(k) ?? 0; if (h > most) { most = h; parent = j } })
      if (parent < 0 && r.peak < CELL_START_W) return
      const p = parent >= 0 ? this.tracks[parent] : null, onGust = r.cols.some(a => cold[a] >= 1)
      // The parent's centre jumps when a part splits off: its motion starts over from here (and so after a merger).
      if (p) p.trail = [p.trail[p.trail.length - 1]]
      const c: Cell = {
        id: 0, parent: p ? p.id || p.parent : null, origin: p ? 'split' : onGust ? 'gust-front' : 'thermal', born: time,
        x: r.x, y: r.y, u: p?.u ?? 0, v: p?.v ?? 0, stats: emptyStats(), stage: 'growing', since: time, pending: 'growing', pendingSince: time,
        peakW: 0, peakUH: 0, meso: 0, antiMeso: 0, supercell: false, leftMover: false, occluded: false, columns: Int32Array.from(r.cols), trail: [{ t: time, x: r.x, y: r.y }],
      }
      next.push(c)
    })
    this.tracks = next.sort((a, b) => (a.id || Infinity) - (b.id || Infinity))

    // Storm areas: every column within CELL_REACH belongs to the nearest confirmed cell; a new core not yet confirmed has
    // only its own columns (so a fragment at a storm's flank does not take the storm's mesocyclone away from it).
    const stats = this.tracks.map(emptyStats), lowest = this.tracks.map(() => -Infinity), lowAt = this.tracks.map(() => -1)
    const add = (k: number, c: number) => {
      const s = stats[k], uh = m.uhColumn[c]
      s.updraft = Math.max(s.updraft, up[c]); s.downdraft = Math.max(s.downdraft, down[c]); s.cloudTop = Math.max(s.cloudTop, top[c])
      s.rainRate = Math.max(s.rainRate, rain[c]); s.coldPool = Math.max(s.coldPool, cold[c]); s.uh = Math.max(s.uh, uh); s.anticyclonic = Math.max(s.anticyclonic, -uh)
      s.uh01 = Math.max(s.uh01, uh01[c]); s.uh03 = Math.max(s.uh03, uh03[c])
      if (uh03[c] > lowest[k]) { lowest[k] = uh03[c]; lowAt[k] = c }
    }
    for (let c = 0; c < layer; c++) {
      const x = (c % nx) * dx, y = Math.floor(c / nx) * dy
      let owner = -1, bestD = CELL_REACH
      this.tracks.forEach((cell, k) => { if (!cell.id) return; const d = distance(m, x, y, cell.x, cell.y); if (d < bestD) { bestD = d; owner = k } })
      if (owner >= 0) add(owner, c)
    }
    this.tracks.forEach((cell, k) => { if (!cell.id) for (const c of cell.columns) add(k, c) })
    this.tracks.forEach((cell, k) => {
      const s = stats[k]
      // Under the low-level rotation if there is any, else under the strongest part of the core.
      const under = lowest[k] > 0 ? lowAt[k] : cell.columns.reduce((a, b) => core[b] > core[a] ? b : a, cell.columns[0])
      s.coldUnder = m.cold[under]; s.area = cell.columns.length * dx * dy / 1e6
      let sw = 0, swz = 0
      for (const c of cell.columns) { sw += m.coreW[c]; swz += m.coreWZ[c] }
      s.coreZeta = sw > 0 ? swz / sw : 0
      this.advance(cell, s, time, dt)
      if (!cell.id && time - cell.born >= CELL_CONFIRM && cell.peakW >= CELL_START_W) cell.id = this.nextId++
    })
  }

  /** New centre and motion from the trail of centres (unwrapped across the periodic edges). */
  private move(c: Cell, m: AtmosphereModel, r: Region, time: number, jumped: boolean) {
    const { width, depth } = m.grid, last = c.trail[c.trail.length - 1]
    const ddx = wrap(r.x - mod(last.x, width), width), ddy = wrap(r.y - mod(last.y, depth), depth)
    const point = { t: time, x: last.x + ddx, y: last.y + ddy }
    if (jumped) c.trail = [point]; else c.trail.push(point)
    c.x = r.x; c.y = r.y
    while (c.trail.length > 2 && time - c.trail[1].t >= MOTION_WINDOW) c.trail.shift()
    const first = c.trail[0], span = time - first.t
    if (span >= 60) { const end = c.trail[c.trail.length - 1]; c.u = (end.x - first.x) / span; c.v = (end.y - first.y) / span }
  }

  private advance(c: Cell, s: CellStats, time: number, dt: number) {
    c.stats = s; c.peakW = Math.max(c.peakW, s.updraft); c.peakUH = Math.max(c.peakUH, s.uh)
    c.meso = s.coreZeta >= MESO_CORE_ZETA ? c.meso + dt : 0
    c.antiMeso = s.coreZeta <= -MESO_CORE_ZETA ? c.antiMeso + dt : 0
    if (c.meso >= MESO_PERSISTENCE) c.supercell = true
    if (c.antiMeso >= MESO_PERSISTENCE) c.leftMover = true
    // A new mesocyclone that has held as long as the first one had to is the storm's mature stage again.
    if (c.stage === 'cycling' && time - c.since >= MESO_PERSISTENCE) c.occluded = false
    const candidate = cellStage({ ...c, age: time - c.born }, s)
    if (candidate === c.stage) { c.pending = candidate; return }
    if (candidate !== c.pending) { c.pending = candidate; c.pendingSince = time }
    // The first stage of a new cell, and the step into supercell, need no wait (their own criteria already persist).
    if (time - c.pendingSince < STAGE_HOLD && time > c.born && !(candidate === 'supercell' && c.stage === 'rotating')) return
    if (candidate === 'occluding') c.occluded = true
    if (candidate === 'cycling') c.peakUH = s.uh
    c.stage = candidate; c.since = time
  }
}

const emptyStats = (): CellStats => ({ updraft: 0, downdraft: 0, uh: 0, anticyclonic: 0, uh01: 0, uh03: 0, cloudTop: 0, rainRate: 0, coldPool: 0, coldUnder: 0, area: 0, coreZeta: 0 })
const mod = (a: number, n: number) => ((a % n) + n) % n
/** Shortest signed periodic difference. */
const wrap = (d: number, size: number) => d - size * Math.round(d / size)
const distance = (m: AtmosphereModel, x1: number, y1: number, x2: number, y2: number) => Math.hypot(wrap(x1 - x2, m.grid.width), wrap(y1 - y2, m.grid.depth))
