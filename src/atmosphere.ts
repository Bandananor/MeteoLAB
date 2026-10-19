import type { CameraGrade } from './camera'
import { lang } from './i18n'
import { applyState, readState, AtmosphereModel, CellTracker, coldPoolBalance, type SavedState, saveState, type ColdPoolBalance, computeSounding, domainPoint, groundPoint, Station, type Environment, insolation, liveSounding, type ModelDiagnostics, parcelIndices, type ParcelIndices, type SimConfig, type Sounding, stormIndices, type StormIndices, sunDirection } from './core'
import { describeConvection } from './describe'
import { isPhone, PHONE_THREADS } from './hud'
import type { FieldMode } from './render/fields'
import type { UhLayer } from './core'
import { type LayerMode, type Quality, StormView, type ViewSettings } from './render/view'
import { SNAPSHOT_COLUMNS, SNAPSHOT_FIELDS, type Snapshot, type WorkerRequest } from './simulation'

/** How often the live sounding (src/core/live.ts) and everything derived from it is recomputed, s of model time. */
export const LIVE_EVERY = 60

/** Rewind points: a saved state every HISTORY_EVERY s of model time, the oldest dropped beyond HISTORY_BYTES in all. */
export const HISTORY_EVERY = 300, HISTORY_BYTES = 64 * 1024 * 1024

/** Flashes the page keeps for the lightning detector (the latest; ~an hour of a supercell). */
export const KEPT_FLASHES = 3000

/** The live sounding and what the panels show from it. */
export interface Live { time: number; quiet: number; all: boolean; env: Environment; sounding: Sounding; indices: ParcelIndices; storm: StormIndices }

/**
 * Couples the physics with its 3D view; the UI talks only to this class. The physics runs in a Web Worker; here a
 * mirror AtmosphereModel (same config, so the same grid, environment and sounding, never stepped) receives the fields
 * of every snapshot, so the view and the field slices read it exactly as they would read the live model.
 */
export class Atmosphere implements ViewSettings {
  field: FieldMode = 'composite'; uhLayer: UhLayer = '2-5'; showVectors = false; showPrecip = false; layerMode: LayerMode = 'both'; showRainTotal = false; showMesocyclone = true; showLightning = true; volumeThreshold = .1; volumeDensity = 1; sliceHeight = 2; sliceNorth = 0
  private readonly mirror: AtmosphereModel; private readonly view: StormView; private readonly worker: Worker
  private readonly config: SimConfig; private sentConfig: string
  private latest: ModelDiagnostics
  /**
   * One advance request in flight at a time: while the worker computes a batch, the elapsed real time only accumulates
   * here. Before this, a request went out every frame and queued up behind a slow batch; the view froze, then the
   * worker ran the whole queue and the model time jumped minutes ahead (seen with ice, as the anvil grew).
   */
  private inFlight = false; private waiting = 0
  /**
   * The environment now (src/core/live.ts): the sounding, the standard parcels, Bunkers motion, SRH, SCP and STP,
   * recomputed every LIVE_EVERY s of model time; at the start, the starting environment.
   */
  live: Live
  /** Convective cells found and followed in every snapshot (src/core/cells.ts). */
  readonly cells = new CellTracker()
  /** The cold pool against the low-level shear (RKW, src/core/rkw.ts) at the last snapshot; null without a cold pool. */
  balance: ColdPoolBalance | null = null
  /** A state was sent to the worker: snapshots computed before it arrived are dropped until the one that says loaded. */
  private awaitingLoad = false
  /** Saved states to rewind to (src/core/state.ts), oldest first. */
  readonly history: { time: number; buffer: ArrayBuffer }[] = []
  /** The virtual weather station (src/core/station.ts), if one is placed; it records with every snapshot. */
  station: Station | null = null
  /** Model seconds per real second over the last couple of seconds: the speed the computer keeps up (0 until measured). */
  realSpeed = 0
  private speedMark: { real: number; model: number } | null = null
  /** Threads the physics runs on (see simulation.worker.ts). */
  threads = 1

  constructor(canvas: HTMLCanvasElement, config: SimConfig) {
    this.config = config; this.sentConfig = JSON.stringify(config)
    this.mirror = new AtmosphereModel({ ...config })
    this.latest = this.mirror.diagnostics()
    this.live = this.derive(this.mirror.env, 0, 1, false)
    this.view = new StormView(canvas, this.mirror, this)
    this.worker = new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' })
    this.worker.addEventListener('message', (event: MessageEvent<Snapshot>) => this.receive(event.data))
    // Fewer threads on a phone (it would overheat), unless the address asks for a number.
    const threads = Number(new URLSearchParams(location.search).get('threads')) || (isPhone() ? PHONE_THREADS : undefined)
    this.post({ type: 'init', config: { ...config }, threads, lang: lang() })
  }

