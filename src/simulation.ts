import type { Lang } from './i18n'
// Message protocol between the main thread (Atmosphere) and the physics worker (simulation.worker.ts).
import type { Flash, ModelDiagnostics, RotationState, SimConfig } from './core'

/** Grid-sized fields copied into every snapshot, then the column fields; the order is the buffer layout. */
export const SNAPSHOT_FIELDS = ['u', 'v', 'w', 'theta', 'q', 'cloud', 'rain', 'cold', 'fallSpeed', 'ice', 'iceNumber', 'snow', 'graupel', 'hail', 'chargeIce', 'chargeGraupel', 'chargeRain', 'chargeAir'] as const
export const SNAPSHOT_COLUMNS = ['uhColumn', 'precipitation', 'coreW', 'coreWZ', 'hailGround', 'hailSize'] as const
/** Most model steps run for one batch; time beyond that is dropped instead of piling up after slow frames. */
export const MAX_STEPS_PER_BATCH = 12
/**
 * A batch also stops once it has computed this long (ms), so a snapshot goes out ~15 times a second even when a step
 * is slow: the model then runs slower than the speed setting instead of freezing between large jumps.
 */
export const BATCH_BUDGET_MS = 60
/**
 * Most threads the physics uses (its worker plus helpers; one core is left for the page). Measured 2026-10-08 on a
 * 12-thread laptop (4 performance cores): beyond ~6 the step stops getting faster (memory bandwidth, efficiency cores).
 */
export const MAX_THREADS = 6

export type WorkerRequest =
  /** lang: the page's language (src/i18n.ts), for any text the worker makes. */
  /** threads: an upper limit for the physics threads (the page's ?threads= parameter, to compare speeds). */
  | { type: 'init'; config: SimConfig; threads?: number; lang?: Lang }
  | { type: 'advance'; seconds: number }
  /** Exactly this many model steps, however long they take (the video recording, src/record/recorder.ts). */
  | { type: 'steps'; count: number }
  | { type: 'config'; config: SimConfig }
  | { type: 'perturb'; x: number; y: number; strength: number }
  | { type: 'release'; buffer: ArrayBuffer }
  /** A saved state (src/core/state.ts) for the model just started with its settings. */
  | { type: 'load'; buffer: ArrayBuffer }

export interface Snapshot {
  type: 'snapshot'; buffer: ArrayBuffer; steps: number; time: number
  rotation: RotationState; diagnostics: ModelDiagnostics
  /** The flashes since the previous snapshot, the counts since the start and the charge carried to the ground, C. */
  flashes: Flash[]; flashCount: { ic: number; cg: number }; chargeGround: number
  /** Threads the physics runs on (1 without cross-origin isolation). */
  threads: number
  /** The first snapshot after a 'load' request: the ones still on their way from before it are stale. */
  loaded?: boolean
}
