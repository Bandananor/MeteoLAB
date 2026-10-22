import type { CameraGrade } from './camera'
import { lang } from './i18n'
import { applyState, readState, AtmosphereModel, DT, CellTracker, coldPoolBalance, type SavedState, saveState, type ColdPoolBalance, computeSounding, domainPoint, groundPoint, Station, STATION_MAX, type Environment, insolation, liveSounding, type ModelDiagnostics, parcelIndices, type ParcelIndices, type SimConfig, type Sounding, stormIndices, type StormIndices, sunDirection } from './core'
import { describeConvection } from './describe'
import { blendWeight } from './record/plan'
import { isPhone, PHONE_THREADS } from './hud'
import type { FieldMode } from './render/fields'
import type { InterventionKind, UhLayer } from './core'
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
  field: FieldMode = 'composite'; uhLayer: UhLayer = '2-5'; showVectors = false; showPrecip = false; layerMode: LayerMode = 'both'; showRainTotal = false; showMesocyclone = true; showFlanks = true; showLightning = true; volumeThreshold = .1; volumeDensity = 1; sliceHeight = 2; sliceNorth = 0
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
  /** The virtual weather stations (src/core/station.ts) by slot, each its letter and colour (null: an empty slot), up to STATION_MAX; they record with every snapshot. */
  stations: (Station | null)[] = []
  /** Model seconds per real second over the last couple of seconds: the speed the computer keeps up (0 until measured). */
  realSpeed = 0
  private speedMark: { real: number; model: number } | null = null
  /** Threads the physics runs on (see simulation.worker.ts). */
  threads = 1
  /**
   * The video recording (src/record/recorder.ts): while it runs the page neither sends real time nor draws — the
   * recorder steps the model and draws each frame itself. The last two states received (in the snapshot's layout) are
   * held, older first, for the frames between them to show their blend.
   */
  private held: { time: number; data: Float32Array }[] | null = null
  /** Called once the snapshot in flight has arrived. */
  private arrived: (() => void) | null = null

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
    if (this.held) return
    const current = JSON.stringify(this.config)
    if (current !== this.sentConfig) { this.sentConfig = current; Object.assign(this.mirror.config, this.config); this.post({ type: 'config', config: { ...this.config } }) }
    this.waiting += realDt
    if (this.inFlight) return
    this.inFlight = true
    this.post({ type: 'advance', seconds: this.waiting })
    this.waiting = 0
  }
  render() { if (!this.held) this.view.render() }

  // ---- The video recording (src/record/recorder.ts).

  get recording() { return !!this.held }
  /** Stops the run's own clock: once the batch in flight has arrived, the state now is held. */
  async startRecording() {
    while (this.inFlight) await new Promise<void>(resolve => { this.arrived = resolve })
    const data = this.pack()
    this.held = [{ time: this.mirror.time, data }, { time: this.mirror.time, data: data.slice() }]
  }
  /** The model time of the newer state held. */
  get heldTime() { return this.held ? this.held[1].time : this.mirror.time }
  /** Steps the model exactly `count` times; resolves once their snapshot is in. */
  stepModel(count: number) {
    return new Promise<void>(resolve => { this.arrived = resolve; this.inFlight = true; this.post({ type: 'steps', count }) })
  }
  /** Puts into the page's model the blend of the two states held at model time `t` (between them). */
  showAt(t: number) {
    const m = this.mirror, [a, b] = this.held!, w = blendWeight(a.time, b.time, t), { n, layer } = m.grid
    let o = 0
    const blend = (f: Float32Array | Float64Array, size: number) => { for (let i = 0; i < size; i++) f[i] = a.data[o + i] + (b.data[o + i] - a.data[o + i]) * w; o += size }
    for (const key of SNAPSHOT_FIELDS) blend(m[key], n)
    for (const key of SNAPSHOT_COLUMNS) blend(m[key], layer)
    m.time = a.time + (b.time - a.time) * w
  }
  /**
   * Draws the frame for `now` (ms on the recording's own clock: the flashes' course and the like) at the recording's
   * picture size; the picture to encode, read in the same task.
   */
  recordFrame(now: number) { return this.view.recordFrame(now) }
  /** The picture size while recording (null: back to the screen's, at the quality chosen before). */
  recordSize(size: { width: number; height: number } | null) { this.view.recordSize(size) }
  /** The view's size on the screen, CSS pixels (a video «as the screen» takes its shape). */
  get viewWidth() { return this.view.screenWidth }
  get viewHeight() { return this.view.screenHeight }
  /** Whether the GPU drew the whole picture of the frame just drawn (StormView.recordFits). */
  recordFits() { return this.view.recordFits() }
  /** Turns the camera round the point it looks at, degrees (the recording's turn round the storm). */
  turnCamera(degrees: number) { this.view.turnCamera(degrees) }
  /** Back to the run's own clock, from the newest state the model has reached. */
  stopRecording() {
    const held = this.held
    if (!held) return
    this.held = null; this.unpack(held[1].data); this.mirror.time = held[1].time
  }
  /** The page's model fields in the snapshot's layout. */
  private pack(out?: Float32Array) {
    const m = this.mirror, { n, layer } = m.grid, data = out ?? new Float32Array(SNAPSHOT_FIELDS.length * n + SNAPSHOT_COLUMNS.length * layer)
    let o = 0
    for (const key of SNAPSHOT_FIELDS) { data.set(m[key], o); o += n }
    for (const key of SNAPSHOT_COLUMNS) { data.set(m[key], o); o += layer }
    return data
  }
  private unpack(data: Float32Array) {
    const m = this.mirror, { n, layer } = m.grid
    let o = 0
    for (const key of SNAPSHOT_FIELDS) { m[key].set(data.subarray(o, o + n)); o += n }
    for (const key of SNAPSHOT_COLUMNS) { m[key].set(data.subarray(o, o + layer)); o += layer }
  }
  /** The 3D view as a PNG (StormView.snapshot). */
  snapshot() { return this.view.snapshot() }
  /** The picture's quality (StormView.setQuality), the level drawn, and a call when the automatic choice changes it. */
  setQuality(q: Quality | 'auto', start?: Quality) { this.view.setQuality(q, start) }
  get level() { return this.view.level }
  /**
   * The view from the ground (StormView.stand): at a suggested place `distance` km from the storm; on the ground under a
   * point of the view (false off the domain's ground), keeping the look when already on the ground; at the weather
   * station `index` (false without it); back to the view from outside. The observer is there for the storm chaser to come.
   */
  standSuggested(distance: number) { this.view.stand(this.view.suggestPlace(distance)) }
  standAt(nx: number, ny: number, keepLook = false) { const p = this.view.groundUnder(nx, ny); if (p) this.view.stand(p, keepLook); return !!p }
  standAtStation(index: number) {
    const s = this.stations[index]
    if (!s) return false
    // Across periodic edges the station's ground point is wrapped into the domain's span; the observer's is not (they may stand outside it).
    const d = domainPoint(this.mirror, s.x, s.y), [fu, fv] = this.mirror.frame, t = this.mirror.time
    this.view.stand({ x: d.x + fu * t, y: d.y + fv * t }); return true
  }
  leaveGround() { this.view.leaveGround() }
  get fromGround() { return this.view.fromGround }
  get groundObserver() { return this.view.groundObserver }
  zoomFromGround(deltaY: number) { return this.view.zoomFromGround(deltaY) }
  set onLevel(f: ((level: Quality) => void) | null) { this.view.onLevel = f }
  set onShaderError(f: ((log: string, gpu: string, part: string) => void) | null) { this.view.onShaderError = f }
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
  /** The ground position (m) under normalised screen coordinates: where a station placed there stands. */
  stationPoint(nx: number, ny: number) { const p = this.view.groundPoint(nx, ny); return groundPoint(this.mirror, p.x, p.y) }
  /**
   * The weather stations at these ground positions (m), one a slot (its letter and colour; null: an empty slot), the
   * first STATION_MAX. A station already standing at its place keeps its records; a new one records from now.
   */
  placeStations(grounds: readonly ({ x: number; y: number } | null)[]) {
    this.stations = grounds.slice(0, STATION_MAX).map(g => g && (this.stations.find(s => s?.x === g.x && s.y === g.y) ?? new Station(g.x, g.y)))
    for (const s of this.stations) if (s && !s.records.length) s.observe(this.mirror)
    this.markStations()
  }
  private markStations() { this.view.setStations(this.stations.map(s => !s || s.outside ? null : domainPoint(this.mirror, s.x, s.y))) }
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

  perturb(nx: number, ny: number, strength = 1) { this.intervene('thermal', nx, ny, strength) }
  /** An intervention (core/intervene.ts) where the screen point (nx, ny, 0-1) meets the ground. */
  intervene(kind: InterventionKind, nx: number, ny: number, strength = 1) { const p = this.view.groundPoint(nx, ny); this.post({ type: 'intervene', intervention: { kind, x: p.x, y: p.y, strength } }) }

  diagnostics() {
    const m = this.mirror, d = this.latest, live = this.live, text = describeConvection(d, live.sounding, m.rotation, live.env.temperatureEnv(d.cloudTop * 1000))
    return {
      ...live.sounding, ...text, indices: live.indices, storm: live.storm,
      updraft: d.updraft, downdraft: d.downdraft, rain: d.rainRate, rainTotal: d.rainTotal, cloudTop: d.cloudTop, thermalTop: d.thermalTop,
      cloudWater: d.maxCloud * 1000, coldPool: d.outflow, outflowLow: d.outflowLow, gust: d.gust, hail: d.hail, hailSwath: m.hailSize.reduce((a, b) => Math.max(a, b), 0), clipped: d.clipped, updraftHelicity: m.rotation.uh, uh01: m.rotation.uh01, uh03: m.rotation.uh03,
      insolation: insolation(m.config, m.time), sunElevation: Math.asin(Math.max(-1, Math.min(1, sunDirection(m.config, m.time).y))) * 180 / Math.PI,
    }
  }

  private post(request: WorkerRequest, transfer: Transferable[] = []) { this.worker.postMessage(request, transfer) }

  private receive(s: Snapshot) {
    if (this.awaitingLoad && !s.loaded) { this.post({ type: 'release', buffer: s.buffer }, [s.buffer]); this.inFlight = false; const arrived = this.arrived; this.arrived = null; arrived?.(); return }
    this.awaitingLoad = false
    const m = this.mirror, data = new Float32Array(s.buffer)
    this.unpack(data)
    // Recording: the older state held gives way to this one.
    if (this.held) { const [a, b] = this.held; a.data.set(data); a.time = s.time; this.held = [b, a] }
    m.time = s.time; Object.assign(m.rotation, s.rotation); this.latest = s.diagnostics; this.threads = s.threads
    const now = performance.now(), mark = this.speedMark
    if (!mark || m.time < mark.model || now - mark.real > 5000) this.speedMark = { real: now, model: m.time }
    else if (now - mark.real > 2000) { this.realSpeed = (m.time - mark.model) / ((now - mark.real) / 1000); this.speedMark = { real: now, model: m.time } }
    m.flashes.push(...s.flashes); m.flashCount = s.flashCount; m.chargeGround = s.chargeGround; m.added = s.added
    if (m.flashes.length > KEPT_FLASHES) m.flashes.splice(0, m.flashes.length - KEPT_FLASHES)
    this.post({ type: 'release', buffer: s.buffer }, [s.buffer])
    this.inFlight = false
    // Cells move about a grid column a minute: every 6 s of model time is plenty.
    if (!(m.time - this.cells.time < 6)) { this.cells.update(m); this.view.setFlanks(this.cells.cells.flatMap(c => c.flanks ? [c.flanks] : [])) }
    if (this.stations.length) { for (const s of this.stations) s?.observe(m); this.markStations() }
    this.balance = coldPoolBalance(m)
    // A rewind point every HISTORY_EVERY s (the first at the start), within HISTORY_BYTES.
    const last = this.history[this.history.length - 1]
    if (!last || m.time - last.time >= HISTORY_EVERY) {
      this.history.push({ time: m.time, buffer: saveState(m, this.config) })
      let bytes = this.history.reduce((sum, h) => sum + h.buffer.byteLength, 0)
      while (bytes > HISTORY_BYTES && this.history.length > 2) bytes -= this.history.splice(1, 1)[0].buffer.byteLength
    }
    if (!(m.time - this.live.time < LIVE_EVERY && m.time >= this.live.time)) { const l = liveSounding(m); this.live = this.derive(l.env, m.time, l.quiet, l.all) }
    this.view.afterAdvance(s.steps * DT)
    const arrived = this.arrived; this.arrived = null; arrived?.()
  }
}
