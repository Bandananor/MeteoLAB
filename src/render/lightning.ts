import * as THREE from 'three'
import { type AtmosphereModel, channelShape, type Flash, type TransientEvent } from '../core'
import { mulberry32 } from '../core/math'
import { FLASH_POINTS } from './light'
import { lightningFragment, lightningVertex } from './shaders'

/** At most this many flashes shown at once; a flash waiting longer than QUEUE_WAIT ms for a place is dropped. */
const SLOTS = 8, QUEUE_WAIT = 2000
/**
 * The channel between the model's nodes (~1 km): first a midpoint moved sideways by up to ROUGHNESS of the piece (the
 * meander on the scale of hundreds of metres), then each half as a run of straight steps of ~KINK_STEP km with sharp
 * turns between them (tortuous).
 */
const ROUGHNESS = .12, KINK_STEP = .05
/** Turn between two straight steps: normal with this spread, radians (~13 deg); with the pull to the end ~16 deg on average (Hill 1968). */
const KINK_SPREAD = .22

/**
 * The course of one flash in time, ms from its start, as observed (Rakov & Uman 2003, Thottappillil et al. 1992, Shindo
 * & Uman 1989, by memory; checked by the meteorologist review 14.10.2026): a CG's stepped leader (20-35 ms) grows down
 * dimly, then the return stroke lights the main channel and, briefly, the branches; a negative CG has 1-8 strokes along
 * the same channel (1 in ~18%, 3.7 on average), log-normally 5-300 ms apart (geometric mean ~60 ms); a long continuing
 * current follows ~11% of the subsequent strokes (not the first), so ~30% of the flashes have one; a positive CG usually
 * one stroke with a long continuing current. An IC flash lasts 0.2-0.7 s: its channel grows over the first 60-150 ms
 * (a wide one longer, CRAWL_MS_PER_KM),
 * then K-changes, an order of magnitude dimmer than a return stroke, flicker it. The brightness decays over tens of ms
 * (the eye's persistence; the stroke itself is ~0.1 ms, as a high-speed camera sees it: `brightness(slow)`).
 */
export interface Course { leader: number; strokes: { at: number; peak: number; cc: number; ccLength: number; path: 0 | 1 }[]; end: number }

/**
 * Chance that a subsequent stroke of a negative CG makes a new ground contact (Valine & Krider 2002, Rakov & Uman 2003,
 * by memory: 35-50% of the multiple-stroke flashes have two or more): it leaves the old channel 1-2.5 km up and reaches
 * the ground 0.5-5 km away (~1.5 km typically). Later strokes take the new path or the old one.
 */
const NEW_CONTACT = .2

/**
 * A leader crossing the cloud horizontally (an IC flash, the in-cloud part of a +CG) grows at ~10^5 m/s: 10 ms per km
 * of the flash's extent (Mazur, by memory), up to 600 ms. Under a thin anvil such a channel is seen crawling ("spider"
 * lightning, anvil crawlers).
 */
const CRAWL_MS_PER_KM = 10, CRAWL_MAX = 600

/** The course of a flash; `extent`: its horizontal extent, km (how long a leader takes to cross the cloud). */
export function course(flash: Flash, rng: () => number, extent = 0): Course {
  const crawl = Math.min(CRAWL_MAX, extent * CRAWL_MS_PER_KM)
  if (flash.kind === 'IC') {
    // The K-changes once the channel is there, the first as it completes.
    const leader = Math.max(60 + rng() * 90, crawl), end = Math.max(200 + rng() * 300, leader + 150 + rng() * 300), n = 3 + Math.floor(rng() * 8)
    const strokes = Array.from({ length: n }, (_, k) => ({ at: k ? leader + rng() * (end - leader) : leader, peak: .15 + rng() * .2, cc: 0, ccLength: 0, path: 0 as const })).sort((a, b) => a.at - b.at)
    return { leader, strokes, end: end + 120 }
  }
  // A negative CG's stepped leader comes down in 20-35 ms; a positive CG starts with a long horizontal leader in the
  // cloud, often under the anvil, before its stroke.
  const positive = flash.charge > 0, leader = positive ? Math.max(100 + rng() * 100, crawl) : 20 + rng() * 15
  // The number of strokes of a negative CG: 1 in ~1/5 of the flashes, then fewer and fewer up to 8.
  const counts = [.18, .15, .17, .16, .12, .09, .07, .06]
  let n = 1
  if (!positive) { let r = rng(); for (n = 1; n < counts.length && r > counts[n - 1]; n++) r -= counts[n - 1] }
  const strokes: Course['strokes'] = []
  let at = leader, forked = false
  for (let k = 0; k < n; k++) {
    if (k) at += Math.min(300, Math.max(5, 60 * Math.exp(.8 * normal(rng))))
    const cc = positive ? .35 : k && rng() < .11 ? .25 : 0, ccLength = positive ? 100 + rng() * 150 : cc ? 40 + rng() * 110 : 0
    let path: 0 | 1 = 0
    if (k && !forked && rng() < NEW_CONTACT) { path = 1; forked = true } else if (k && forked && rng() < .6) path = 1
    strokes.push({ at, peak: k ? .6 + rng() * .3 : 1, cc, ccLength, path })
    at += ccLength
  }
  return { leader, strokes, end: at + 220 }
}

