import { AtmosphereModel, insolation, type SimConfig, sunDirection } from './core'
import { describeConvection } from './describe'
import type { FieldMode } from './render/fields'
import { StormView, type ViewSettings } from './render/view'

/** Couples the physics model with its 3D view; the UI talks only to this class. */
export class Atmosphere implements ViewSettings {
  field: FieldMode = 'composite'; showVectors = false; showPrecip = false; showFieldVolume = true; sliceHeight = 2; sliceNorth = 0
  private readonly model: AtmosphereModel; private readonly view: StormView

  constructor(canvas: HTMLCanvasElement, config: SimConfig) {
    this.model = new AtmosphereModel(config)
    this.view = new StormView(canvas, this.model, this)
  }

  get time() { return this.model.time }

  advance(realDt: number) { this.view.afterAdvance(this.model.advance(realDt)) }
  render() { this.view.render() }
  dispose() { this.view.dispose() }
  sounding() { return this.model.sounding }

  /** Double-click: warm moist thermal under the given normalised screen point. */
  perturb(nx: number, ny: number, strength = 1) { const p = this.view.groundPoint(nx, ny); this.model.injectBubble(p.x, p.y, strength) }

  diagnostics() {
    const m = this.model, d = m.diagnostics(), text = describeConvection(d, m.sounding, m.rotation)
    return {
      ...m.sounding, ...text,
      updraft: d.updraft, downdraft: d.downdraft, rain: d.rainRate, cloudTop: d.cloudTop, thermalTop: d.thermalTop,
      cloudWater: d.maxCloud * 1000, coldPool: d.coldMax, microburst: d.microburst, updraftHelicity: m.rotation.uh,
      insolation: insolation(m.config, m.time), sunElevation: Math.asin(Math.max(-1, Math.min(1, sunDirection(m.config, m.time).y))) * 180 / Math.PI,
    }
  }
}
