// A model step with the GPU (Э3 steps 5-6): the same step as AtmosphereModel.step, its parts split between the CPU and
// GpuDynamics — the sedimentation and the transport with the pressure in the stages on the GPU, the physics on the CPU,
// then the turbulence, the surface friction and the projection on the GPU again. Two round trips a step.
// Used by the worker (simulation.worker.ts) and the check (tests/bench/gpucheck.ts).
import type { AtmosphereModel } from '../core/model'
import type { GpuDynamics } from './dynamics'

/**
 * One step by dt (the caller advances model.time). Returns the time spent waiting for the GPU (ms) and, if the GPU
 * failed, why: the step is then finished on the CPU, and the caller should stop using this GpuDynamics.
 */
export async function gpuStep(m: AtmosphereModel, g: GpuDynamics, dt: number): Promise<{ waitMs: number; failed: string | null }> {
  m.beginStep(dt, false)
  const { fields, env } = m.dynamicsInputs(), falls = m.fallInputs(dt)
  let t0 = performance.now(), waitMs = 0
  const first = await g.step(fields, env, dt, false, falls).catch((e: unknown) => { g.errors.push(String(e)); return null })
  waitMs += performance.now() - t0
  if (!first || g.errors.length) {
    m.sedimentStep(dt); m.dynamics(dt); m.endStep(dt)
    return { waitMs, failed: g.errors[0] ?? 'no result' }
  }
  m.setCarried(first.fields); m.landed(falls, first.ground)
  m.physicsStep(dt)
  if (!m.gpuMixing()) { m.finishStep(dt); return { waitMs, failed: null } }
  t0 = performance.now()
  const second = await g.mix(fields, m.mixingInputs(dt), dt).catch((e: unknown) => { g.errors.push(String(e)); return null })
  waitMs += performance.now() - t0
  if (!second || g.errors.length) { m.finishStep(dt); return { waitMs, failed: g.errors[0] ?? 'no result' } }
  m.endGpuStep(dt, second.fields, second.pressure)
  return { waitMs, failed: null }
}
