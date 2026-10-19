// @ts-nocheck
// Tornadic vortex signatures on the model's radar (2.8, mda.ts vortexSignature): every 4 min a volume scan from a radar
// 25 km south-west of the strongest rotation; for each circulation its Vrot, base, the largest gate-to-gate ΔV per tilt
// and the TVS / ETVS if any, with UH 0-1 km of the model.
//   npx vite build --ssr tests/bench/tvs.ts --outDir .bench/tvs && node .bench/tvs/tvs.js "<scenario>" [minutes=70]
import { AtmosphereModel, DT, MesocycloneDetector, PPI, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [name, minutesArg] = process.argv.slice(2), minutes = Number(minutesArg ?? 70), s = SCENARIOS.find(x => x.name === name)
const model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values }), detector = new MesocycloneDetector(), { width, depth, dx, dy } = model.grid
const ppi = new PPI(model, Math.round(width / 500), Math.round(depth / 500))
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % 240 || t < 1200) continue
  const r = model.rotation, [ox, oy] = model.frameOffset()
  ppi.site = { x: r.x * dx + ox - 18000, y: r.y * dy + oy - 18000 }; ppi.layout()
  const found = detector.scan(ppi, model.time)
  console.log(`${t / 60} min: UH ${r.uh.toFixed(0)} UH01 ${r.uh01.toFixed(0)} | ` + found.filter(c => c.strength !== 'circulation').map(c => `M${c.id} ${c.strength} Vrot ${c.vrot.toFixed(0)} base ${(c.base / 1000).toFixed(1)} km${` ΔVgg ${c.gateDv.toFixed(0)}` + (c.tvs ? ` ${c.tvs.kind} low ${c.tvs.lowDv.toFixed(0)} max ${c.tvs.maxDv.toFixed(0)} ${(c.tvs.base / 1000).toFixed(1)}-${(c.tvs.top / 1000).toFixed(1)} km` : '')}`).join(' | '))
}
