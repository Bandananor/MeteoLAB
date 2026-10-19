// @ts-nocheck
// The supercell's FFD and RFD (2.8, flanks.ts): every 2 min for each rotating numbered cell the storm's heading, and for
// each flank where it lies from the mesocyclone (compass bearing and distance), its columns, sinking, θv′ and rain.
//   npx vite build --ssr tests/bench/flanks.ts --outDir .bench/flanks && node .bench/flanks/flanks.js "<scenario>" [minutes=80]
import { AtmosphereModel, CellTracker, DT, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [name, minutesArg] = process.argv.slice(2), minutes = Number(minutesArg ?? 80), s = SCENARIOS.find(x => x.name === name)
const model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values }), tracker = new CellTracker()
const bearing = (e: number, n: number) => ((Math.atan2(e, n) * 180 / Math.PI + 360) % 360).toFixed(0).padStart(3)
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % 6 === 0) tracker.update(model)
  if (t % 120) continue
  const parts = tracker.cells.filter(c => c.flanks).map(c => {
    const [ex, ey] = c.flanks.heading, gu = ex, gv = ey
    const f = (k: string, x) => {
      if (!x) return `${k} —`
      const e = x.along * ex - x.left * ey, n = x.along * ey + x.left * ex
      return `${k} ${bearing(e, n)}° ${(Math.hypot(e, n) / 1000).toFixed(1)} km n${x.columns.length} w-${x.down.toFixed(0)} θv′${x.cold.toFixed(1)} rain ${x.rain.toFixed(0)}`
    }
    return `#${c.id} ${c.stage} heading ${bearing(gu, gv)}° UH ${c.stats.uh.toFixed(0)} | ${f('FFD', c.flanks.ffd)} | ${f('RFD', c.flanks.rfd)}`
  })
  console.log(`${t / 60} min: ${parts.join(' || ')}`)
}