/** A standard normal number (Box-Muller). */
const normal = (rng: () => number) => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng())

/**
 * Brightness at `t` ms of a flash's main channel (above where a new ground contact leaves it), of its branches, of the
 * old path below that and of the new one (`old`, `fork`), and how much of the channel has grown (0-1).
 * `slow`: a slowed replay, seen as by a high-speed camera: the faint stepped leader shows, and a return stroke dies in
 * a few ms (the eye keeps it ~25 ms).
 */
export function brightness(c: Course, cg: boolean, t: number, slow = false) {
  const reveal = Math.min(1, t / c.leader), fade = slow ? 3 : 25
  // A leader growing for tens of ms is faint; one crawling across the cloud for hundreds of ms is seen.
  let main = t < c.leader ? slow ? .35 : c.leader > 60 ? .22 : .12 : 0, branch = main, old = main, fork = 0
  for (const [k, s] of c.strokes.entries()) {
    if (t < s.at) continue
    const after = t - s.at, now = Math.max(s.peak * Math.exp(-after / fade), after < s.ccLength ? s.cc : s.cc * Math.exp(-(after - s.ccLength) / 30))
    main = Math.max(main, now)
    if (s.path) fork = Math.max(fork, now); else old = Math.max(old, now)
    // A CG's branches light with the first return stroke only; an IC's whole channel is one.
    if (!cg) branch = main
    else if (k === 0) branch = Math.max(branch, .5 * Math.exp(-after / (slow ? 2 : 15)))
  }
  if (!cg && t >= c.leader) main = branch = old = Math.max(main, .08)
  return { main, branch, reveal, old, fork }
}

/** A flash on screen: its course, when it started (performance.now(), ms) and how fast its clock runs (1: real time). */
interface Shown { flash: Flash; course: Course; start: number; rate: number; slot: number }

/**
 * The lightning of the 3D view: each flash of the model drawn along its channel, refined from the ~1 km grid by midpoint
 * displacement, as camera-facing ribbons with a white core and a coloured glow, lit in time as a real flash is
 * (`course`). Flashes are spread over the real time of the model step they came in, not shown all at once.
 */
export class LightningView {
  readonly mesh: THREE.Mesh
  private readonly geometry = new THREE.BufferGeometry(); private readonly material: THREE.ShaderMaterial
  private readonly shown: (Shown | null)[] = Array(SLOTS).fill(null)
  private readonly queue: { flash: Flash; at: number; rate?: number }[] = []
  private seen = 0; private drawn = 0; private lastArrival = 0
  /** For checks of the picture: every flash shown held at this moment of its course, ms (null: running). */
  freeze: number | null = null
  /** Called when a CG with a sprite or halo starts to show: the flash, when its first return stroke comes (performance.now() ms), the replay rate. */
  onEvent?: (flash: Flash, at: number, rate: number) => void
  /** For the checks of the picture and a teaser (view.ts, ?tle=sprite on a local server): every CG gets this event. */
  forceEvent?: TransientEvent
  /** Per slot: the points of the channel that light the cloud (world km), whether they changed since taken(), how bright the flash is now. */
  readonly points: (Float32Array | null)[] = Array(SLOTS).fill(null)
  readonly changed: boolean[] = Array(SLOTS).fill(true)
  readonly bright: number[] = Array(SLOTS).fill(0)
  private readonly pointsOf: (Shown | null)[] = Array(SLOTS).fill(null)
  /** Per slot: where a new ground contact strikes (world km), if the flash makes one. */
  private readonly forkGround: (number[] | null)[] = Array(SLOTS).fill(null)
  /** The lowest point of the brightest CG's main channel shown and how bright it is (to light the ground), or null. */
  strike: { x: number; y: number; z: number; bright: number } | null = null
  private readonly rng = mulberry32(17)
  private readonly model: AtmosphereModel; private readonly toWorld: (x: number, y: number, z: number) => readonly [number, number, number]

