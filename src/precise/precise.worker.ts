// A precise run in the browser (roadmap C2 step 4): one run on a fine grid in this worker, its step shared with helper
// threads (step.worker.ts) as the live worker does, light frames (src/core/frames.ts) written as they come to a file in
// the origin's private file system (OPFS) — or kept in memory where it has no synchronous access — and the state at the
// end handed back for a .meteolab file. The page plays the frames back through Atmosphere.startReplay.
import { AtmosphereModel, controlBuffer, createGrid, domainGrid, DT, encodeFrame, framesHeader, saveState, SharedMemory, type SimConfig, ThreadRunner, TRANSPORT_SLABS } from '../core'
import type { HelperStart } from '../step.worker'
import { setLang } from '../i18n'

export type PreciseRequest =
  | { type: 'start'; config: SimConfig; minutes: number; every: number; threads: number; lang?: 'ru' | 'en' }
  | { type: 'pause' } | { type: 'resume' } | { type: 'stop' }
export type PreciseReply =
  | { type: 'started'; threads: number; stored: boolean }
  | { type: 'progress'; time: number; msPerStep: number; updraft: number; bytes: number; frames: number }
  | { type: 'done'; time: number; stopped: boolean; frames: Blob | null; state: ArrayBuffer }
  | { type: 'error'; message: string }

/** The folder and file of the run in the origin's private file system (one run kept: the next replaces it). */
export const PRECISE_DIR = 'precise', PRECISE_FILE = 'last.mlframes'
/** Milliseconds between progress messages. */
const PROGRESS_EVERY = 1000

const scope = self as unknown as { postMessage(message: PreciseReply, transfer?: Transferable[]): void; addEventListener(type: 'message', listener: (event: MessageEvent<PreciseRequest>) => void): void }
let paused = false, stopped = false, wake: (() => void) | null = null

/** The frames' sink: a synchronous OPFS handle (dedicated workers), else memory. */
interface Sink { append(bytes: Uint8Array): void; size: number; stored: boolean; close(): Promise<Blob | null> }
async function openSink(): Promise<Sink> {
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(PRECISE_DIR, { create: true })
    const handle = await dir.getFileHandle(PRECISE_FILE, { create: true }) as FileSystemFileHandle & { createSyncAccessHandle(): Promise<{ write(b: Uint8Array, o: { at: number }): number; truncate(n: number): void; flush(): void; close(): void }> }
    const access = await handle.createSyncAccessHandle()
    access.truncate(0)
    const sink: Sink = {
      size: 0, stored: true,
      append(bytes) { access.write(bytes, { at: sink.size }); sink.size += bytes.byteLength },
      async close() { access.flush(); access.close(); return null },
    }
    return sink
  } catch {
    const parts: Uint8Array<ArrayBuffer>[] = []
    const sink: Sink = { size: 0, stored: false, append(bytes) { parts.push(bytes.slice()); sink.size += bytes.byteLength }, async close() { return new Blob(parts) } }
    return sink
  }
}

/** Lets the messages in between steps without a timer (timers of hidden pages may be throttled). */
const yieldNow = () => new Promise<void>(resolve => { const c = new MessageChannel(); c.port1.onmessage = () => resolve(); c.port2.postMessage(0) })

async function run(config: SimConfig, minutes: number, every: number, threads: number) {
  const grid = domainGrid(config.domain, config.top, config.domainSize, config.spacing)
  let model: AtmosphereModel, runner: ThreadRunner | null = null
  if (threads > 1) {
    const memory = new SharedMemory(), control = controlBuffer(), started: Promise<unknown>[] = []
    model = new AtmosphereModel(config, createGrid(grid), undefined, { memory })
    runner = new ThreadRunner(model, control, threads - 1)
    for (let k = 0; k < threads - 1; k++) {
      const helper = new Worker(new URL('../step.worker.ts', import.meta.url), { type: 'module' })
      started.push(new Promise(resolve => helper.addEventListener('message', resolve, { once: true })))
      helper.postMessage({ config: { ...config }, grid, buffers: memory.buffers, control } satisfies HelperStart)
    }
    await Promise.all(started)
    model.runner = runner; model.transportSlabs = TRANSPORT_SLABS
  } else model = new AtmosphereModel(config, createGrid(grid))
  const sink = await openSink()
  scope.postMessage({ type: 'started', threads, stored: sink.stored })
  sink.append(framesHeader(config, model.grid, every)); sink.append(await encodeFrame(model))
  let frames = 1, last = 0, from = performance.now(), steps = 0
  const end = minutes * 60
  while (model.time < end - 1e-6 && !stopped) {
    if (paused) { await new Promise<void>(resolve => { wake = resolve }); from = performance.now(); steps = 0; continue }
    model.step(DT); model.time += DT; steps++
    const t = Math.round(model.time)
    if (t % every === 0) { sink.append(await encodeFrame(model)); frames++ }
    const now = performance.now()
    if (now - last > PROGRESS_EVERY) { last = now; scope.postMessage({ type: 'progress', time: model.time, msPerStep: (now - from) / steps, updraft: model.diagnostics().updraft, bytes: sink.size, frames }) }
    await yieldNow()
  }
  const blob = await sink.close(), state = saveState(model, config)
  runner?.stop()
  scope.postMessage({ type: 'done', time: model.time, stopped, frames: blob, state }, [state])
}

scope.addEventListener('message', ({ data }) => {
  switch (data.type) {
    case 'start':
      if (data.lang) setLang(data.lang)
      run(data.config, data.minutes, data.every, data.threads).catch(error => scope.postMessage({ type: 'error', message: (error as Error).message }))
      break
    case 'pause': paused = true; break
    case 'resume': paused = false; wake?.(); wake = null; break
    case 'stop': stopped = true; paused = false; wake?.(); wake = null; break
  }
})
