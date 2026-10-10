// @ts-nocheck
// How many numbered cells the tracker shows over a scenario: every 5 model minutes the confirmed cells with their peak
// updraught and cloud top, and the cores still waiting for a number.
//   npx vite build --ssr tests/bench/cells.ts --outDir .bench/cells && node .bench/cells/cells.js <scenario index> [minutes=40]
import { AtmosphereModel, CellTracker, DT, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [index, minutes = 40] = process.argv.slice(2).map(Number), s = SCENARIOS[index]
const model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values }), tracker = new CellTracker(), numbered = new Set<number>()
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % 6 === 0) { tracker.update(model); for (const c of tracker.cells) numbered.add(c.id) }
  if (t % 300) continue
  const cells = tracker.cells
  console.log(`${s.name} ${t / 60} min: ${cells.length} numbered (${numbered.size} so far), ${tracker.unnumbered ?? "?"} without a number: ${cells.map(c => `№${c.id} w${c.stats.updraft.toFixed(0)}/${c.peakW.toFixed(0)} top ${c.stats.cloudTop.toFixed(1)} ${c.stage}`).join(', ')}`)
}
