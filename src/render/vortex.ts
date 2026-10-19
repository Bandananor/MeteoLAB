import * as THREE from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { type VortexLevel, VORTEX_ZETA } from '../core'

// The mesocyclone of the 3D view as a column (2.8, core/vortex.ts): a ring every ~half km where the updraught rotates,
// as wide as the rotating area, joined through their centres, coloured by the vorticity — instead of one ring at 3.5 km.
// Grey until the rotation has held MESO_PERSISTENCE (as the ring was), then warm.

/** Ring segments. */
const SEGMENTS = 28
/** Vorticity of the colour ramp's strong end, s-1 (the classic supercell's peaks at ~0.02 on the ~1 km grid). */
const ZETA_STRONG = .025
/** A ring at most every this many m of height (the grid's levels near the ground are ~100 m apart). */
const RING_EVERY = 450
const WEAK = new THREE.Color(0xf3e3a2), STRONG = new THREE.Color(0xe2493f), GREY_WEAK = new THREE.Color(0x8d9aa2), GREY_STRONG = new THREE.Color(0xd5dee3)

export class VortexView {
  readonly line: LineSegments2
  private readonly toWorld: (x: number, y: number, z: number) => readonly [number, number, number]

  constructor(toWorld: (x: number, y: number, z: number) => readonly [number, number, number]) {
    this.toWorld = toWorld
    this.line = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial({ vertexColors: true, linewidth: 2.5, transparent: true, opacity: .9, depthWrite: false }))
    this.line.renderOrder = 3; this.line.visible = false; this.line.frustumCulled = false
  }

  /** Draws the column (bottom up); `held`: the mesocyclone has held long enough to be one. */
  update(levels: VortexLevel[], visible: boolean, held: boolean, resolution: THREE.Vector2) {
    this.line.visible = visible && levels.length > 1
    ;(this.line.material as LineMaterial).resolution.copy(resolution)
    if (!this.line.visible) return
    const positions: number[] = [], colors: number[] = [], c = new THREE.Color()
    const colour = (zeta: number) => c.lerpColors(held ? WEAK : GREY_WEAK, held ? STRONG : GREY_STRONG, Math.min(1, (zeta - VORTEX_ZETA) / (ZETA_STRONG - VORTEX_ZETA)))
    let ringAt = -Infinity
    levels.forEach((l, k) => {
      colour(l.zeta)
      const ring = l.z - ringAt >= RING_EVERY || k === levels.length - 1
      if (ring) ringAt = l.z
      if (ring) for (let s = 0; s < SEGMENTS; s++) {
        const a = s / SEGMENTS * Math.PI * 2, b = (s + 1) / SEGMENTS * Math.PI * 2
        positions.push(...this.toWorld(l.x + l.radius * Math.cos(a), l.y + l.radius * Math.sin(a), l.z), ...this.toWorld(l.x + l.radius * Math.cos(b), l.y + l.radius * Math.sin(b), l.z))
        colors.push(c.r, c.g, c.b, c.r, c.g, c.b)
      }
      // The axis through the centres.
      if (k) { const p = levels[k - 1]; positions.push(...this.toWorld(p.x, p.y, p.z), ...this.toWorld(l.x, l.y, l.z)); colors.push(c.r, c.g, c.b, c.r, c.g, c.b) }
    })
    const g = this.line.geometry as LineSegmentsGeometry
    g.setPositions(positions); g.setColors(colors)
  }

  dispose() { this.line.geometry.dispose(); (this.line.material as THREE.Material).dispose() }
}
