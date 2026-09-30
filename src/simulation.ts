// Message protocol between the main thread (Atmosphere) and the physics worker (simulation.worker.ts).
import type { ModelDiagnostics, RotationState, SimConfig } from './core'

/** Grid-sized fields copied into every snapshot, then the column fields; the order is the buffer layout. */
export const SNAPSHOT_FIELDS = ['u', 'v', 'w', 'theta', 'q', 'cloud', 'rain', 'cold', 'fallSpeed', 'ice', 'snow', 'graupel'] as const
export const SNAPSHOT_COLUMNS = ['uhColumn', 'precipitation'] as const
/** Most model steps run for one batch; time beyond that is dropped instead of piling up after slow frames. */
export const MAX_STEPS_PER_BATCH = 12
/**
 * A batch also stops once it has computed this long (ms), so a snapshot goes out ~15 times a second even when a step
 * is slow: the model then runs slower than the speed setting instead of freezing between large jumps.
 */
export const BATCH_BUDGET_MS = 60

export type WorkerRequest =
  | { type: 'init'; config: SimConfig }
  | { type: 'advance'; seconds: number }
  | { type: 'config'; config: SimConfig }
  | { type: 'perturb'; x: number; y: number; strength: number }
  | { type: 'release'; buffer: ArrayBuffer }

export interface Snapshot {
  type: 'snapshot'; buffer: ArrayBuffer; steps: number; time: number; microburstOutflow: number
  rotation: RotationState; diagnostics: ModelDiagnostics
}
