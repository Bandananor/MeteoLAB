import * as THREE from 'three'
import { type AtmosphereModel, channelShape, type Flash } from '../core'
import { mulberry32 } from '../core/math'
import { FLASH_POINTS } from './light'
import { lightningFragment, lightningVertex } from './shaders'

/** At most this many flashes shown at once; a flash waiting longer than QUEUE_WAIT ms for a place is dropped. */
const SLOTS = 8, QUEUE_WAIT = 2000
/** Each channel segment (~1 km between the model's nodes) is split into 2^SUBDIVIDE pieces by midpoint displacement. */
const SUBDIVIDE = 3
/** Sideways displacement of a midpoint, as a share of its piece's length (halved at every level with the piece). */
const ROUGHNESS = .16

/**
 * The course of one flash in time, ms from its start, as observed (Rakov & Uman 2003, by memory): a CG's stepped leader
 * (20-35 ms) grows down dimly, then the return stroke lights the main channel and, briefly, the branches; a negative CG
 * has 1-8 strokes along the same channel (about 3-4 on average) 15-120 ms apart (median ~45), some followed by a
 * continuing current; a positive CG usually one stroke with a long continuing current. An IC flash lasts 200-500 ms: its
 * channel grows over the first 60-150 ms, and K-changes flicker it. The brightness decays over tens of ms (the eye's and
 * a camera's persistence; the stroke itself is ~0.1 ms).
 */
export interface Course { leader: number; strokes: { at: number; peak: number; cc: number; ccLength: number }[]; end: number }

export function course(flash: Flash, rng: () => number): Course {
  if (flash.kind === 'IC') {
    const leader = 60 + rng() * 90, end = 200 + rng() * 300, n = 3 + Math.floor(rng() * 8)
    const strokes = Array.from({ length: n }, () => ({ at: leader * .5 + rng() * (end - leader * .5), peak: .25 + rng() * .35, cc: 0, ccLength: 0 })).sort((a, b) => a.at - b.at)
    return { leader, strokes, end: end + 120 }
  }
  const leader = 20 + rng() * 15, positive = flash.charge > 0
  // The number of strokes of a negative CG: 1 in ~1/5 of the flashes, then fewer and fewer up to 8.
  const counts = [.18, .15, .17, .16, .12, .09, .07, .06]
  let n = 1
  if (!positive) { let r = rng(); for (n = 1; n < counts.length && r > counts[n - 1]; n++) r -= counts[n - 1] }
  const strokes: Course['strokes'] = []
  let at = leader
  for (let k = 0; k < n; k++) {
    if (k) at += Math.min(120, Math.max(15, 45 * Math.exp((rng() - .5) * 1.4)))
    const cc = positive ? .35 : rng() < .3 ? .25 : 0, ccLength = positive ? 100 + rng() * 150 : cc ? 40 + rng() * 110 : 0
    strokes.push({ at, peak: k ? .6 + rng() * .3 : 1, cc, ccLength })
    at += ccLength
  }
  return { leader, strokes, end: at + 220 }
}

