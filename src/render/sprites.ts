import * as THREE from 'three'
import type { Flash } from '../core'
import { mulberry32 } from '../core/math'
import { spriteFragment, spriteVertex } from './shaders'

// Sprites and halos of the 3D view (2.7.3): when a CG with a transient luminous event (core/tle.ts) is shown, the event
// lights above where it struck, after its first return stroke. Only in the dark: by day and in twilight the sky hides
// them (they are as bright as the faint aurora, ~1 MR). Timing as filmed at high speed (Stenbaek-Nielsen et al. 2000,
// Cummer et al. 2006): a halo ~1-3 ms, sprite streamers 5-10 ms after the stroke and gone in ~10-50 ms; the eye and a
// video frame hold them a little longer (the persistence, as for the lightning).

/** At most this many events shown at once. */
const SLOTS = 8
/** Sprite columns: how many, their half width, km. */
const COLUMNS = [5, 14] as const, COLUMN_HALF = [1.2, 3] as const
/** A sprite: delay after the stroke, ms; how long it is lit, then fades out, ms (with the persistence). Halo: the same. */
const SPRITE_DELAY = 6, SPRITE_LIT = 30, SPRITE_FADE = 120, HALO_DELAY = 1, HALO_LIT = 3, HALO_FADE = 60
/** Brightness of a fully lit event against the lightning's 1 (dim: the eye sees them only in the dark). */
const SPRITE_BRIGHT = .9, HALO_BRIGHT = .5
/** Tops of the sprite and of a halo, km: just under the night ionosphere. */
const SPRITE_TOP = 88, HALO_HEIGHT = 83

interface Event { flash: Flash; at: number; rate: number; slot: number }

export class SpriteView {
  readonly mesh: THREE.Mesh
  private readonly geometry = new THREE.BufferGeometry(); private readonly material: THREE.ShaderMaterial
  private readonly shown: (Event | null)[] = Array(SLOTS).fill(null)
  private readonly toWorld: (x: number, y: number, z: number) => readonly [number, number, number]
  private readonly where: (flash: Flash) => readonly [number, number]
  /** For checks of the picture: every event shown held at this many ms after its stroke (null: running). */
  freeze: number | null = null

  /** `where`: the ground point (m from the domain corner) where a CG struck. */
  constructor(toWorld: (x: number, y: number, z: number) => readonly [number, number, number], where: (flash: Flash) => readonly [number, number], shared: Record<string, THREE.IUniform>, density: THREE.Texture) {
    this.toWorld = toWorld; this.where = where
    this.material = new THREE.ShaderMaterial({ name: 'sprite',
      vertexShader: spriteVertex, fragmentShader: spriteFragment, side: THREE.DoubleSide, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false,
      uniforms: { ...shared, uDensity: { value: density }, uSprite: { value: new Array(SLOTS).fill(0) } },
    })
    this.mesh = new THREE.Mesh(this.geometry, this.material); this.mesh.frustumCulled = false; this.mesh.renderOrder = 4; this.mesh.visible = false
  }

  /** Starts showing the event of a CG whose first return stroke comes at `at` (performance.now() ms), `rate` times real time. */
  add(flash: Flash, at: number, rate: number) {
    let slot = this.shown.findIndex(e => !e)
    if (slot < 0) slot = this.shown.reduce((o, e, k) => e!.at < this.shown[o]!.at ? k : o, 0)
    this.shown[slot] = { flash, at, rate, slot }
    this.rebuild()
  }

  /** Lights the events at `now`; `dark` is how dark the sky is (0 day, 1 night), `enabled` whether lightning is drawn. */
  update(now: number, dark: number, enabled: boolean) {
    const bright = this.material.uniforms.uSprite.value as number[]
    let any = false, changed = false
    for (let k = 0; k < SLOTS; k++) {
      const e = this.shown[k]
      if (!e) { bright[k] = 0; continue }
      const sprite = e.flash.tle!.kind === 'sprite', t = (this.freeze ?? (now - e.at) * e.rate) - (sprite ? SPRITE_DELAY : HALO_DELAY)
      const lit = sprite ? SPRITE_LIT : HALO_LIT, fade = sprite ? SPRITE_FADE : HALO_FADE
      if (t > lit + fade) { this.shown[k] = null; bright[k] = 0; changed = true; continue }
      const b = t < 0 ? 0 : t < lit ? 1 : Math.exp(-3 * (t - lit) / fade)
      bright[k] = enabled ? b * (sprite ? SPRITE_BRIGHT : HALO_BRIGHT) * dark : 0
      any ||= bright[k] > 0
    }
    if (changed) this.rebuild()
    this.mesh.visible = any
  }

  /** The quads of the events shown: a sprite's columns around the strike point, a halo's disc above it. */
  private rebuild() {
    const base: number[] = [], shape: number[] = [], corner: number[] = [], head: number[] = [], index: number[] = []
    const quad = (x: number, y: number, z: number, slot: number, half: number, top: number, kind: number, start = 0) => {
      const v = base.length / 3
      for (const [cx, cy] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) { base.push(x, y, z); shape.push(slot, half, top, kind); corner.push(cx, cy); head.push(start) }
      index.push(v, v + 1, v + 2, v, v + 2, v + 3)
    }
    for (const e of this.shown) {
      if (!e) continue
      const tle = e.flash.tle!, [gx, gy] = this.where(e.flash), [wx, , wz] = this.toWorld(gx, gy, 0)
      if (tle.kind === 'halo') { quad(wx, HALO_HEIGHT, wz, e.slot, 25 + 15 * Math.min(1, tle.ratio), 0, 1); continue }
      // The stronger the field over the threshold, the more columns, the wider, and the lower the tendrils reach.
      const rng = mulberry32(Math.round(e.flash.time * 10) + e.flash.start), strength = Math.min(1, Math.log10(tle.ratio) / 1.5)
      const n = Math.round(COLUMNS[0] + (COLUMNS[1] - COLUMNS[0]) * strength), spread = 6 + 14 * strength, start = tle.height / 1000
      for (let c = 0; c < n; c++) {
        const r = spread * Math.sqrt(rng()), a = rng() * Math.PI * 2, bottom = start - 10 - 15 * rng() * (.4 + strength)
        quad(wx + r * Math.cos(a), bottom, wz + r * Math.sin(a), e.slot, COLUMN_HALF[0] + (COLUMN_HALF[1] - COLUMN_HALF[0]) * rng(), SPRITE_TOP - 4 * rng() - bottom, 0, start + 3 * (rng() - .5))
      }
    }
    const g = this.geometry
    g.setAttribute('aBase', new THREE.Float32BufferAttribute(base, 3)); g.setAttribute('position', new THREE.Float32BufferAttribute(base, 3)); g.setAttribute('aShape', new THREE.Float32BufferAttribute(shape, 4)); g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2)); g.setAttribute('aHead', new THREE.Float32BufferAttribute(head, 1))
    g.setIndex(index)
  }

  dispose() { this.geometry.dispose(); this.material.dispose() }
}
