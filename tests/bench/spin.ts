// @ts-nocheck
// Rotation by height in a scenario every 10 model minutes: the w-ζ correlation at 2-6 km, the rotating layer of the core
// with the strongest UH and its peak w ζ.
//   npx vite build --ssr tests/bench/spin.ts --outDir .bench/spin && node .bench/spin/spin.js [scenario=0] [minutes=40]
import { AtmosphereModel, DT, SCENARIOS, spinProfile } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [index = 0, minutes = 40] = process.argv.slice(2).map(Number), s = SCENARIOS[index], model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values })
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % 600) continue
  const p = spinProfile(model)
  console.log(`${s.name} ${t / 60} min: corr w-ζ 2-6 km ${p.correlation?.toFixed(2) ?? '—'}, core rotates ${p.bottom ?? '—'}-${p.top?.toFixed(1) ?? '—'} km, peak w ζ ${Math.max(...p.wz).toFixed(0)}e-3, UH ${model.rotation.uh.toFixed(0)}, meso ${model.rotation.persisted} s`)
}
