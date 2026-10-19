// @ts-nocheck
// Where a supercell's precipitation reaches the ground around its mesocyclone (2.8, LP / classic / HP): every 2 min for
// each rotating numbered cell, in rings of 0-3, 3-6, 6-10 and 10-15 km from the mesocyclone's column, the share of
// columns with at least 5 mm/h and the heaviest rain, and where the heaviest rain of the whole storm area lies; and
// under the updraught (w >= 10 m/s at ~3 km within 8 km): the share of its columns rained on (5 mm/h) and their mean rain.
//   npx vite build --ssr tests/bench/sctype.ts --outDir .bench/sctype && node .bench/sctype/sctype.js "<scenario>" [minutes=70] ['{"rhMid": 30}']
import { AtmosphereModel, CellTracker, DT, groundPrecipitation, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [name, minutesArg, extra] = process.argv.slice(2), minutes = Number(minutesArg ?? 70), s = SCENARIOS.find(x => x.name === name)
const model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values, ...(extra ? JSON.parse(extra) : {}) }), tracker = new CellTracker(), { nx, ny, dx, dy } = model.grid
const RINGS = [0, 3000, 6000, 10000, 15000]
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % 6 === 0) tracker.update(model)
  if (t % 120 || t < 1200) continue
  const rain = groundPrecipitation(model)
  const parts = tracker.cells.filter(c => c.flanks).map(c => {
    const x0 = c.flanks.centre % nx, y0 = Math.floor(c.flanks.centre / nx), n = RINGS.map(() => 0), wet = RINGS.map(() => 0), max = RINGS.map(() => 0)
    let best = 0, bestR = 0
    for (let j = -14; j <= 14; j++) for (let i = -14; i <= 14; i++) {
      const r = Math.hypot(i * dx, j * dy), k = RINGS.findIndex((a, q) => q < RINGS.length - 1 && r >= a && r < RINGS[q + 1])
      if (k < 0) continue
      const v = rain[((x0 + i) % nx + nx) % nx + nx * (((y0 + j) % ny + ny) % ny)]
      n[k]++; if (v >= 5) wet[k]++; max[k] = Math.max(max[k], v); if (v > best) { best = v; bestR = r }
    }
    // Under the updraught: columns within 8 km of the mesocyclone with w >= 10 m/s at ~3 km — rained on, and how much.
    const k3 = model.grid.zs.findIndex(z => z >= 3000)
    let up = 0, upWet = 0, upRain = 0
    for (let j = -7; j <= 7; j++) for (let i = -7; i <= 7; i++) {
      if (Math.hypot(i * dx, j * dy) > 8000) continue
      const col = ((x0 + i) % nx + nx) % nx + nx * (((y0 + j) % ny + ny) % ny)
      if (model.w[col + k3 * model.grid.layer] < 10) continue
      up++; upRain += rain[col]; if (rain[col] >= 5) upWet++
    }
    return `#${c.id} ${c.stage} UH ${c.stats.uh.toFixed(0)} | under updraught ${up} cols ${up ? (100 * upWet / up).toFixed(0) : '-'}% wet mean ${up ? (upRain / up).toFixed(0) : '-'} | ` + RINGS.slice(0, -1).map((a, k) => `${a / 1000}-${RINGS[k + 1] / 1000}: ${(100 * wet[k] / n[k]).toFixed(0)}% max ${max[k].toFixed(0)}`).join(' · ') + ` | peak ${best.toFixed(0)} mm/h at ${(bestR / 1000).toFixed(1)} km`
  })
  console.log(`${t / 60} min: ${parts.join(' || ')}`)
}