/** Brightness at `t` ms of a flash's main channel and of its branches, and how much of the channel has grown (0-1). */
export function brightness(c: Course, cg: boolean, t: number) {
  const reveal = Math.min(1, t / c.leader)
  let main = t < c.leader ? .12 : 0, branch = main
  for (const [k, s] of c.strokes.entries()) {
    if (t < s.at) continue
    const after = t - s.at
    main = Math.max(main, s.peak * Math.exp(-after / 25), after < s.ccLength ? s.cc : s.cc * Math.exp(-(after - s.ccLength) / 30))
    // A CG's branches light with the first return stroke only; an IC's whole channel is one.
    if (!cg) branch = main
    else if (k === 0) branch = Math.max(branch, .5 * Math.exp(-after / 15))
  }
  if (!cg && t >= c.leader) main = branch = Math.max(main, .08)
  return { main, branch, reveal }
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
  /** Per slot: the points of the channel that light the cloud (world km), whether they changed since taken(), how bright the flash is now. */
  readonly points: (Float32Array | null)[] = Array(SLOTS).fill(null)
  readonly changed: boolean[] = Array(SLOTS).fill(true)
  readonly bright: number[] = Array(SLOTS).fill(0)
  private readonly pointsOf: (Shown | null)[] = Array(SLOTS).fill(null)
  /** The lowest point of the brightest CG's main channel shown and how bright it is (to light the ground), or null. */
  strike: { x: number; y: number; z: number; bright: number } | null = null
  private readonly rng = mulberry32(17)
  private readonly model: AtmosphereModel; private readonly toWorld: (x: number, y: number, z: number) => readonly [number, number, number]

  /** `shared`: the cloud volume's box and extinction (view.ts), `density`: its texture, to dim the channel inside the cloud. */
  constructor(model: AtmosphereModel, toWorld: (x: number, y: number, z: number) => readonly [number, number, number], shared: Record<string, THREE.IUniform>, density: THREE.Texture) {
    this.model = model; this.toWorld = toWorld
    this.material = new THREE.ShaderMaterial({
      vertexShader: lightningVertex, fragmentShader: lightningFragment, side: THREE.DoubleSide, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false,
      uniforms: { ...shared, uDensity: { value: density }, uFlash: { value: Array.from({ length: SLOTS }, () => new THREE.Vector4()) }, uRes: { value: new THREE.Vector2(1, 1) }, uPx: { value: 1 } },
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
    if (fresh) {
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
      this.shown[slot] = { flash: q.flash, course: course(q.flash, mulberry32(Math.round(q.flash.time * 10) + q.flash.start)), start: now, rate: q.rate ?? 1, slot }; changed = true
    }
    if (changed) this.rebuild()
    let glow = 0
    const flashes = this.material.uniforms.uFlash.value as THREE.Vector4[]
    this.strike = null
    for (let i = 0; i < SLOTS; i++) {
      const s = this.shown[i]
      if (!s) { flashes[i].set(0, 0, 0, 0); this.bright[i] = 0; continue }
      const cg = s.flash.kind === 'CG', b = brightness(s.course, cg, clock(s))
      flashes[i].set(b.main, b.branch, b.reveal, cg ? 1 : 0)
      // The cloud is lit once the channel is there: the leader's own light is faint.
      this.bright[i] = enabled ? b.main * (cg ? 1 : .7) * (b.reveal < 1 ? .3 : 1) : 0
      glow = Math.max(glow, this.bright[i])
      const p = this.points[i]
      if (cg && p && enabled && b.reveal >= 1 && b.main > (this.strike?.bright ?? 0)) this.strike = { x: p[0], y: p[1], z: p[2], bright: b.main }
    }
    this.mesh.visible = enabled && this.shown.some(s => s)
    this.material.uniforms.uRes.value.copy(resolution); this.material.uniforms.uPx.value = px
    return enabled ? Math.min(1, glow) : 0
  }

  /**
   * Shows the model's last flash again (a CG if there was one among the last 20), `rate` times as fast as in real time
   * (1/20: the slow replay — the leader branching down, the strokes one by one). Returns whether there was a flash.
   */
  replay(rate = 1) {
    const recent = this.model.flashes.slice(-20), flash = [...recent].reverse().find(f => f.kind === 'CG') ?? recent[recent.length - 1]
    if (!flash) return false
    this.shown.fill(null); this.queue.length = 0; this.queue.push({ flash, at: performance.now(), rate })
    return true
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
    const { width, depth } = this.model.grid, a: number[] = [], b: number[] = [], side: number[] = [], end: number[] = [], info: number[] = [], index: number[] = []
    for (const s of this.shown) {
      if (!s) continue
      const f = s.flash, shape = smooth(f, channelShape(this.model.grid, f)), rng = mulberry32(Math.round(f.time * 10) + f.start + 1)
      // The main channel of a CG: from where it touched the ground back to where it started.
      const main = new Uint8Array(f.nodes.length)
      if (f.kind === 'CG') { let c = f.nodes.indexOf(f.ground); while (c > 0) { main[c] = 1; c = f.parent[c] } }
      else main.fill(1)
      for (let c = 1; c < f.nodes.length; c++) {
        const p = f.parent[c], from = [shape[p * 3], shape[p * 3 + 1], shape[p * 3 + 2]], to = [shape[c * 3], shape[c * 3 + 1], shape[c * 3 + 2]]
        // Across the periodic edge: not a line over the whole domain.
        if (Math.abs(from[0] - to[0]) > width / 2 || Math.abs(from[1] - to[1]) > depth / 2) continue
        const points = refine(this.toWorld(from[0], from[1], from[2]), this.toWorld(to[0], to[1], to[2]), rng)
        const order = c / f.nodes.length, w = f.kind === 'IC' ? .6 : main[c] ? 1 : .45
        for (let k = 0; k + 1 < points.length; k++) {
          const base = side.length
          for (const [e, sd] of [[0, -1], [0, 1], [1, -1], [1, 1]]) { a.push(...points[k]); b.push(...points[k + 1]); side.push(sd); end.push(e); info.push(s.slot, main[c], order, w) }
          index.push(base, base + 1, base + 2, base + 2, base + 1, base + 3)
        }
      }
    }
    const g = this.geometry
    g.setAttribute('aA', new THREE.Float32BufferAttribute(a, 3)); g.setAttribute('aB', new THREE.Float32BufferAttribute(b, 3))
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1)); g.setAttribute('aEnd', new THREE.Float32BufferAttribute(end, 1))
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4)); g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3))
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

/** A straight piece refined by midpoint displacement into 2^SUBDIVIDE pieces, the midpoints moved sideways at random. */
function refine(from: readonly number[], to: readonly number[], rng: () => number) {
  let points: number[][] = [[...from], [...to]]
  for (let level = 0; level < SUBDIVIDE; level++) {
    const next: number[][] = [points[0]]
    for (let k = 0; k + 1 < points.length; k++) {
      const p = points[k], q = points[k + 1], d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], len = Math.hypot(d[0], d[1], d[2])
      // A random direction, without its part along the piece.
      let r = [rng() - .5, rng() - .5, rng() - .5]
      const along = len > 0 ? (r[0] * d[0] + r[1] * d[1] + r[2] * d[2]) / (len * len) : 0
      r = [r[0] - along * d[0], r[1] - along * d[1], r[2] - along * d[2]]
      const rl = Math.hypot(r[0], r[1], r[2]) || 1, amount = len * ROUGHNESS * (rng() * 2 - 1) / rl
      next.push([(p[0] + q[0]) / 2 + r[0] * amount, Math.max(0, (p[1] + q[1]) / 2 + r[1] * amount), (p[2] + q[2]) / 2 + r[2] * amount], q)
    }
    points = next
  }
  return points
}
