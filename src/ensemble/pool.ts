/**
 * Runs many configurations off the main thread (src/ensemble/ensemble.worker.ts), one per core, several at once: the
 * ensemble's members and the regime map's grid (src/regime/). Each result comes back with its configuration's index.
 */
import type { SimConfig } from '../core'
import type { MemberResult } from './member'
import type { EnsembleReply, EnsembleRequest } from './ensemble.worker'

export interface PoolEvents {
  /** The model time of every run going on (by its index), after each of its samples. */
  progress(times: ReadonlyMap<number, number>): void
  done(index: number, result: MemberResult): void
  error(message: string): void
  /** All the runs have ended. */
  finish(): void
}

/** How many runs go at once for `total`: a core left for the page, at most 8. */
export const poolSize = (total: number) => Math.max(1, Math.min(total, (navigator.hardwareConcurrency || 2) - 1, 8))

/** Starts the runs; the returned function stops those still going (the finished ones stay reported). */
export function runPool(configs: readonly SimConfig[], minutes: number, on: PoolEvents) {
  const times = new Map<number, number>(), workers: Worker[] = []
  let next = 0, stopped = false
  const feed = (w: Worker) => {
    if (next >= configs.length) {
      w.terminate(); workers.splice(workers.indexOf(w), 1)
      if (!workers.length) on.finish()
      return
    }
    const index = next++
    times.set(index, 0)
    w.onmessage = ({ data }: MessageEvent<EnsembleReply>) => {
      if (stopped) return
      if (data.type === 'progress') { times.set(index, data.time); on.progress(times) }
      else if (data.type === 'done') { times.delete(index); on.done(index, data.result); feed(w) }
      else { stop(); on.error(data.message) }
    }
    w.postMessage({ type: 'run', config: configs[index], minutes } satisfies EnsembleRequest)
  }
  const stop = () => { stopped = true; for (const w of workers) w.terminate(); workers.length = 0 }
  for (let k = 0; k < poolSize(configs.length); k++) {
    const w = new Worker(new URL('./ensemble.worker.ts', import.meta.url), { type: 'module' })
    workers.push(w); feed(w)
  }
  return stop
}
