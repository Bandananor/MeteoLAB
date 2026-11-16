// Runs the physics off the main thread. The main thread sends real elapsed time, config changes and thermals; the worker
// answers each batch of steps with a snapshot of the fields the view draws (see Atmosphere), in recycled buffers.
// With cross-origin isolation the steps are shared with helper threads (step.worker.ts, src/core/threads.ts).
import { AtmosphereModel, controlBuffer, createGrid, domainGrid, DT, type SimConfig, SharedMemory, ThreadRunner, TRANSPORT_SLABS, applyState, readState, intervene, saveState } from './core'
import type { GpuDynamics } from './gpu/dynamics'
import { gpuStep } from './gpu/step'
import { BATCH_BUDGET_MS, type GpuMode, MAX_STEPS_PER_BATCH, maxThreads, SNAPSHOT_COLUMNS, SNAPSHOT_FIELDS, type Snapshot, type Tuned, TUNE_STEPS, TUNE_WARM, TUNE_WORSE, type WorkerRequest } from './simulation'
import type { HelperStart } from './step.worker'
import { setLang } from './i18n'

const scope = self as unknown as {
  crossOriginIsolated?: boolean
  postMessage(message: unknown, transfer: Transferable[]): void; addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void
}
let model: AtmosphereModel | null = null, accumulator = 0, pendingSteps = 0
/** Flashes (counted since the start) already sent to the main thread. */
let sentFlashes = 0
const flashTotal = (m: AtmosphereModel) => m.flashCount.ic + m.flashCount.cg
/** A state was just loaded: the next snapshot says so (Snapshot.loaded). */
let loaded = false
// Snapshot buffers come back from the main thread after it has copied them; at most two exist (one drawn, one in flight).
const free: ArrayBuffer[] = []
let buffers = 0
/** The helper threads of the current model; the model steps only once all of them have attached. */
let pool: ThreadRunner | null = null, ready = true, generation = 0
/** Threads the model runs on now, and the most it may use (the page's limit and the device). */
let current = 1, ceiling = 1

/**
 * The dynamics on the GPU (Э3 step 5, src/gpu/dynamics.ts): the face projection and the RK3 stages of the transport with
 * the pressure in them run on WebGPU, everything else on the CPU threads. 'auto' uses it where WebGPU exists and the
 * model's transport is the one the GPU does (model.gpuDynamics()); 'off', or no WebGPU, or an error: the CPU as before.
 */
let gpuMode: GpuMode = 'auto', gpu: GpuDynamics | null = null, gpuState = 'off'

/** Makes (or keeps) the GPU dynamics for the current model; the CPU steps until it is ready. */
function startGpu() {
  const m = model
  if (!m) return
  if (gpu && (gpuMode === 'off' || !gpu.matches(m.grid, m.env))) { gpu.destroy(); gpu = null }
  if (gpu || gpuMode === 'off' || !m.gpuDynamics()) { gpuState = gpu ? gpuState : gpuMode === 'off' ? 'off' : 'cpu-transport'; return }
  const nav = navigator as Navigator & { gpu?: GPU }
  if (!nav.gpu) { gpuState = 'unavailable'; return }
  const id = generation
  gpuState = 'starting'
  void import('./gpu/dynamics').then(({ GpuDynamics }) => GpuDynamics.create(m.grid, m.env)).then(g => {
    if (id !== generation || gpuMode === 'off' || model !== m) { g.destroy(); return }
    gpu = g; gpuState = g.adapter || 'WebGPU'
  }, e => { gpuState = `error: ${String((e as Error)?.message ?? e)}` })
}

/** Time of the steps since the last snapshot, ms: whole steps and the wait for the GPU's part, and their count. */
const timing = { step: 0, gpu: 0, steps: 0 }