  get time() { return this.mirror.time }
  /** The model as last received from the worker (read-only use: the radar display samples it). */
  get model() { return this.mirror }
  /** Bunkers motion, SRH, SCP and STP of the live sounding. */
  get storm() { return this.live.storm }

  /** Sends the real elapsed time (and any slider change) to the worker; the fields arrive with the next snapshot. */
  advance(realDt: number) {
    const current = JSON.stringify(this.config)
    if (current !== this.sentConfig) { this.sentConfig = current; Object.assign(this.mirror.config, this.config); this.post({ type: 'config', config: { ...this.config } }) }
    this.waiting += realDt
    if (this.inFlight) return
    this.inFlight = true
    this.post({ type: 'advance', seconds: this.waiting })
    this.waiting = 0
  }
  render() { this.view.render() }
  /** The 3D view as a PNG (StormView.snapshot). */
  snapshot() { return this.view.snapshot() }
  /** The picture's quality (StormView.setQuality), the level drawn, and a call when the automatic choice changes it. */
  setQuality(q: Quality | 'auto', start?: Quality) { this.view.setQuality(q, start) }
  get level() { return this.view.level }
  /**
   * The view from the ground (StormView.stand): at a suggested place `distance` km from the storm; on the ground under a
   * point of the view (false off the domain's ground), keeping the look when already on the ground; at the weather
   * station (false without one); back to the view from outside. The observer is there for the storm chaser to come.
   */
  standSuggested(distance: number) { this.view.stand(this.view.suggestPlace(distance)) }
  standAt(nx: number, ny: number, keepLook = false) { const p = this.view.groundUnder(nx, ny); if (p) this.view.stand(p, keepLook); return !!p }
  standAtStation() {
    if (!this.station) return false
    // Across periodic edges the station's ground point is wrapped into the domain's span; the observer's is not (they may stand outside it).
    const d = domainPoint(this.mirror, this.station.x, this.station.y), [fu, fv] = this.mirror.frame, t = this.mirror.time
    this.view.stand({ x: d.x + fu * t, y: d.y + fv * t }); return true
  }
  leaveGround() { this.view.leaveGround() }
  get fromGround() { return this.view.fromGround }
  get groundObserver() { return this.view.groundObserver }
  zoomFromGround(deltaY: number) { return this.view.zoomFromGround(deltaY) }
  set onLevel(f: ((level: Quality) => void) | null) { this.view.onLevel = f }
  set onShaderError(f: ((log: string, gpu: string) => void) | null) { this.view.onShaderError = f }
  /** The last flash again, slowed down (see StormView.replayLightning). */
  replayLightning(rate: number) { return this.view.replayLightning(rate) }
  /** The camera's settings (StormView.setGrade). */
  setGrade(g: CameraGrade) { this.view.setGrade(g) }
  dispose() { this.worker.terminate(); this.view.dispose() }
  sounding() { return this.live.sounding }

  private derive(env: Environment, time: number, quiet: number, all: boolean): Live {
    const h = this.mirror.grid.height, indices = parcelIndices(env, h)
    return { time, quiet, all, env, sounding: computeSounding(this.mirror.config, env, h), indices, storm: stormIndices(env, indices) }
  }

  /** Double-click: warm moist thermal under the given normalised screen point. */
  /** Ground point (m) under normalised screen coordinates. */
  groundPoint(nx: number, ny: number) { return this.view.groundPoint(nx, ny) }
  /** Canvas position of a model point (m), or null behind the camera. */
  screenPoint(x: number, y: number, z: number) { return this.view.screenPoint(x, y, z) }
  /** Places the weather station on the ground under normalised screen coordinates; returns its ground position (m). */
  placeStation(nx: number, ny: number) { const p = this.view.groundPoint(nx, ny), g = groundPoint(this.mirror, p.x, p.y); this.placeStationAt(g); return g }
  /** Places the weather station at a ground position (m), or removes it (null). */
  placeStationAt(g: { x: number; y: number } | null) { this.station = g && new Station(g.x, g.y); if (this.station) this.station.observe(this.mirror); this.markStation() }
  private markStation() { this.view.setStation(this.station && !this.station.outside ? domainPoint(this.mirror, this.station.x, this.station.y) : null) }
  /** Rings the selected cell in the 3D view. */
  setSelection(p: { x: number; y: number } | null) { this.view.setSelection(p) }

