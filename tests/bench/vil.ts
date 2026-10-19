// @ts-nocheck
// The radar's volume products on the model's storms (2.8, ppi.ts composite): every 5 min the largest VIL, the highest
// echo top, the VIL density where VIL is largest, the composite reflectivity there and the model's hail at the ground.
//   npx vite build --ssr tests/bench/vil.ts --outDir .bench/vil && node .bench/vil/vil.js "<scenario>" [minutes=60]
import { AtmosphereModel, DT, PPI, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [name, minutesArg] = process.argv.slice(2), minutes = Number(minutesArg ?? 60), s = SCENARIOS.find(x => x.name === name)
const model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values }), { width, depth, dx, dy } = model.grid
const ppi = new PPI(model, Math.round(width / 500), Math.round(depth / 500))
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % 300 || t < 900) continue
  const r = model.rotation, [ox, oy] = model.frameOffset()
  ppi.site = { x: r.x * dx + ox - 25000, y: r.y * dy + oy - 25000 }; ppi.layout(); ppi.composite()
  let k = 0, top = 0
  for (let i = 0; i < ppi.vil.length; i++) { if (ppi.vil[i] > ppi.vil[k]) k = i; top = Math.max(top, ppi.echoTop[i]) }
  const d = model.diagnostics()
  console.log(`${t / 60} min: VIL ${ppi.vil[k].toFixed(0)} kg/m² (CR ${ppi.compositeDbz[k].toFixed(0)} dBZ, ET there ${ppi.echoTop[k].toFixed(1)} km, density ${(ppi.vil[k] / Math.max(ppi.echoTop[k], .1)).toFixed(1)} g/m³) | top ET ${top.toFixed(1)} km | cloud top ${d.cloudTop.toFixed(1)} km, hail ${d.hail.toFixed(0)} mm, up ${d.updraft.toFixed(0)} m/s`)
}
