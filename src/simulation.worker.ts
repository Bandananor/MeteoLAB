// Runs the physics off the main thread. The main thread sends real elapsed time, config changes and thermals; the worker
// answers each batch of steps with a snapshot of the fields the view draws (see Atmosphere), in recycled buffers.
// With cross-origin isolation the steps are shared with helper threads (step.worker.ts, src/core/threads.ts).
import { AtmosphereModel, controlBuffer, createGrid, domainGrid, DT, type SimConfig, SharedMemory, ThreadRunner, TRANSPORT_SLABS, applyState, readState, intervene, saveState } from './core'
import type { GpuDynamics } from './gpu/dynamics'
import { gpuStep } from './gpu/step'
import { BATCH_BUDGET_MS, GPU_BETTER, type GpuMode, type GpuTuned, MAX_STEPS_PER_BATCH, maxThreads, SNAPSHOT_COLUMNS, SNAPSHOT_FIELDS, type Snapshot, type Tuned, TUNE_STEPS, TUNE_WARM, TUNE_WORSE, type WorkerRequest } from './simulation'
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
 * The GPU (Э3 steps 5-6, src/gpu/step.ts): the sedimentation, the transport with the pressure in its stages, the
 * turbulence, the friction and the final projection on WebGPU, the physics on the CPU threads; only where the model's
 * transport is the one the GPU does (model.gpuDynamics()). Setting 'on': wherever WebGPU exists; 'auto': as the GPU
 * trial decided (gpuChoice, GpuTuned in simulation.ts); 'off', no WebGPU or an error: the CPU as before.
 */
let gpuMode: GpuMode = 'auto', gpu: GpuDynamics | null = null, gpuState = 'off'
/** What the GPU trial chose for this grid ('auto'), null until it has. */
let gpuChoice: 'gpu' | 'cpu' | null = null
/** The GPU trial running: the half it is in, its steps and their time, the GPU half's mean step. */
let gpuTrial: { half: 'gpu' | 'cpu'; steps: number; ms: number; gpuMs: number } | null = null
/** A thread trial that waits for the GPU trial (the best thread count depends on whether the GPU takes the transport). */
let waitingTune: typeof tune = null

/** Whether the steps use the GPU now (when it is ready). */
function wantGpu() {
  if (gpuMode === 'on') return true
  if (gpuMode === 'off') return false
  return gpuTrial ? gpuTrial.half === 'gpu' : gpuChoice !== 'cpu'
}

/** Makes (or keeps, or frees) the GPU for the current model; the CPU steps until it is ready. */
function startGpu() {
  const m = model
  if (!m) return
  const wanted = gpuMode !== 'off' && !(gpuMode === 'auto' && !gpuTrial && gpuChoice === 'cpu')
  if (gpu && (!wanted || !gpu.matches(m.grid, m.env))) { gpu.destroy(); gpu = null }
  if (!wanted) { gpuState = gpuMode === 'off' ? 'off' : 'cpu-faster'; return }
  if (gpu) return
  if (!m.gpuDynamics()) { gpuState = 'cpu-transport'; endGpuTrial(); return }
  const nav = navigator as Navigator & { gpu?: GPU }
  if (!nav.gpu) { gpuState = 'unavailable'; endGpuTrial(); return }
  const id = generation
  gpuState = 'starting'
  void import('./gpu/dynamics').then(({ GpuDynamics }) => GpuDynamics.create(m.grid, m.env)).then(g => {
    if (id !== generation || model !== m || gpuMode === 'off') { g.destroy(); return }
    gpu = g; gpuState = g.adapter || 'WebGPU'
  }, e => { gpuState = `error: ${String((e as Error)?.message ?? e)}`; endGpuTrial() })
}

/** Stops the GPU trial without a choice (no GPU to try) and lets a waiting thread trial run. */
function endGpuTrial() {
  if (!gpuTrial) return
  gpuTrial = null
  if (waitingTune) { tune = waitingTune; waitingTune = null }
}

