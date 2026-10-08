// Multi-threaded steps (2026-10-08): the model's fields live in SharedArrayBuffers, helper threads (Web Workers) each
// hold a view of the same model over that memory, and the independent parts of a step — the transport of each field,
// the microphysics of each level, the subgrid mixing of each field — are handed out as tasks. A task writes only its
// own field or level, so the result is bit-for-bit the same as one thread doing the tasks in order.

/** Where the model allocates the arrays that helper threads must see. */
export interface Memory {
  f32(name: string, length: number): Float32Array
  f64(name: string, length: number): Float64Array
}

/** Ordinary (unshared) arrays: one thread. */
export const PRIVATE_MEMORY: Memory = { f32: (_, length) => new Float32Array(length), f64: (_, length) => new Float64Array(length) }

/** Allocates every array on its own SharedArrayBuffer and remembers it by name, to hand the buffers to helpers. */
export class SharedMemory implements Memory {
  readonly buffers: Record<string, SharedArrayBuffer> = {}
  f32(name: string, length: number) { return new Float32Array(this.buffer(name, length * 4)) }
  f64(name: string, length: number) { return new Float64Array(this.buffer(name, length * 8)) }
  private buffer(name: string, bytes: number) {
    if (this.buffers[name]) throw new Error(`shared array ${name} allocated twice`)
    return this.buffers[name] = new SharedArrayBuffer(bytes)
  }
}

/** A helper's view of the main thread's SharedMemory. */
export class AttachedMemory implements Memory {
  private readonly buffers: Record<string, SharedArrayBuffer>
  constructor(buffers: Record<string, SharedArrayBuffer>) { this.buffers = buffers }
  f32(name: string, length: number) { return new Float32Array(this.buffer(name, length * 4)) }
  f64(name: string, length: number) { return new Float64Array(this.buffer(name, length * 8)) }
  private buffer(name: string, bytes: number) {
    const b = this.buffers[name]
    if (!b || b.byteLength !== bytes) throw new Error(`shared array ${name} missing or of another size`)
    return b
  }
}

/**
 * The parallel parts of a step: fall speeds per level; the transport, per field and slab of levels, as the tendency and
 * the update of each Runge-Kutta stage and a final positivity fix per field; physics per level; eddy viscosity per
 * level; subgrid mixing per field.
 */
export const PHASES = ['fall', 'faces', 'faceDivergence', 'faceForward', 'faceModes', 'faceInverse', 'faceCorrect',
  'tendency0', 'update0', 'tendency1', 'update1', 'tendency2', 'update2', 'finish', 'physics', 'viscosity', 'mix',
  'pressureDivergence', 'pressureForward', 'pressureModes', 'pressureInverse', 'pressureCorrect'] as const
export type Phase = typeof PHASES[number]

/** Runs `tasks` tasks of one phase; the model does task k with runTask(phase, k, dt). */
export interface StepRunner { run(phase: Phase, tasks: number, dt: number): void }

/** What a thread needs to do tasks: the model (or its view in a helper). */
export interface TaskModel {
  time: number
  runTask(phase: Phase, k: number, dt: number): void
  /** Settings that can change during a run (the config and the model's switches), as JSON, and applying them. */
  settings(): string
  applySettings(json: string): void
}

// Control block (Int32 slots): generation (bumped to start a phase), phase index, task count, next task, helpers done,
// settings version, settings byte length, helpers ready; then dt and model time as float64, then the settings JSON.
const GEN = 0, PHASE = 1, COUNT = 2, NEXT = 3, DONE = 4, VERSION = 5, LENGTH = 6, READY = 7, STOP = -1
const INTS = 8, SETTINGS_BYTES = 16384

/** The shared control block of a pool. */
export function controlBuffer() { return new SharedArrayBuffer(INTS * 4 + 16 + SETTINGS_BYTES) }

const views = (control: SharedArrayBuffer) => ({
  ctl: new Int32Array(control, 0, INTS), times: new Float64Array(control, INTS * 4, 2), text: new Uint8Array(control, INTS * 4 + 16, SETTINGS_BYTES),
})

/** Claims and runs tasks of the current phase until none is left. */
function work(model: TaskModel, ctl: Int32Array, phase: Phase, count: number, dt: number) {
  for (let k = Atomics.add(ctl, NEXT, 1); k < count; k = Atomics.add(ctl, NEXT, 1)) model.runTask(phase, k, dt)
}

/**
 * The main thread's side: starts a phase, does tasks itself and waits until every helper has finished. Must run on a
 * thread that may block (a worker, or Node), as Atomics.wait does.
 */
export class ThreadRunner implements StepRunner {
  private readonly ctl: Int32Array; private readonly times: Float64Array; private readonly text: Uint8Array
  private readonly model: TaskModel
  readonly helpers: number
  private sent = ''

  constructor(model: TaskModel, control: SharedArrayBuffer, helpers: number) {
    this.model = model; this.helpers = helpers
    ;({ ctl: this.ctl, times: this.times, text: this.text } = views(control))
  }

  run(phase: Phase, tasks: number, dt: number) {
    const ctl = this.ctl, settings = this.model.settings()
    // A helper that has not entered its loop yet would miss this phase: wait until all of them are listening.
    for (let ready = Atomics.load(ctl, READY); ready < this.helpers; ready = Atomics.load(ctl, READY)) Atomics.wait(ctl, READY, ready)
    if (settings !== this.sent) {
      const bytes = new TextEncoder().encode(settings)
      if (bytes.length > SETTINGS_BYTES) throw new Error('settings too long for the control block')
      this.text.set(bytes); ctl[LENGTH] = bytes.length; Atomics.add(ctl, VERSION, 1); this.sent = settings
    }
    this.times[0] = dt; this.times[1] = this.model.time
    ctl[PHASE] = PHASES.indexOf(phase); ctl[COUNT] = tasks; Atomics.store(ctl, NEXT, 0); Atomics.store(ctl, DONE, 0)
    Atomics.add(ctl, GEN, 1); Atomics.notify(ctl, GEN)
    work(this.model, ctl, phase, tasks, dt)
    for (let done = Atomics.load(ctl, DONE); done < this.helpers; done = Atomics.load(ctl, DONE)) Atomics.wait(ctl, DONE, done)
  }

  /** Lets the helpers leave their loop (they finish the phase they are in first). */
  stop() { this.ctl[PHASE] = STOP; Atomics.add(this.ctl, GEN, 1); Atomics.notify(this.ctl, GEN) }
}

/** A helper thread's loop: waits for a phase, does tasks, reports done; returns when the pool stops. */
export function serveTasks(model: TaskModel, control: SharedArrayBuffer) {
  const { ctl, times, text } = views(control)
  let seen = Atomics.load(ctl, GEN), version = -1
  Atomics.add(ctl, READY, 1); Atomics.notify(ctl, READY)
  for (;;) {
    Atomics.wait(ctl, GEN, seen)
    seen = Atomics.load(ctl, GEN)
    const index = ctl[PHASE]
    if (index === STOP) return
    if (ctl[VERSION] !== version) { version = ctl[VERSION]; model.applySettings(new TextDecoder().decode(text.slice(0, ctl[LENGTH]))) }
    model.time = times[1]
    work(model, ctl, PHASES[index], ctl[COUNT], times[0])
    Atomics.add(ctl, DONE, 1); Atomics.notify(ctl, DONE)
  }
}
