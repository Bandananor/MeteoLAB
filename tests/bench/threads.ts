// @ts-nocheck
// Speed of threaded steps in Node (worker_threads), and a check that every thread count gives the same model:
//   npm run bench -- [threads] [large] [warm=900] [steps=60] [s=<scenario index>]
// prints ms per step, the time of each phase and a fingerprint of the fields (equal for any thread count).
import { isMainThread, Worker, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'
import { AtmosphereModel, createGrid, DEFAULT_GRID, DT, LARGE_GRID, SCENARIOS, type SimConfig } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'
import { AttachedMemory, controlBuffer, serveTasks, SharedMemory, ThreadRunner } from '../../src/core/threads'

const fingerprint = (model: AtmosphereModel) => (['u', 'v', 'w', 'theta', 'q', 'cloud', 'rain', 'cold', 'ice', 'snow', 'graupel', 'hail', 'precipitation', 'hailGround', 'pressure'] as const).map(k => {
  const a = model[k] as Float32Array, b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let h = 0x811c9dc5
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0 }
  return `${k}:${h.toString(16)}`
}).join(' ')

if (!isMainThread) {
  const { config, grid, buffers, control } = workerData
  const model = new AtmosphereModel(config, createGrid(grid), undefined, { memory: new AttachedMemory(buffers), attach: true })
  serveTasks(model, control)
} else {
  const args = process.argv.slice(2), large = args.includes('large'), threads = Number(args.find(a => /^\d+$/.test(a)) ?? availableParallelism())
  const steps = Number(args.find(a => a.startsWith('steps='))?.slice(6) ?? 300), warm = Number(args.find(a => a.startsWith('warm='))?.slice(5) ?? 0)
  const scenario = Number(args.find(a => a.startsWith('s='))?.slice(2) ?? 7)
  const config: SimConfig = { ...SUMMER_DAY, ...SCENARIOS[scenario].values }, gridOptions = large ? LARGE_GRID : DEFAULT_GRID
  const memory = new SharedMemory(), model = new AtmosphereModel({ ...config }, createGrid(gridOptions), undefined, { memory })
  const control = controlBuffer(), helpers: Worker[] = []
  for (let k = 0; k < threads - 1; k++) helpers.push(new Worker(fileURLToPath(import.meta.url), { workerData: { config: { ...config }, grid: gridOptions, buffers: memory.buffers, control } }))
  const runner = new ThreadRunner(model, control, threads - 1)
  if (threads > 1 || args.includes('slabs')) model.transportSlabs = 10
  const base = threads > 1 ? runner : model.runner, phase: Record<string, number> = {}
  model.runner = { run: (ph, n, dt) => { const s = performance.now(); base.run(ph, n, dt); phase[ph] = (phase[ph] ?? 0) + performance.now() - s } }
  const taskTime: Record<string, number> = {}, orig = model.runTask.bind(model)
  if (threads === 1) model.runTask = (ph, k, dt) => { const s = performance.now(); orig(ph, k, dt); const key = ph + k; taskTime[key] = (taskTime[key] ?? 0) + performance.now() - s }
  let t0 = performance.now(), times: number[] = []
  for (let k = 0; k < warm + steps; k++) {
    const s = performance.now(); model.step(DT); model.time += DT
    if (k >= warm) times.push(performance.now() - s)
    if (k === warm - 1) { t0 = performance.now(); for (const key in phase) delete phase[key]; for (const key in taskTime) delete taskTime[key] }
  }
  const total = performance.now() - t0
  times.sort((a, b) => a - b)
  console.log(`${large ? 'large' : 'standard'} threads ${threads}: ${(total / steps).toFixed(1)} ms/step (median ${times[times.length >> 1].toFixed(1)}) over ${steps} steps after ${warm}`)
  console.log('phases ms/step', Object.entries(phase).map(([k, v]) => `${k} ${(v / steps).toFixed(1)}`).join(', '))
  if (threads === 1) console.log('tasks ms/step', Object.entries(taskTime).filter(([k]) => !k.startsWith('physics')).map(([k, v]) => `${k} ${(v / steps).toFixed(1)}`).join(', '))
  console.log(`negFilled ${model.negativeFilled} clipped ${model.clipped}`)
  console.log(fingerprint(model))
  runner.stop()
  for (const h of helpers) await h.terminate()
}
