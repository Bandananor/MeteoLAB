// @ts-nocheck
// How much of the condensate in the updraughts is ice, by temperature (the trough situation's late storms died after
// 2.7.2's ice from processes: is the supercooled water left unfrozen?). Every 10 model minutes from `from` min, over
// the points with w above `minW` m/s and condensate above 0.1 g/kg, in 5 K bins: the liquid (cloud water, rain), the
// ice (cloud ice, snow, graupel, hail), the ice fraction, the mean w and the mean temperature excess over the
// environment (the buoyancy the updraught has there).
//   npx vite build --ssr tests/bench/glaciation.ts --outDir .bench/glaciation && node .bench/glaciation/glaciation.js ["Высотная ложбина"] [from=90] [to=170] [minW=2]
import { AtmosphereModel, DT, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const args = process.argv.slice(2), opt = (k: string, d: number) => Number(args.find(a => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? d)
const name = args.find(a => !a.includes('=')) ?? 'Высотная ложбина', s = SCENARIOS.find(x => x.name === name)
const from = opt('from', 90), to = opt('to', 170), minW = opt('minW', 2)
const model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values }), { nz, layer, zs } = model.grid, e = model.env
const zero = (a?: Float32Array) => a ?? new Float32Array(model.grid.n)
const bins = () => Array.from({ length: 9 }, () => ({ liquid: 0, cloud: 0, ice: 0, crystals: 0, w: 0, excess: 0, n: 0 }))
let acc = bins()
console.log(`${name}: T bin °C | ice fraction | liquid g/kg | ice g/kg | mean w m/s | T excess K | points`)
for (let t = DT; t <= to * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t < from * 60 || t % 60) continue
  const ice = zero(model.ice), snow = zero(model.snow), graupel = zero(model.graupel), hail = zero(model.hail)
  for (let z = 0; z < nz; z++) {
    const ex = e.exner[z], tEnv = e.theta[z] * ex - 273.15
    for (let c = 0; c < layer; c++) {
      const i = c + z * layer, w = model.w[i]
      if (w < minW) continue
      const T = model.theta[i] * ex - 273.15, liquid = model.cloud[i] + model.rain[i], solid = ice[i] + snow[i] + graupel[i] + hail[i]
      if (T > 0 || T <= -45 || liquid + solid < 1e-4) continue
      const b = acc[Math.floor(-T / 5)]
      b.liquid += liquid; b.cloud += model.cloud[i]; b.ice += solid; b.crystals += (model.iceNumber?.[i] ?? 0) * e.rho[z] / 1000; b.w += w; b.excess += T - tEnv; b.n++
    }
  }
  if (t % 600) continue
  const h = (s.values.hour ?? 13.5) + t / 3600
  console.log(`-- ${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')} (10 min)`)
  acc.forEach((b, k) => { if (b.n) console.log(`${-5 * k}…${-5 * (k + 1)} | ${(b.ice / (b.ice + b.liquid)).toFixed(2)} | ${(b.liquid / b.n * 1000).toFixed(2)} (cloud ${(b.cloud / b.n * 1000).toFixed(2)}) | ${(b.ice / b.n * 1000).toFixed(2)} (crystals ${(b.crystals / b.n).toFixed(0)}/L) | ${(b.w / b.n).toFixed(1)} | ${(b.excess / b.n).toFixed(2)} | ${b.n}`) })
  acc = bins()
}
