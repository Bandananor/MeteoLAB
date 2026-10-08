import { describe, expect, it } from 'vitest'
import { AtmosphereModel, AttachedMemory, controlBuffer, createGrid, type GridOptions, SharedMemory, type StepRunner, ThreadRunner } from '.'
import { SUMMER_DAY } from './fixtures'

// A small stretched domain: enough for a cloud, rain and ice in 15 minutes, fast enough for the quick tests.
const GRID: GridOptions = { nx: 16, ny: 12, nz: 24, width: 19_200, depth: 13_500, height: 15_000, bottomSpacing: 100 }
const FIELDS = ['u', 'v', 'w', 'theta', 'q', 'cloud', 'rain', 'cold', 'ice', 'snow', 'graupel', 'hail', 'precipitation', 'pressure'] as const

function run(runner: ((model: AtmosphereModel) => StepRunner) | null, steps = 900, memory?: SharedMemory) {
  const model = new AtmosphereModel({ ...SUMMER_DAY, bubble: 1.4 }, createGrid(GRID), undefined, { memory })
  if (runner) model.runner = runner(model)
  for (let k = 0; k < steps; k++) { model.step(1); model.time += 1 }
  return model
}
const same = (a: AtmosphereModel, b: AtmosphereModel) => FIELDS.every(k => { const x = a[k], y = b[k]; return x.every((v, i) => Object.is(v, y[i])) }) && a.negativeFilled === b.negativeFilled

describe('threaded steps (src/core/threads.ts)', () => {
  it('gives bit-for-bit the same model in slabs or whole fields, whatever order the tasks of a phase run in', () => {
    const inOrder = run(null)
    // Some precipitation and ice formed, so every kind of task did real work.
    expect(Math.max(...inOrder.rain)).toBeGreaterThan(1e-4); expect(Math.max(...inOrder.graupel)).toBeGreaterThan(1e-5)
    const slabs = run(m => { m.transportSlabs = 10; return m.runner })
    const reversed = run(m => { m.transportSlabs = 10; return { run: (phase, tasks, dt) => { for (let k = tasks - 1; k >= 0; k--) m.runTask(phase, k, dt) } } })
    const interleaved = run(m => ({ run: (phase, tasks, dt) => { for (const odd of [1, 0]) for (let k = odd; k < tasks; k += 2) m.runTask(phase, k, dt) } }))
    expect(same(inOrder, slabs)).toBe(true); expect(same(inOrder, reversed)).toBe(true); expect(same(inOrder, interleaved)).toBe(true)
  }, 120_000)

  it('runs a step through the shared control block like the plain loop (no helpers here)', () => {
    const plain = run(null, 120), memory = new SharedMemory()
    const pooled = run(m => { m.transportSlabs = 10; return new ThreadRunner(m, controlBuffer(), 0) }, 120, memory)
    expect(same(plain, pooled)).toBe(true)
  })

  it('lets a helper attach to the same memory: it sees the fields and the switches of the main model', () => {
    const memory = new SharedMemory(), main = new AtmosphereModel({ ...SUMMER_DAY }, createGrid(GRID), undefined, { memory })
    const helper = new AtmosphereModel({ ...SUMMER_DAY }, createGrid(GRID), undefined, { memory: new AttachedMemory(memory.buffers), attach: true })
    main.u[5] = 12.5; expect(helper.u[5]).toBe(12.5)
    main.config.solarMax = 300; main.rainFormation = false
    helper.applySettings(main.settings())
    expect(helper.config.solarMax).toBe(300); expect(helper.rainFormation).toBe(false)
    expect(() => new AtmosphereModel({ ...SUMMER_DAY }, createGrid({ ...GRID, nx: 20 }), undefined, { memory: new AttachedMemory(memory.buffers), attach: true })).toThrow()
  })
})
