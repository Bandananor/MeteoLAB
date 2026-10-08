// Runs the physics off the main thread. The main thread sends real elapsed time, config changes and thermals; the worker
// answers each batch of steps with a snapshot of the fields the view draws (see Atmosphere), in recycled buffers.
// With cross-origin isolation the steps are shared with helper threads (step.worker.ts, src/core/threads.ts).
import { AtmosphereModel, controlBuffer, createGrid, domainGrid, DT, type SimConfig, SharedMemory, ThreadRunner, TRANSPORT_SLABS } from './core'
import { BATCH_BUDGET_MS, MAX_STEPS_PER_BATCH, MAX_THREADS, SNAPSHOT_COLUMNS, SNAPSHOT_FIELDS, type Snapshot, type WorkerRequest } from './simulation'
import type { HelperStart } from './step.worker'

const scope = self as unknown as {
  crossOriginIsolated?: boolean
  postMessage(message: unknown, transfer: Transferable[]): void; addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void
}
let model: AtmosphereModel | null = null, accumulator = 0, pendingSteps = 0
// Snapshot buffers come back from the main thread after it has copied them; at most two exist (one drawn, one in flight).
const free: ArrayBuffer[] = []
let buffers = 0
/** The helper threads of the current model; the model steps only once all of them have attached. */
let pool: ThreadRunner | null = null, ready = true, generation = 0

/** Threads for the physics: this worker plus helpers, leaving one core for the page. One without shared memory. */
function threadCount(limit = MAX_THREADS) {
  if (!scope.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') return 1
  return Math.max(1, Math.min(limit, MAX_THREADS, (navigator.hardwareConcurrency || 1) - 1))
}

function start(config: SimConfig, limit?: number) {
  pool?.stop(); pool = null
  const threads = threadCount(limit), id = ++generation
  if (threads === 1) { model = new AtmosphereModel(config); ready = true; send(); return }
  const memory = new SharedMemory(), grid = domainGrid(config.domain), control = controlBuffer()
  model = new AtmosphereModel(config, createGrid(grid), undefined, { memory })
  const runner = new ThreadRunner(model, control, threads - 1), started: Promise<unknown>[] = []
  for (let k = 0; k < threads - 1; k++) {
    const helper = new Worker(new URL('./step.worker.ts', import.meta.url), { type: 'module' })
    started.push(new Promise(resolve => helper.addEventListener('message', resolve, { once: true })))
    helper.postMessage({ config: { ...config }, grid, buffers: memory.buffers, control } satisfies HelperStart)
  }
  model.runner = pool = runner; model.transportSlabs = TRANSPORT_SLABS; ready = false
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
  const snapshot: Snapshot = { type: 'snapshot', buffer, steps: pendingSteps, time: model.time, rotation: { ...model.rotation }, diagnostics: model.diagnostics(), threads: pool ? pool.helpers + 1 : 1 }
  pendingSteps = 0
  scope.postMessage(snapshot, [buffer])
}

scope.addEventListener('message', ({ data }) => {
  switch (data.type) {
    case 'init': accumulator = 0; start(data.config, data.threads); break
    case 'config': if (model) Object.assign(model.config, data.config); break
    case 'perturb': model?.injectBubble(data.x, data.y, data.strength); break
    case 'release': free.push(data.buffer); break
    case 'advance': {
      if (!model || !ready) break
      accumulator = Math.min(accumulator + data.seconds * model.config.speed, MAX_STEPS_PER_BATCH * DT)
      let steps = 0
      const start = performance.now()
      while (accumulator >= DT && steps < MAX_STEPS_PER_BATCH && performance.now() - start < BATCH_BUDGET_MS) { model.step(DT); model.time += DT; accumulator -= DT; steps++ }
      // Time the budget cut off is dropped (the model falls behind the speed setting instead of catching up in a burst).
      if (steps > 0 && accumulator >= DT) accumulator = 0
      pendingSteps += steps
      // Always answer: the main thread sends the next request only after this snapshot.
      send()
      break
    }
  }
})
