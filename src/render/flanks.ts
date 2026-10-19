import * as THREE from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { L } from '../i18n'
import { anvilPoint, type AtmosphereModel, contour, inflowPoint, outflowDeficit, stormMotion, type StormFlanks } from '../core'

// The supercell's flanks on the ground of the 3D view (2.8, core/flanks.ts), drawn as on the Lemon & Doswell (1979)
// diagram: the FFD and RFD shaded, their gust fronts (the outflow's edge, θv 1 K below the warm air) as lines, and the
// labels of the storm's parts (2.8, «clear labels»): each downdraught, the inflow, the mesocyclone, the anvil and the
// rear-flank gust front. In the domain's frame: they move with the storm, not with the ground.

/** The gust front: the outflow's θv deficit at the ground, K. */
export const GUST_FRONT_COLD = 1
/** A gust front is drawn where it is within this distance of its flank's columns, m. */
const GUST_REACH = 3000
const FFD_COLOR = [52, 120, 225] as const, RFD_COLOR = [222, 64, 126] as const, TEXT_COLOR = [232, 238, 242] as const, MESO_COLOR = [240, 180, 76] as const, INFLOW_COLOR = [120, 220, 140] as const
/** The labels of each storm, in this order. */
const PARTS: [string, readonly number[]][] = [['FFD', FFD_COLOR], ['RFD', RFD_COLOR], [L('приток', 'inflow'), INFLOW_COLOR], [L('мезоциклон', 'mesocyclone'), MESO_COLOR], [L('наковальня', 'anvil'), TEXT_COLOR], [L('фронт порывов', 'gust front'), RFD_COLOR]]
/** A label's height, as a share of the view's height. */
const LABEL_SIZE = .032
/** At most this many storms labelled. */
const LABELS = 4

const label = (text: string, [r, g, b]: readonly number[]) => {
  const c = document.createElement('canvas'), font = '600 40px system-ui, sans-serif', probe = c.getContext('2d')!
  probe.font = font
  const w = Math.ceil(probe.measureText(text).width) + 24
  c.width = w; c.height = 64
  const x = c.getContext('2d')!
  x.font = font; x.textAlign = 'center'; x.textBaseline = 'middle'
  x.lineWidth = 6; x.strokeStyle = 'rgba(10,14,20,.8)'; x.strokeText(text, w / 2, 34); x.fillStyle = `rgb(${r},${g},${b})`; x.fillText(text, w / 2, 34)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  // The same size on the screen at any distance, as a map's labels (sizeAttenuation off: the scale is a share of the view's height).
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: false, toneMapped: false, sizeAttenuation: false }))
  s.scale.set(LABEL_SIZE * w / 64, LABEL_SIZE, 1); s.renderOrder = 5; s.visible = false
  return s
}

export class FlankView {
  readonly group = new THREE.Group()
  private readonly data: Uint8Array; private readonly texture: THREE.DataTexture; private readonly shade: THREE.Mesh
  private readonly fronts: [LineSegments2, LineSegments2]
  private readonly labels: THREE.Sprite[] = []
  private flanks: StormFlanks[] = []; private dirty = true
  private readonly model: AtmosphereModel; private readonly toWorld: (x: number, y: number, z: number) => readonly [number, number, number]

