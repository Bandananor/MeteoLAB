// @ts-nocheck
// The helper threads' share of a step done by attached helper models, as in the browser and the precise run (threads.ts
// serveTasks: settings when they change, the model time each phase), against the same run on one thread: the peaks.
//   npx vite build --ssr tests/bench/helpers.ts --outDir .bench/helpers && node .bench/helpers/helpers.js <scenario index> <threads> [minutes=40]
import { AtmosphereModel, AttachedMemory, DT, SCENARIOS, SharedMemory } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [index, threadsArg, minutesArg = '40'] = process.argv.slice(2), s = SCENARIOS[Number(index)], threads = Number(threadsArg), minutes = Number(minutesArg)
const memory = new SharedMemory(), config = () => ({ ...SUMMER_DAY, ...structuredClone(s.values) })
const m = new AtmosphereModel(config(), undefined, undefined, { memory })
if (threads > 1) {
  m.transportSlabs = 10
  const helpers = Array.from({ length: threads - 1 }, () => new AtmosphereModel(config(), m.grid, undefined, { memory: new AttachedMemory(memory.buffers), attach: true }))
  // Task k goes to thread k mod threads (thread 0 the main model), as the shared counter hands them out on average.
  m.runner = { run: (phase, tasks, dt) => { for (const h of helpers) { h.applySettings(m.settings()); h.time = m.time } for (let k = 0; k < tasks; k++) (k % threads ? helpers[k % threads - 1] : m).runTask(phase, k, dt) } }
}
let w = 0, uh = 0, rain = 0, held = 0
for (let t = DT; t <= minutes * 60; t += DT) {
  m.step(DT); m.time += DT; uh = Math.max(uh, m.rotation.uh); held = Math.max(held, m.rotation.persisted)
  if (t % 60 === 0) { const d = m.diagnostics(); w = Math.max(w, d.updraft); rain = Math.max(rain, d.rainTotal) }
}
console.log(`${s.name} threads ${threads}: w max ${w.toFixed(1)} m/s, UH ${uh.toFixed(0)}, mesocyclone ${held} s, rain total ${rain.toFixed(1)} mm`)