/** One step of the GPU trial: counted once the GPU is ready; after both halves the faster one is kept and the page told. */
function gpuTrialStep(ms: number) {
  const t = gpuTrial
  if (!t || !ready) return
  if (t.half === 'gpu' && !gpu) return // still starting (an unavailable or failed GPU ends the trial in startGpu)
  if (++t.steps <= TUNE_WARM) return
  t.ms += ms
  if (t.steps < TUNE_WARM + TUNE_STEPS) return
  if (t.half === 'gpu') { t.gpuMs = t.ms / TUNE_STEPS; t.half = 'cpu'; t.steps = 0; t.ms = 0; return }
  const cpuMs = t.ms / TUNE_STEPS
  gpuChoice = t.gpuMs <= cpuMs * GPU_BETTER ? 'gpu' : 'cpu'
  gpuTrial = null
  startGpu()
  scope.postMessage({ type: 'gpuTuned', choice: gpuChoice, gpuMs: t.gpuMs, cpuMs } satisfies GpuTuned, [])
  if (waitingTune) { tune = waitingTune; waitingTune = null }
}

/** Starts the GPU trial (setting 'auto' without a remembered choice); a thread trial set up now waits for it. */
function beginGpuTrial() {
  gpuChoice = null
  gpuTrial = { half: 'gpu', steps: 0, ms: 0, gpuMs: 0 }
  if (tune) { waitingTune = tune; tune = null }
}

/** Time of the steps since the last snapshot, ms: whole steps and the wait for the GPU's part, and their count. */
const timing = { step: 0, gpu: 0, steps: 0 }

/** One model step: on the GPU when it is ready, otherwise (or after a GPU error) all on the CPU. */
async function stepModel(m: AtmosphereModel) {
  const g = gpu
  if (!g || !wantGpu() || !m.gpuDynamics()) { m.step(DT); m.time += DT; return }
  const { waitMs, failed } = await gpuStep(m, g, DT)
  timing.gpu += waitMs
  // The GPU failed: the step was finished on the CPU, and the CPU goes on from now.
  if (failed !== null) { gpuState = `error: ${failed}`; gpu = null; g.destroy(); endGpuTrial() }
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
  const snapshot: Snapshot = { type: 'snapshot', buffer, steps: pendingSteps, flashes, flashCount: { ...model.flashCount }, chargeGround: model.chargeGround, added: { ...model.added }, water: { ...model.water }, time: model.time, rotation: { ...model.rotation }, diagnostics: model.diagnostics(), threads: pool ? pool.helpers + 1 : 1, gpu: gpuState, loaded,
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
      gpuChoice = data.gpuTuned ?? null; gpuTrial = null; waitingTune = null
      ceiling = threadCount(data.threads)
      // A trial only without a remembered count and with threads to choose from: the most, then two thirds, a half, a third, one.
      const counts = [...new Set([ceiling, Math.round(ceiling * 2 / 3), Math.round(ceiling / 2), Math.round(ceiling / 3), 1])].filter(n => n >= 1 && n < ceiling)
      tune = !data.tuned && ceiling > 1 ? { left: counts, done: [], current: ceiling, steps: 0, ms: 0 } : null
      // The GPU trial first, at the most threads (setting 'auto', nothing remembered); the thread trial after it.
      if (gpuMode === 'auto' && !gpuChoice) beginGpuTrial()
      start(data.config, data.tuned && !gpuTrial ? Math.min(data.tuned, ceiling) : ceiling)
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
    case 'gpu': {
      gpuMode = data.mode
      if (gpuMode === 'auto') beginGpuTrial(); else endGpuTrial()
      startGpu(); send()
      break
    }
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
        if (gpuTrial) gpuTrialStep(performance.now() - t0)
        else if (tune) { tuneStep(performance.now() - t0); if (!ready) break }
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
