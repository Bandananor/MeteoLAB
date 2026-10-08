// A helper thread of the physics worker: a view of the model over the shared memory, doing the tasks of each step it is
// given (see src/core/threads.ts) until the physics worker stops the pool.
import { AtmosphereModel, AttachedMemory, createGrid, type GridOptions, serveTasks, type SimConfig } from './core'

export interface HelperStart { config: SimConfig; grid: GridOptions; buffers: Record<string, SharedArrayBuffer>; control: SharedArrayBuffer }

self.addEventListener('message', ({ data }: MessageEvent<HelperStart>) => {
  const model = new AtmosphereModel(data.config, createGrid(data.grid), undefined, { memory: new AttachedMemory(data.buffers), attach: true })
  // The physics worker waits for this before its first step: it must not block in Atomics.wait while helpers still load.
  self.postMessage('ready')
  serveTasks(model, data.control)
  self.close()
}, { once: true })