/** One model step: on the GPU when it is ready, otherwise (or after a GPU error) all on the CPU. */
async function stepModel(m: AtmosphereModel) {
  const g = gpu
  if (!g || !m.gpuDynamics()) { m.step(DT); m.time += DT; return }
  const { waitMs, failed } = await gpuStep(m, g, DT)
  timing.gpu += waitMs
  // The GPU failed: the step was finished on the CPU, and the CPU goes on from now.
  if (failed !== null) { gpuState = `error: ${failed}`; gpu = null; g.destroy() }
  m.time += DT
}

/** Threads for the physics: this worker plus helpers, leaving one core for the page. One without shared memory. */
function threadCount(limit = Infinity) {
  if (!scope.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') return 1
  return Math.max(1, Math.min(limit, maxThreads()))
}

/** The thread trial (see TUNE_* in simulation.ts): counts still to try, the timed ones, the count running, steps done on it, their time. */
let tune: { left: number[]; done: { threads: number; ms: number }[]; current: number; steps: number; ms: number } | null = null

/** Moves the running model onto `threads` threads: its state saved, the pool restarted, the state put back. */
function switchThreads(threads: number) {
  if (!model) return
  const config = model.config, buffer = saveState(model, config)
  start(config, threads)
  applyState(model!, readState(buffer)); sentFlashes = flashTotal(model!)
}

/** One timed step of the trial; when a count is done, the next one or the end (the fastest kept, the page told). */
function tuneStep(ms: number) {
  const t = tune
  if (!t || !ready) return
  if (++t.steps <= TUNE_WARM) return
  t.ms += ms
  if (t.steps < TUNE_WARM + TUNE_STEPS) return
  t.done.push({ threads: t.current, ms: t.ms / TUNE_STEPS })
  const best = t.done.reduce((a, b) => (b.ms < a.ms ? b : a))
  const next = t.left.shift()
  if (next !== undefined && t.done[t.done.length - 1].ms <= best.ms * TUNE_WORSE) { t.current = next; t.steps = 0; t.ms = 0; switchThreads(next); return }
  tune = null
  if (best.threads !== current) switchThreads(best.threads)
  scope.postMessage({ type: 'tuned', threads: best.threads, trial: t.done } satisfies Tuned, [])
}

function start(config: SimConfig, limit?: number) {
  pool?.stop(); pool = null
  const threads = threadCount(limit), id = ++generation
  current = threads
  sentFlashes = 0
  if (threads === 1) { model = new AtmosphereModel(config); ready = true; startGpu(); send(); return }
  const memory = new SharedMemory(), grid = domainGrid(config.domain, config.top, config.domainSize, config.spacing), control = controlBuffer()
  model = new AtmosphereModel(config, createGrid(grid), undefined, { memory })
  const runner = new ThreadRunner(model, control, threads - 1), started: Promise<unknown>[] = []
  for (let k = 0; k < threads - 1; k++) {
    const helper = new Worker(new URL('./step.worker.ts', import.meta.url), { type: 'module' })
    started.push(new Promise(resolve => helper.addEventListener('message', resolve, { once: true })))
    helper.postMessage({ config: { ...config }, grid, buffers: memory.buffers, control } satisfies HelperStart)
  }
  model.runner = pool = runner; model.transportSlabs = TRANSPORT_SLABS; ready = false
  startGpu()
  void Promise.all(started).then(() => { if (id === generation) { ready = true; send() } })
}

function send() {
  if (!model || !ready) return
  const { n, layer } = model.grid, size = (SNAPSHOT_FIELDS.length * n + SNAPSHOT_COLUMNS.length * layer) * 4
  const buffer = free.pop() ?? (buffers < 2 ? (buffers++, new ArrayBuffer(size)) : null)
  if (!buffer) return // the main thread still holds both; the steps go out with the next snapshot
  const data = new Float32Array(buffer)
  let offset = 0
  for (const key of SNAPSHOT_FIELDS) { data.set(model[key], offset); offset += n }
  for (const key of SNAPSHOT_COLUMNS) { data.set(model[key], offset); offset += layer }
  const total = flashTotal(model), flashes = model.flashes.slice(Math.max(0, model.flashes.length - (total - sentFlashes)))
  sentFlashes = total
  const snapshot: Snapshot = { type: 'snapshot', buffer, steps: pendingSteps, flashes, flashCount: { ...model.flashCount }, chargeGround: model.chargeGround, added: { ...model.added }, time: model.time, rotation: { ...model.rotation }, diagnostics: model.diagnostics(), threads: pool ? pool.helpers + 1 : 1, gpu: gpuState, loaded,
    stepMs: timing.steps ? { step: timing.step / timing.steps, gpu: timing.gpu / timing.steps } : undefined }
  timing.step = timing.gpu = timing.steps = 0
  pendingSteps = 0; loaded = false
  scope.postMessage(snapshot, [buffer])
}

// Requests are handled one after another: a GPU step awaits the GPU, and nothing may change the model in between.
let queue: Promise<void> = Promise.resolve()
scope.addEventListener('message', ({ data }) => { queue = queue.then(() => handle(data)).catch(e => console.error(e)) })

async function handle(data: WorkerRequest) {
  switch (data.type) {
    case 'init': {
      accumulator = 0; if (data.lang) setLang(data.lang); if (data.gpu) gpuMode = data.gpu
      ceiling = threadCount(data.threads)
      start(data.config, data.tuned ? Math.min(data.tuned, ceiling) : ceiling)
      // A trial only without a remembered count and with threads to choose from: the most, then two thirds, a half, a third, one.
      const counts = [...new Set([ceiling, Math.round(ceiling * 2 / 3), Math.round(ceiling / 2), Math.round(ceiling / 3), 1])].filter(n => n >= 1 && n < ceiling)
      tune = !data.tuned && ceiling > 1 ? { left: counts, done: [], current: ceiling, steps: 0, ms: 0 } : null
      break
    }
    case 'config': if (model) Object.assign(model.config, data.config); break
    case 'threads': {
      if (!model) break
      ceiling = threadCount()
      if (data.count === 'auto') {
        const counts = [...new Set([ceiling, Math.round(ceiling * 2 / 3), Math.round(ceiling / 2), Math.round(ceiling / 3), 1])].filter(n => n >= 1 && n < ceiling)
        tune = ceiling > 1 ? { left: counts, done: [], current: ceiling, steps: 0, ms: 0 } : null
        if (ceiling !== current) switchThreads(ceiling)
      } else { tune = null; const n = threadCount(data.count); if (n !== current) switchThreads(n) }
      break
    }
    case 'gpu': gpuMode = data.mode; startGpu(); send(); break
    case 'intervene': if (model) intervene(model, data.intervention); break
    case 'release': free.push(data.buffer); break
    case 'load': if (model) { applyState(model, readState(data.buffer)); sentFlashes = flashTotal(model); loaded = true; startGpu(); send() } break
    case 'advance': {
      if (!model || !ready) break
      accumulator = Math.min(accumulator + data.seconds * model.config.speed, MAX_STEPS_PER_BATCH * DT)
      let steps = 0
      const start = performance.now()
      while (accumulator >= DT && steps < MAX_STEPS_PER_BATCH && performance.now() - start < BATCH_BUDGET_MS) {
        const t0 = performance.now(); await stepModel(model); accumulator -= DT; steps++
        timing.step += performance.now() - t0; timing.steps++
        if (tune) { tuneStep(performance.now() - t0); if (!ready) break }
      }
      // Time the budget cut off is dropped (the model falls behind the speed setting instead of catching up in a burst).
      if (steps > 0 && accumulator >= DT) accumulator = 0
      pendingSteps += steps
      // Always answer: the main thread sends the next request only after this snapshot.
      send()
      break
    }
    case 'steps': {
      if (!model) break
      for (let k = 0; k < data.count; k++) await stepModel(model)
      pendingSteps += data.count; accumulator = 0
      send()
      break
    }
  }
}
