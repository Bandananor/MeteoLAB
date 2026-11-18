import type { Lang } from './i18n'
// Message protocol between the main thread (Atmosphere) and the physics worker (simulation.worker.ts).
import type { AtmosphereModel, Flash, Intervention, ModelDiagnostics, RotationState, SimConfig } from './core'

/** Grid-sized fields copied into every snapshot, then the column fields; the order is the buffer layout. */
export const SNAPSHOT_FIELDS = ['u', 'v', 'w', 'theta', 'q', 'cloud', 'rain', 'rainNumber', 'graupelNumber', 'graupelVolume', 'hailNumber', 'hailVolume', 'cold', 'fallSpeed', 'ice', 'iceNumber', 'snow', 'graupel', 'hail', 'chargeIce', 'chargeGraupel', 'chargeRain', 'chargeAir'] as const
export const SNAPSHOT_COLUMNS = ['uhColumn', 'precipitation', 'coreW', 'coreWZ', 'hailGround', 'hailSize'] as const
/** Most model steps run for one batch; time beyond that is dropped instead of piling up after slow frames. */
export const MAX_STEPS_PER_BATCH = 12
/**
 * A batch also stops once it has computed this long (ms), so a snapshot goes out ~15 times a second even when a step
 * is slow: the model then runs slower than the speed setting instead of freezing between large jumps.
 */
export const BATCH_BUDGET_MS = 60
/**
 * Most threads the physics may use: every core but one (left for the page). Until 16.11.2026 also at most 6 (measured
 * 2026-10-08: beyond ~6 the step hardly got faster on the author's laptop); now the trial or the user decides.
 */
export const maxThreads = () => Math.max(1, (globalThis.navigator?.hardwareConcurrency || 1) - 1)

/**
 * The GPU setting: 'auto' — a timed trial at the start (GpuTuned) keeps the GPU only where it is faster than the CPU
 * threads; 'on' — the GPU wherever WebGPU exists; 'off' — never.
 */
export type GpuMode = 'auto' | 'on' | 'off'

export type WorkerRequest =
  /** lang: the page's language (src/i18n.ts), for any text the worker makes. */
  /** threads: an upper limit for the physics threads (the page's ?threads= parameter, to compare speeds). */
  /** tuned: the thread count this browser found fastest for this grid before (no trial then); see ThreadTuning. */
  /** gpu: the GPU setting; gpuTuned: what the GPU trial chose here before for this grid (no trial then). */
  | { type: 'init'; config: SimConfig; threads?: number; tuned?: number; lang?: Lang; gpu?: GpuMode; gpuTuned?: 'gpu' | 'cpu' }
  | { type: 'gpu'; mode: GpuMode }
  | { type: 'advance'; seconds: number }
  /** The thread count chosen in the settings: a number (within maxThreads), or 'auto' — the trial again. */
  | { type: 'threads'; count: number | 'auto' }
  /** Exactly this many model steps, however long they take (the video recording, src/record/recorder.ts). */
  | { type: 'steps'; count: number }
  | { type: 'config'; config: SimConfig }
  | { type: 'intervene'; intervention: Intervention }
  | { type: 'release'; buffer: ArrayBuffer }
  /** A saved state (src/core/state.ts) for the model just started with its settings. */
  | { type: 'load'; buffer: ArrayBuffer }

/**
 * Self-tuning thread count (16.11.2026): with no count remembered for this device and grid, the worker runs a short
 * trial at the start — the most threads it may use, then fewer, TUNE_WARM steps to settle after each switch and
 * TUNE_STEPS timed — stops going down once a count is TUNE_WORSE slower than the best, and keeps the fastest; the model
 * state moves with each switch, so the run goes on. The result is sent as 'tuned' and remembered by the page.
 * On the author's 12-thread laptop the step kept getting faster up to 8 threads (standard domain 161 / 103 / 79 / 69 /
 * 63 / 60 ms at 1 / 2 / 3 / 4 / 6 / 8, tests/bench/threads.ts); on other machines fewer can be faster.
 */
export const TUNE_WARM = 15, TUNE_STEPS = 40, TUNE_WORSE = 1.08
export interface Tuned { type: 'tuned'; threads: number; trial: { threads: number; ms: number }[] }

/**
 * The GPU trial (setting 'auto', 16.11.2026): before the thread trial, TUNE_WARM + TUNE_STEPS steps with the GPU and as
 * many on the CPU threads alone; the GPU is kept only when its steps are GPU_BETTER of the CPU's or faster (it shares
 * the card with the 3D view and draws power, so a tie goes to the CPU). Sent as 'gpuTuned', remembered by the page.
 * On the author's laptop (RTX 3050, 12 threads) the GPU wins on the large domain (115-190 vs 240 ms a step) and ties on
 * the standard one (72 vs 67 ms); with fewer cores it wins there too.
 */
export const GPU_BETTER = .95
export interface GpuTuned { type: 'gpuTuned'; choice: 'gpu' | 'cpu'; gpuMs: number; cpuMs: number }

export interface Snapshot {
  type: 'snapshot'; buffer: ArrayBuffer; steps: number; time: number
  rotation: RotationState; diagnostics: ModelDiagnostics
  /** The flashes since the previous snapshot, the counts since the start and the charge carried to the ground, C. */
  flashes: Flash[]; flashCount: { ic: number; cg: number }; chargeGround: number
  /** Heat and vapour put in by hand so far (AtmosphereModel.added). */
  added: AtmosphereModel['added']; water?: AtmosphereModel['water']
  /** Threads the physics runs on (1 without cross-origin isolation). */
  threads: number
  /**
   * The GPU: its name when the dynamics run on it; else 'off', 'starting', 'unavailable' (no WebGPU),
   * 'cpu-transport' (a transport the GPU does not do) or 'error: …'.
   */
  gpu?: string
  /** Mean time of the steps in this batch, ms: the whole step and the wait for the GPU's part of it. */
  stepMs?: { step: number; gpu: number }
  /** The first snapshot after a 'load' request: the ones still on their way from before it are stale. */
  loaded?: boolean
}