  /** `shared`: the cloud volume's box and extinction (view.ts), `density`: its texture, to dim the channel inside the cloud. */
  constructor(model: AtmosphereModel, toWorld: (x: number, y: number, z: number) => readonly [number, number, number], shared: Record<string, THREE.IUniform>, density: THREE.Texture) {
    this.model = model; this.toWorld = toWorld
    this.material = new THREE.ShaderMaterial({
      vertexShader: lightningVertex, fragmentShader: lightningFragment, side: THREE.DoubleSide, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false,
      uniforms: { ...shared, uDensity: { value: density }, uFlash: { value: Array.from({ length: SLOTS }, () => new THREE.Vector4()) }, uPaths: { value: Array.from({ length: SLOTS }, () => new THREE.Vector4()) }, uRes: { value: new THREE.Vector2(1, 1) }, uPx: { value: 1 } },
    })
    this.mesh = new THREE.Mesh(this.geometry, this.material); this.mesh.frustumCulled = false; this.mesh.renderOrder = 4; this.mesh.visible = false
  }

  /**
   * Takes the flashes that arrived, lights those shown at `now` (performance.now(), ms) and returns how bright the
   * lightning is (0-1), to light the cloud. `px` is the drawing buffer's pixels per CSS pixel.
   */
  update(now: number, enabled: boolean, resolution: THREE.Vector2, px: number) {
    const m = this.model, total = m.flashCount.ic + m.flashCount.cg
    // A rewind or a loaded state: the counts went back. After a pause in drawing (an instrument screen over the view)
    // the flashes meanwhile are not shown all at once.
    if (total < this.seen) { this.queue.length = 0; this.shown.fill(null); this.rebuild() }
    if (now - this.drawn > 500) this.seen = total
    this.drawn = now
    const fresh = Math.min(Math.max(0, total - this.seen), m.flashes.length, 12)
    // A slow replay on screen: the new flashes are not shown over it.
    if (fresh && !this.shown.some(s => s && s.rate < 1)) {
      // Spread over the real time since the last ones came (at most 1.5 s): one model step brings them all at once.
      const spread = Math.min(1500, now - this.lastArrival)
      for (const flash of m.flashes.slice(m.flashes.length - fresh)) this.queue.push({ flash, at: now + this.rng() * spread })
      this.queue.sort((a, b) => a.at - b.at); this.lastArrival = now
    }
    this.seen = total
    let changed = false
    const clock = (s: Shown) => this.freeze ?? (now - s.start) * s.rate
    for (const [i, s] of this.shown.entries()) if (s && this.freeze === null && clock(s) > s.course.end) { this.shown[i] = null; changed = true }
    while (this.queue.length && this.queue[0].at <= now) {
      const q = this.queue.shift()!, slot = this.shown.indexOf(null)
      if (now - q.at > QUEUE_WAIT) continue
      if (slot < 0) { this.queue.unshift(q); break }
      this.shown[slot] = { flash: q.flash, course: this.courseOf(q.flash), start: now, rate: q.rate ?? 1, slot }; changed = true
      // A sprite or halo above a CG: it starts after the first return stroke (sprites.ts).
      const tle = q.flash.tle ?? (q.flash.kind === 'CG' ? this.forceEvent : undefined)
      if (tle) this.onEvent?.({ ...q.flash, tle }, now + this.shown[slot]!.course.strokes[0].at / (q.rate ?? 1), q.rate ?? 1)
    }
    if (changed) this.rebuild()
    let glow = 0
    const flashes = this.material.uniforms.uFlash.value as THREE.Vector4[], paths = this.material.uniforms.uPaths.value as THREE.Vector4[]
    this.strike = null
    for (let i = 0; i < SLOTS; i++) {
      const s = this.shown[i]
      if (!s) { flashes[i].set(0, 0, 0, 0); this.bright[i] = 0; continue }
      const cg = s.flash.kind === 'CG', b = brightness(s.course, cg, clock(s), s.rate < 1)
      // Beads: a CG's channel, fading after a stroke, breaks into bright pieces (Rakov & Uman 2003: bead lightning).
      const beads = cg && clock(s) > s.course.strokes[0].at ? Math.min(1, Math.max(0, (.35 - b.main) / .3)) : 0
      flashes[i].set(b.main, b.branch, b.reveal, cg ? 1 : 0); paths[i].set(b.old, b.fork, beads, 0)
      // The cloud is lit once the channel is there: a stepped leader's own light is faint, a leader crawling across the
      // cloud for hundreds of ms lights it more. From space (LIS) IC and CG flashes
      // light their clouds alike; an IC's K-changes are dimmer themselves (course).
      this.bright[i] = enabled ? b.main * (b.reveal < 1 ? s.course.leader > 60 ? .6 : .3 : 1) : 0
      glow = Math.max(glow, this.bright[i])
      const p = this.points[i]
      // The ground lit where the brighter of the two paths strikes.
      const q = b.fork > b.old && this.forkGround[i] ? this.forkGround[i]! : p
      if (cg && q && enabled && b.reveal >= 1 && b.main > (this.strike?.bright ?? 0)) this.strike = { x: q[0], y: q[1], z: q[2], bright: b.main }
    }
    this.mesh.visible = enabled && this.shown.some(s => s)
    this.material.uniforms.uRes.value.copy(resolution); this.material.uniforms.uPx.value = px
    return enabled ? Math.min(1, glow) : 0
  }

