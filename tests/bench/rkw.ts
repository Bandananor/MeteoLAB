// @ts-nocheck
// The RKW balance in a scenario every 10 model minutes: cold-pool speed C (mean and strongest column), its depth and
// area, the 0-2.5 km shear and C/Δu with what it means.
//   npx vite build --ssr tests/bench/rkw.ts --outDir .bench/rkw && node .bench/rkw/rkw.js [scenario=0] [minutes=60]
import { AtmosphereModel, coldPoolBalance, describeBalance, DT, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [index = 0, minutes = 60] = process.argv.slice(2).map(Number), s = SCENARIOS[index], model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values })
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % 600) continue
  const b = coldPoolBalance(model)
  console.log(`${s.name} ${t / 60} min: ${b ? `C ${b.c.toFixed(1)} (max ${b.cMax.toFixed(1)}) m/s, depth ${(b.depth / 1000).toFixed(1)} km, area ${(100 * b.area).toFixed(0)} %, Δu ${b.deltaU.toFixed(1)} m/s, C/Δu ${b.ratio.toFixed(2)} — ${describeBalance(b)}` : 'no cold pool'}`)
}
