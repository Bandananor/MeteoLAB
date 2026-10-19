// @ts-nocheck
// The rain of each cell against its updraught (a tester 19.10.2026: «under 10 m/s the rain is 100 mm/h»): every minute
// each numbered cell's strongest updraught, downdraught, heaviest rain at the ground and stage.
//   npx vite build --ssr tests/bench/rainstage.ts --outDir .bench/rainstage && node .bench/rainstage/rainstage.js "<scenario>" [minutes=50]
import { AtmosphereModel, CellTracker, DT, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [name, minutesArg] = process.argv.slice(2), minutes = Number(minutesArg ?? 50), s = SCENARIOS.find(x => x.name === name)
const model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values }), tracker = new CellTracker()
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % 6 === 0) tracker.update(model)
  if (t % 60) continue
  console.log(`${t / 60} min: ` + tracker.cells.map(c => `#${c.id} w ${c.stats.updraft.toFixed(0)}/${c.stats.downdraft.toFixed(0)} rain ${c.stats.rainRate.toFixed(0)} ${c.stage}`).join(' | '))
}