  /**
   * Shows the model's last flash again (a CG if there was one among the last 20), `rate` times as fast as in real time
   * (1/20: the slow replay — the leader branching down, the strokes one by one). Returns whether there was a flash.
   */
  replay(rate = 1, which?: Flash) {
    const recent = this.model.flashes.slice(-20), flash = which ?? [...recent].reverse().find(f => f.kind === 'CG') ?? recent[recent.length - 1]
    if (!flash) return false
    this.shown.fill(null); this.queue.length = 0; this.queue.push({ flash, at: performance.now(), rate })
    return true
  }

  /** The course a flash is shown with (for checks of the picture). */
  courseOf(flash: Flash) { return course(flash, mulberry32(Math.round(flash.time * 10) + flash.start), this.extent(flash)) }

  /** A flash's horizontal extent, km: the diagonal of its channel's nodes (across a periodic edge it counts short). */
  private extent(flash: Flash) {
    const { nx, layer, dx, dy } = this.model.grid
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const i of flash.nodes) { const c = i % layer, x = (c % nx) * dx, y = Math.floor(c / nx) * dy; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    return Math.hypot(x1 - x0, y1 - y0) / 1000
  }

  /**
   * FLASH_POINTS points of a flash's channel that light the cloud, world km, the first the lowest: a CG's main channel
   * (its return strokes light it), all of an IC's channel; evenly along the nodes.
   */
  private lightPoints(f: Flash) {
    let path: number[] = []
    if (f.kind === 'CG') { let c = f.nodes.indexOf(f.ground); while (c >= 0) { path.push(c); c = c > 0 ? f.parent[c] : -1 } }
    else path = Array.from(f.nodes, (_, c) => c)
    const shape = channelShape(this.model.grid, f), n = Math.min(FLASH_POINTS, path.length), out = new Float32Array(n * 3)
    for (let k = 0; k < n; k++) { const c = path[Math.floor(k * (path.length - 1) / Math.max(1, n - 1))]; out.set(this.toWorld(shape[c * 3], shape[c * 3 + 1], shape[c * 3 + 2]), k * 3) }
    return out
  }

  /** Marks the slots' light points as taken into the cloud's light. */
  taken() { this.changed.fill(false) }

