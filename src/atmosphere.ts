import { AtmosphereModel, insolation, type ModelDiagnostics, type SimConfig, sunDirection } from './core'
import { describeConvection } from './describe'
import type { FieldMode } from './render/fields'
import { StormView, type ViewSettings } from './render/view'
import { SNAPSHOT_COLUMNS, SNAPSHOT_FIELDS, type Snapshot, type WorkerRequest } from './simulation'

/**
 * Couples the physics with its 3D view; the UI talks only to this class. The physics runs in a Web Worker; here a
 * mirror AtmosphereModel (same config, so the same grid, environment and sounding, never stepped) receives the fields
 * of every snapshot, so the view and the field slices read it exactly as they would read the live model.
 */
export class Atmosphere implements ViewSettings {
  field: FieldMode = 'composite'; showVectors = false; showPrecip = false; showFieldVolume = true; sliceHeight = 2; sliceNorth = 0
  private readonly mirror: AtmosphereModel; private readonly view: StormView; private readonly worker: Worker
  private readonly config: SimConfig; private sentConfig: string
  private latest: ModelDiagnostics

  constructor(canvas: HTMLCanvasElement, config: SimConfig) {
    this.config = config; this.sentConfig = JSON.stringify(config)
    this.mirror = new AtmosphereModel({ ...config })
    this.latest = this.mirror.diagnostics()
    this.view = new StormView(canvas, this.mirror, this)
    this.worker = new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' })
    this.worker.addEventListener('message', (event: MessageEvent<Snapshot>) => this.receive(event.data))
    this.post({ type: 'init', config: { ...config } })
  }

  get time() { return this.mirror.time }

  /** Sends the real elapsed time (and any slider change) to the worker; the fields arrive with the next snapshot. */
  advance(realDt: number) {
    const current = JSON.stringify(this.config)
    if (current !== this.sentConfig) { this.sentConfig = current; Object.assign(this.mirror.config, this.config); this.post({ type: 'config', config: { ...this.config } }) }
    this.post({ type: 'advance', seconds: realDt })
  }
  render() { this.view.render() }
  dispose() { this.worker.terminate(); this.view.dispose() }
  sounding() { return this.mirror.sounding }

  /** Double-click: warm moist thermal under the given normalised screen point. */
  perturb(nx: number, ny: number, strength = 1) { const p = this.view.groundPoint(nx, ny); this.post({ type: 'perturb', x: p.x, y: p.y, strength }) }

  diagnostics() {
    const m = this.mirror, d = this.latest, text = describeConvection(d, m.sounding, m.rotation)
    return {
      ...m.sounding, ...text,
      updraft: d.updraft, downdraft: d.downdraft, rain: d.rainRate, cloudTop: d.cloudTop, thermalTop: d.thermalTop,
      cloudWater: d.maxCloud * 1000, coldPool: d.coldMax, microburst: d.microburst, updraftHelicity: m.rotation.uh,
      insolation: insolation(m.config, m.time), sunElevation: Math.asin(Math.max(-1, Math.min(1, sunDirection(m.config, m.time).y))) * 180 / Math.PI,
    }
  }

  private post(request: WorkerRequest, transfer: Transferable[] = []) { this.worker.postMessage(request, transfer) }

  private receive(s: Snapshot) {
    const m = this.mirror, { n, layer } = m.grid, data = new Float32Array(s.buffer)
    let offset = 0
    for (const key of SNAPSHOT_FIELDS) { m[key].set(data.subarray(offset, offset + n)); offset += n }
    for (const key of SNAPSHOT_COLUMNS) { m[key].set(data.subarray(offset, offset + layer)); offset += layer }
    m.time = s.time; m.microburstOutflow = s.microburstOutflow; Object.assign(m.rotation, s.rotation); this.latest = s.diagnostics
    this.post({ type: 'release', buffer: s.buffer }, [s.buffer])
    this.view.afterAdvance(s.steps)
  }
}
