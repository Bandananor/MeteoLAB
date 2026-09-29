// Runs the physics off the main thread. The main thread sends real elapsed time, config changes and thermals; the worker
// answers each batch of steps with a snapshot of the fields the view draws (see Atmosphere), in recycled buffers.
import { AtmosphereModel, DT } from './core'
import { BATCH_BUDGET_MS, MAX_STEPS_PER_BATCH, SNAPSHOT_COLUMNS, SNAPSHOT_FIELDS, type Snapshot, type WorkerRequest } from './simulation'

const scope = self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void; addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void }
let model: AtmosphereModel | null = null, accumulator = 0, pendingSteps = 0
// Snapshot buffers come back from the main thread after it has copied them; at most two exist (one drawn, one in flight).
const free: ArrayBuffer[] = []
let buffers = 0

function send() {
  if (!model) return
  const { n, layer } = model.grid, size = (SNAPSHOT_FIELDS.length * n + SNAPSHOT_COLUMNS.length * layer) * 4
  const buffer = free.pop() ?? (buffers < 2 ? (buffers++, new ArrayBuffer(size)) : null)
  if (!buffer) return // the main thread still holds both; the steps go out with the next snapshot
  const data = new Float32Array(buffer)
  let offset = 0
  for (const key of SNAPSHOT_FIELDS) { data.set(model[key], offset); offset += n }
  for (const key of SNAPSHOT_COLUMNS) { data.set(model[key], offset); offset += layer }
  const snapshot: Snapshot = { type: 'snapshot', buffer, steps: pendingSteps, time: model.time, microburstOutflow: model.microburstOutflow, rotation: { ...model.rotation }, diagnostics: model.diagnostics() }
  pendingSteps = 0
  scope.postMessage(snapshot, [buffer])
}

scope.addEventListener('message', ({ data }) => {
  switch (data.type) {
    case 'init': model = new AtmosphereModel(data.config); accumulator = 0; send(); break
    case 'config': if (model) Object.assign(model.config, data.config); break
    case 'perturb': model?.injectBubble(data.x, data.y, data.strength); break
    case 'release': free.push(data.buffer); break
    case 'advance': {
      if (!model) break
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
