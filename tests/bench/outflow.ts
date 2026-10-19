// @ts-nocheck
// The outflow's true cold against the cold-pool indicator (2.8): every 2 min the indicator's largest value below
// 1.5 km, the largest θv deficit at the ground, the deficit within 4 km of the low-level rotation (UH 0-1 km), and each
// numbered cell's deficit under its rotation and over its storm area with its stage.
//   npx vite build --ssr tests/bench/outflow.ts --outDir .bench/outflow && node .bench/outflow/outflow.js "<scenario>" [minutes=90]
import { AtmosphereModel, CellTracker, DT, outflowDeficit, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [name, minutesArg] = process.argv.slice(2), minutes = Number(minutesArg ?? 90), s = SCENARIOS.find(x => x.name === name)
const model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values }), tracker = new CellTracker()
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % 6 === 0) tracker.update(model)
  if (t % 120) continue
  const d = model.diagnostics(), o = outflowDeficit(model), f = (v: number) => v.toFixed(1)
  console.log(`${t / 60} min: indicator ${f(d.coldMax)} θv′ max ${f(d.outflow)} near UH01 ${f(d.outflowLow)} (UH01 ${model.rotation.uh01.toFixed(0)}) warm ${f(o.warm)} | ` + tracker.cells.filter(c => c.id).map(c => `#${c.id} ${c.stage} θv′ under ${f(c.stats.coldUnder)} area ${f(c.stats.coldPool)} (UH01 ${c.stats.uh01.toFixed(0)})`).join(' | '))
}