  /** The ribbons of the flashes shown: a quad per piece of channel, with what the shader needs to light it. */
  private rebuild() {
    for (let i = 0; i < SLOTS; i++) {
      const s = this.shown[i]
      if (!s) { if (this.points[i]) { this.points[i] = null; this.pointsOf[i] = null; this.changed[i] = true } continue }
      if (this.pointsOf[i] === s) continue
      this.points[i] = this.lightPoints(s.flash); this.pointsOf[i] = s; this.changed[i] = true
    }
    const { width, depth } = this.model.grid, a: number[] = [], b: number[] = [], side: number[] = [], end: number[] = [], info: number[] = [], arc: number[] = [], index: number[] = []
    // The distance along a run of pieces (km, from a random start), where the beads fall.
    let along = 0
    const run = (points: number[][], kind: number, order: number, w: number, slot: number) => {
      along += 7.3
      for (let j = 0; j + 1 < points.length; j++) {
        const base = side.length, len = Math.hypot(points[j + 1][0] - points[j][0], points[j + 1][1] - points[j][1], points[j + 1][2] - points[j][2])
        for (const [e, sd] of [[0, -1], [0, 1], [1, -1], [1, 1]]) { a.push(...points[j]); b.push(...points[j + 1]); side.push(sd); end.push(e); info.push(slot, kind, order, w); arc.push(along, along + len) }
        index.push(base, base + 1, base + 2, base + 2, base + 1, base + 3)
        along += len
      }
    }
    for (const s of this.shown) {
      if (!s) continue
      const f = s.flash, shape = smooth(f, channelShape(this.model.grid, f)), rng = mulberry32(Math.round(f.time * 10) + f.start + 1)
      // The main channel of a CG: from where it touched the ground back to where it started. Segment kinds: 0 a branch,
      // 1 the main channel, 3 the old path below where a new ground contact leaves it (2: the new path, drawn below).
      const main = new Uint8Array(f.nodes.length), path: number[] = []
      if (f.kind === 'CG') { let c = f.nodes.indexOf(f.ground); while (c > 0) { main[c] = 1; path.push(c); c = f.parent[c] } }
      else main.fill(1)
      this.forkGround[s.slot] = null
      if (f.kind === 'CG' && s.course.strokes.some(k => k.path)) {
        // The new path leaves the old one where it is 1-2.5 km up and strikes 0.5-5 km away (log-normal, ~1.5 km).
        const at = (c: number) => this.toWorld(shape[c * 3], shape[c * 3 + 1], shape[c * 3 + 2]), height = 1 + 1.5 * rng()
        const k = path.findIndex(c => at(c)[1] >= height), forkNode = k < 0 ? path[path.length - 1] : path[k]
        for (let j = 0; j < (k < 0 ? path.length - 1 : k); j++) main[path[j]] = 3
        const from = at(forkNode), d = Math.min(5, Math.max(.5, 1.5 * Math.exp(.6 * normal(rng)))), turn = rng() * Math.PI * 2, ground = [from[0] + d * Math.cos(turn), 0, from[2] + d * Math.sin(turn)]
        this.forkGround[s.slot] = ground
        run(refine(from, ground, rng), 2, 0, 1, s.slot)
      }
      for (let c = 1; c < f.nodes.length; c++) {
        const p = f.parent[c], from = [shape[p * 3], shape[p * 3 + 1], shape[p * 3 + 2]], to = [shape[c * 3], shape[c * 3 + 1], shape[c * 3 + 2]]
        // Across the periodic edge: not a line over the whole domain.
        if (Math.abs(from[0] - to[0]) > width / 2 || Math.abs(from[1] - to[1]) > depth / 2) continue
        const points = refine(this.toWorld(from[0], from[1], from[2]), this.toWorld(to[0], to[1], to[2]), rng)
        const order = c / f.nodes.length, w = f.kind === 'IC' ? .6 : main[c] ? 1 : .45
        run(points, main[c], order, w, s.slot)
      }
    }
    const g = this.geometry
    g.setAttribute('aA', new THREE.Float32BufferAttribute(a, 3)); g.setAttribute('aB', new THREE.Float32BufferAttribute(b, 3))
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1)); g.setAttribute('aEnd', new THREE.Float32BufferAttribute(end, 1))
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4)); g.setAttribute('aArc', new THREE.Float32BufferAttribute(arc, 2)); g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3))
    g.setIndex(index)
  }

  dispose() { this.geometry.dispose(); this.material.dispose() }
}