  /** The current state as a .meteolab file (src/core/state.ts), from the fields the page holds. */
  saveState() { return saveState(this.mirror, this.config) }
  /** Goes back to a rewind point: the run continues from there and the later points are dropped (a new branch). */
  rewind(time: number) {
    const k = this.history.findIndex(h => h.time === time)
    if (k < 0) return
    const buffer = this.history[k].buffer.slice(0)
    this.history.length = k + 1
    this.loadState(readState(buffer), buffer)
  }

  /** Continues from a saved state (this Atmosphere must have been built with its settings): the page and the worker. */
  loadState(state: SavedState, buffer: ArrayBuffer) { applyState(this.mirror, state); this.awaitingLoad = true; this.live = this.derive(this.mirror.env, -LIVE_EVERY, 1, false); this.post({ type: 'load', buffer }, [buffer]) }

  perturb(nx: number, ny: number, strength = 1) { const p = this.view.groundPoint(nx, ny); this.post({ type: 'perturb', x: p.x, y: p.y, strength }) }

  diagnostics() {
    const m = this.mirror, d = this.latest, live = this.live, text = describeConvection(d, live.sounding, m.rotation, live.env.temperatureEnv(d.cloudTop * 1000))
    return {
      ...live.sounding, ...text, indices: live.indices, storm: live.storm,
      updraft: d.updraft, downdraft: d.downdraft, rain: d.rainRate, rainTotal: d.rainTotal, cloudTop: d.cloudTop, thermalTop: d.thermalTop,
      cloudWater: d.maxCloud * 1000, coldPool: d.coldMax, gust: d.gust, hail: d.hail, hailSwath: m.hailSize.reduce((a, b) => Math.max(a, b), 0), clipped: d.clipped, updraftHelicity: m.rotation.uh, uh01: m.rotation.uh01, uh03: m.rotation.uh03,
      insolation: insolation(m.config, m.time), sunElevation: Math.asin(Math.max(-1, Math.min(1, sunDirection(m.config, m.time).y))) * 180 / Math.PI,
    }
  }

  private post(request: WorkerRequest, transfer: Transferable[] = []) { this.worker.postMessage(request, transfer) }

  private receive(s: Snapshot) {
    if (this.awaitingLoad && !s.loaded) { this.post({ type: 'release', buffer: s.buffer }, [s.buffer]); this.inFlight = false; return }
    this.awaitingLoad = false
    const m = this.mirror, { n, layer } = m.grid, data = new Float32Array(s.buffer)
    let offset = 0
    for (const key of SNAPSHOT_FIELDS) { m[key].set(data.subarray(offset, offset + n)); offset += n }
    for (const key of SNAPSHOT_COLUMNS) { m[key].set(data.subarray(offset, offset + layer)); offset += layer }
    m.time = s.time; Object.assign(m.rotation, s.rotation); this.latest = s.diagnostics; this.threads = s.threads
    const now = performance.now(), mark = this.speedMark
    if (!mark || m.time < mark.model || now - mark.real > 5000) this.speedMark = { real: now, model: m.time }
    else if (now - mark.real > 2000) { this.realSpeed = (m.time - mark.model) / ((now - mark.real) / 1000); this.speedMark = { real: now, model: m.time } }
    m.flashes.push(...s.flashes); m.flashCount = s.flashCount; m.chargeGround = s.chargeGround
    if (m.flashes.length > KEPT_FLASHES) m.flashes.splice(0, m.flashes.length - KEPT_FLASHES)
    this.post({ type: 'release', buffer: s.buffer }, [s.buffer])
    this.inFlight = false
    // Cells move about a grid column a minute: every 6 s of model time is plenty.
    if (!(m.time - this.cells.time < 6)) this.cells.update(m)
    if (this.station) { this.station.observe(m); this.markStation() }
    this.balance = coldPoolBalance(m)
    // A rewind point every HISTORY_EVERY s (the first at the start), within HISTORY_BYTES.
    const last = this.history[this.history.length - 1]
    if (!last || m.time - last.time >= HISTORY_EVERY) {
      this.history.push({ time: m.time, buffer: saveState(m, this.config) })
      let bytes = this.history.reduce((sum, h) => sum + h.buffer.byteLength, 0)
      while (bytes > HISTORY_BYTES && this.history.length > 2) bytes -= this.history.splice(1, 1)[0].buffer.byteLength
    }
    if (!(m.time - this.live.time < LIVE_EVERY && m.time >= this.live.time)) { const l = liveSounding(m); this.live = this.derive(l.env, m.time, l.quiet, l.all) }
    this.view.afterAdvance(s.steps)
  }
}
