// @ts-nocheck
// The satellite's view of the model's storms (2.8, satellite.ts): every 5 min the coldest infrared brightness
// temperature, the share of the domain under cloud (τ > 1) and under a cold anvil (below -40 °C), the overshooting tops
// found, the model's cloud top and the temperature of the environment at the tropopause.
//   npx vite build --ssr tests/bench/satellite.ts --outDir .bench/satellite && node .bench/satellite/satellite.js "<scenario>" [minutes=60]
import { AtmosphereModel, DT, overshootingTops, satelliteImage, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [name, minutesArg] = process.argv.slice(2), minutes = Number(minutesArg ?? 60), s = SCENARIOS.find(x => x.name === name)
const model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values })
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % 300 || t < 900) continue
  const img = satelliteImage(model, 1), n = img.infrared.length
  let cold = Infinity, cloudy = 0, anvil = 0
  for (let c = 0; c < n; c++) { cold = Math.min(cold, img.infrared[c]); if (img.tau[c] > 1) cloudy++; if (img.infrared[c] < -40) anvil++ }
  const tops = overshootingTops(model, img.infrared), d = model.diagnostics()
  console.log(`${t / 60} min: coldest ${cold.toFixed(1)} °C | cloud ${(100 * cloudy / n).toFixed(0)}% anvil ${(100 * anvil / n).toFixed(0)}% | OT ${tops.map(o => `${o.temperature.toFixed(0)}°C (${o.contrast.toFixed(1)} K)`).join(', ') || '—'} | cloud top ${d.cloudTop.toFixed(1)} km, up ${d.updraft.toFixed(0)} m/s`)
}