/**
 * The channel's nodes pulled towards their neighbours along the tree: the model's nodes are ~1 km apart
 * across but 100-250 m apart near the ground, so their random shifts in the cell (channelShape) zigzag a nearly vertical
 * channel sideways at every level (five passes even those out). The start and the ground contact stay.
 */
function smooth(flash: Flash, shape: Float64Array) {
  const n = flash.nodes.length, sum = new Float64Array(n * 3), count = new Float64Array(n)
  let s = shape
  for (let pass = 0; pass < 5; pass++) {
    sum.fill(0); count.fill(0)
    for (let c = 1; c < n; c++) { const p = flash.parent[c]; for (let k = 0; k < 3; k++) { sum[p * 3 + k] += s[c * 3 + k]; sum[c * 3 + k] += s[p * 3 + k] } count[p]++; count[c]++ }
    const next = Float64Array.from(s)
    for (let c = 1; c < n; c++) {
      if (flash.nodes[c] === flash.ground || !count[c]) continue
      for (let k = 0; k < 3; k++) next[c * 3 + k] = .5 * s[c * 3 + k] + .5 * sum[c * 3 + k] / count[c]
    }
    s = next
  }
  return s
}

/**
 * A piece of channel from `from` to `to` (world km): its midpoint moved sideways at random, then each half tortuous.
 */
function refine(from: readonly number[], to: readonly number[], rng: () => number) {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], len = Math.hypot(d[0], d[1], d[2])
  const side = across(d, rng), amount = len * ROUGHNESS * (rng() * 2 - 1)
  const mid = [(from[0] + to[0]) / 2 + side[0] * amount, Math.max(0, (from[1] + to[1]) / 2 + side[1] * amount), (from[2] + to[2]) / 2 + side[2] * amount]
  return [...tortuous(from, mid, rng), ...tortuous(mid, to, rng).slice(1)]
}

/** A random unit vector across `d`. */
function across(d: readonly number[], rng: () => number) {
  const len = Math.hypot(d[0], d[1], d[2]) || 1
  for (;;) {
    const r = [rng() - .5, rng() - .5, rng() - .5], along = (r[0] * d[0] + r[1] * d[1] + r[2] * d[2]) / (len * len)
    const c = [r[0] - along * d[0], r[1] - along * d[1], r[2] - along * d[2]], cl = Math.hypot(c[0], c[1], c[2])
    if (cl > 1e-3) return [c[0] / cl, c[1] / cl, c[2] / cl]
  }
}

/**
 * A tortuous channel from `from` to `to` (world km), as photographs show it: straight steps of ~`step` km (0.6-1.4
 * times it), each turned from the last by a random angle (KINK_SPREAD) about a random axis and pulled a quarter of the
 * way towards the end, which it reaches exactly. Points from `from` to `to`.
 */
export function tortuous(from: readonly number[], to: readonly number[], rng: () => number, step = KINK_STEP) {
  const out: number[][] = [[...from]], total = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]), n = Math.max(1, Math.round(total / step))
  let p = [...from], dir: number[] | null = null
  for (let k = 0; k < n - 1; k++) {
    const rem = [to[0] - p[0], to[1] - p[1], to[2] - p[2]], rl = Math.hypot(rem[0], rem[1], rem[2])
    if (rl < 1e-6) break
    const want = rem.map(v => v / rl), base: number[] = dir ?? want, axis = across(base, rng), a = normal(rng) * KINK_SPREAD
    let next: number[] = base.map((v, j) => v * Math.cos(a) + axis[j] * Math.sin(a))
    next = next.map((v, j) => v * .75 + want[j] * .25)
    const nl = Math.hypot(next[0], next[1], next[2])
    dir = next.map(v => v / nl)
    const s = rl / (n - k) * (.6 + .8 * rng())
    p = [p[0] + dir[0] * s, Math.max(0, p[1] + dir[1] * s), p[2] + dir[2] * s]
    out.push(p)
  }
  out.push([...to])
  return out
}
