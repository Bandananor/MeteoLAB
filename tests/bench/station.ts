// @ts-nocheck
// A virtual weather station in a scenario: placed dx_km east and dy_km north of the first thermal (ground fixed), it
// prints its record every model minute — does a gust front show as on a real station (pressure jump, temperature fall,
// gust), and the downpour?
//   npx vite build --ssr tests/bench/station.ts --outDir .bench/station && node .bench/station/station.js [scenario=0] [dx_km=6] [dy_km=0] [minutes=50]
import { AtmosphereModel, DT, SCENARIOS, Station } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [index = 0, ex = 6, ey = 0, minutes = 50] = process.argv.slice(2).map(Number), s = SCENARIOS[index]
const model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values }), { width: W, depth: D } = model.grid
const station = new Station(W * .38 + ex * 1000, D * .45 + ey * 1000)
console.log(`${s.name}: station at ${(station.x / 1000).toFixed(1)}, ${(station.y / 1000).toFixed(1)} km, domain moving ${model.frame.map(f => f.toFixed(1)).join(', ')} m/s`)
station.observe(model)
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % 6 === 0) station.observe(model)
}
for (const r of station.records) console.log(`${(r.t / 60).toFixed(0).padStart(3)} min  T ${r.temp.toFixed(1)}  Td ${r.dew.toFixed(1)}  p ${r.pressure.toFixed(2)}  wind ${r.wind.toFixed(1)} from ${r.dir.toFixed(0)}  gust ${r.gust.toFixed(1)}  rain ${r.rainRate.toFixed(1)} mm/h  total ${r.rainTotal.toFixed(1)} mm`)