  constructor(model: AtmosphereModel, toWorld: (x: number, y: number, z: number) => readonly [number, number, number]) {
    this.model = model; this.toWorld = toWorld
    const { nx, ny, dx, dy, width, depth } = model.grid
    this.data = new Uint8Array(nx * ny * 4); this.texture = new THREE.DataTexture(this.data, nx, ny, THREE.RGBAFormat)
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter; this.texture.needsUpdate = true
    this.shade = new THREE.Mesh(new THREE.PlaneGeometry(width / 1000, depth / 1000), new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false, depthTest: false, toneMapped: false }))
    // Over the clouds, as a map's overlay (under them from above it would not be seen), with the lines and labels.
    this.shade.renderOrder = 3
    // A texel's centre on its column's node (x dx, y dy), as the flanks place them: half a column west and south.
    this.shade.rotation.x = -Math.PI / 2; this.shade.position.set(-dx / 2000, .025, dy / 2000)
    const line = (rgb: readonly number[]) => { const l = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial({ color: new THREE.Color(`rgb(${rgb.join(',')})`).getHex(), linewidth: 3, transparent: true, opacity: .95, depthWrite: false })); l.renderOrder = 3; return l }
    this.fronts = [line(FFD_COLOR), line(RFD_COLOR)]
    for (let k = 0; k < LABELS; k++) for (const [text, colour] of PARTS) this.labels.push(label(text, colour))
    this.group.add(this.shade, ...this.fronts, ...this.labels)
  }

  /** The flanks of the rotating storms now (CellTracker: Cell.flanks). */
  set(flanks: StormFlanks[]) { this.flanks = flanks; this.dirty = true }

  /** `top`: the top of the strongest storm's rotating column (core/vortex.ts), m, for the mesocyclone's label. */
  update(visible: boolean, resolution: THREE.Vector2, top: { x: number; y: number; z: number } | null = null) {
    this.group.visible = visible && this.flanks.length > 0
    for (const f of this.fronts) (f.material as LineMaterial).resolution.copy(resolution)
    if (!this.group.visible || !this.dirty) return
    this.dirty = false
    const m = this.model, { nx, ny, dx, dy } = m.grid, d = this.data
    d.fill(0)
    for (const f of this.flanks) for (const [flank, [r, g, b]] of [[f.ffd, FFD_COLOR], [f.rfd, RFD_COLOR]] as const) for (const c of flank?.columns ?? []) d.set([r, g, b, 150], c * 4)
    this.texture.needsUpdate = true
    // The gust fronts: the contour of the outflow's edge where it borders a flank (within GUST_REACH of its columns:
    // not the old outflow of other cells, nor the edge's across the periodic seam), of the nearer flank's colour.
    const near = [new Float32Array(nx * ny).fill(Infinity), new Float32Array(nx * ny).fill(Infinity)], rx = Math.ceil(GUST_REACH / dx), ry = Math.ceil(GUST_REACH / dy)
    for (const f of this.flanks) [f.ffd, f.rfd].forEach((flank, k) => {
      for (const c of flank?.columns ?? []) for (let j = -ry; j <= ry; j++) for (let i = -rx; i <= rx; i++) {
        const x = c % nx + i, y = Math.floor(c / nx) + j, r = Math.hypot(i * dx, j * dy)
        if (x >= 0 && x < nx && y >= 0 && y < ny && r < near[k][x + nx * y]) near[k][x + nx * y] = r
      }
    })
    const segments: [number[], number[]] = [[], []], cold = outflowDeficit(m)
    for (const [x1, y1, x2, y2] of contour(cold.deficit, nx, ny, GUST_FRONT_COLD)) {
      const c = Math.round((x1 + x2) / 2) + nx * Math.round((y1 + y2) / 2), k = near[0][c] <= near[1][c] ? 0 : 1
      if (near[k][c] > GUST_REACH) continue
      segments[k].push(...this.toWorld(x1 * dx, y1 * dy, 30), ...this.toWorld(x2 * dx, y2 * dy, 30))
    }
    this.fronts.forEach((l, k) => { l.visible = segments[k].length > 0; if (l.visible) (l.geometry as LineSegmentsGeometry).setPositions(segments[k]) })
    // The labels: each downdraught above its middle, the inflow upstream, the mesocyclone over its column, the anvil at its
    // level, the rear-flank gust front at its part nearest the inflow (where it lifts the warm air).
    this.labels.forEach(s => { s.visible = false })
    const motion = stormMotion(m.env).rightMover, rear = segments[1]
    const put = (k: number, part: number, x: number, y: number, z: number) => { const s = this.labels[PARTS.length * k + part], [wx, , wz] = this.toWorld(x, y, 0); s.position.set(wx, z / 1000, wz); s.visible = true }
    this.flanks.slice(0, LABELS).forEach((f, k) => {
      const cx = (f.centre % nx) * dx, cy = Math.floor(f.centre / nx) * dy, [ex, ey] = f.heading
      ;[f.ffd, f.rfd].forEach((flank, j) => { if (flank) put(k, j, cx + flank.along * ex - flank.left * ey, cy + flank.along * ey + flank.left * ex, 1800) })
      const [ix, iy] = inflowPoint(m, f, motion)
      put(k, 2, ix, iy, 900)
      const mesoAt = k === 0 && top ? top : { x: cx, y: cy, z: 5000 }
      put(k, 3, mesoAt.x, mesoAt.y, mesoAt.z + 900)
      const anvil = anvilPoint(m, f, motion)
      if (anvil) put(k, 4, anvil.x, anvil.y, anvil.z + 1200)
      // The rear gust front's segment midpoint nearest the inflow point (the segments are world coordinates).
      const [iwx, , iwz] = this.toWorld(ix, iy, 0)
      let best = -1, bestD = 10
      for (let q = 0; q < rear.length; q += 6) { const d = Math.hypot((rear[q] + rear[q + 3]) / 2 - iwx, (rear[q + 2] + rear[q + 5]) / 2 - iwz); if (d < bestD) { bestD = d; best = q } }
      if (best >= 0) { const s = this.labels[PARTS.length * k + 5]; s.position.set((rear[best] + rear[best + 3]) / 2, .6, (rear[best + 2] + rear[best + 5]) / 2); s.visible = true }
    })
  }

  dispose() {
    this.texture.dispose(); this.shade.geometry.dispose(); (this.shade.material as THREE.Material).dispose()
    for (const l of this.fronts) { l.geometry.dispose(); (l.material as THREE.Material).dispose() }
    for (const s of this.labels) { s.material.map?.dispose(); s.material.dispose() }
  }
}
