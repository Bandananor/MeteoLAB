// @ts-nocheck
// The mixed phase of a storm (2.7.2, ice from processes): every 10 model minutes, in the core (updraught over 8 m/s at
// 4-10 km) by temperature, the mean cloud water, cloud ice, snow, graupel and hail (g/m³); the flashes since the last
// report (IC / -CG / +CG); the largest hail and graupel content anywhere and the rain at the ground.
//   npx vite build --ssr tests/bench/ice.ts --outDir .bench/ice && node .bench/ice/ice.js "<scenario>" [minutes=60] [w=0]
// With w, the bands count only the core's nodes whose own updraught is at least w m/s (the heart of the updraught).
import { AtmosphereModel, createGrid, domainGrid, DT, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [name, minutesArg, strongArg] = process.argv.slice(2), minutes = Number(minutesArg ?? 60), strong = Number(strongArg ?? 0)
const scenario = SCENARIOS.find(s => s.name === name)
if (!scenario) { console.log(`no scenario "${name}": ${SCENARIOS.map(s => s.name).join(', ')}`); process.exit(1) }
const config = { ...SUMMER_DAY, ...scenario.values }, grid = createGrid(domainGrid(config.domain, config.top, config.domainSize))
const model = new AtmosphereModel(config, grid), { nz, layer, zs } = grid, rho = model.env.rho
const level = (km: number) => zs.findIndex(z => z >= km * 1000)
let ic = 0, neg = 0, pos = 0, seen = 0
const t0 = performance.now()
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  const total = model.flashCount.ic + model.flashCount.cg
  for (const f of model.flashes.slice(Math.max(0, model.flashes.length - (total - seen)))) { if (f.kind === 'IC') ic++; else if (f.charge > 0) pos++; else neg++ }
  seen = total
  if (t % 600) continue
  const k4 = level(4), k10 = level(10), core = []
  for (let c = 0; c < layer; c++) { let up = 0; for (let z = k4; z <= k10; z++) up = Math.max(up, model.w[c + z * layer]); if (up > 8) core.push(c) }
  // By temperature band of 5 K from 0 to -45 °C: the mean over the core nodes in that band.
  const bands = Array.from({ length: 9 }, () => ({ n: 0, w: 0, i: 0, s: 0, g: 0, h: 0 }))
  for (const c of core) for (let z = 0; z < nz; z++) {
    const j = c + z * layer, tc = model.theta[j] * model.env.exner[z] - 273.15, b = Math.floor(-tc / 5)
    if (b < 0 || b >= bands.length || model.w[j] < strong) continue
    const r = rho[z] * 1e3, s = bands[b]; s.n++; s.w += model.cloud[j] * r; s.i += model.ice[j] * r; s.s += model.snow[j] * r; s.g += model.graupel[j] * r; s.h += model.hail[j] * r
  }
  // Crystals per litre by band (mean over the core nodes of the band).
  for (const c of core) for (let z = 0; z < nz; z++) { const j = c + z * layer, b = Math.floor(-(model.theta[j] * model.env.exner[z] - 273.15) / 5); if (b >= 0 && b < bands.length) bands[b].c = (bands[b].c ?? 0) + model.iceNumber[j] * rho[z] / 1e3 }
  let hail = 0, graupel = 0, wMax = 0
  for (let j = 0; j < model.hail.length; j++) { const z = Math.floor(j / layer); hail = Math.max(hail, model.hail[j] * rho[z] * 1e3); graupel = Math.max(graupel, model.graupel[j] * rho[z] * 1e3); wMax = Math.max(wMax, model.w[j]) }
  let groundHail = 0; for (let c = 0; c < layer; c++) groundHail = Math.max(groundHail, model.hail[c] * rho[0] * 1e3)
  const f = (v: number) => v.toFixed(2)
  console.log(`${t / 60} min, w max ${wMax.toFixed(0)} m/s, core ${core.length} cols | flashes IC ${ic} -CG ${neg} +CG ${pos} | max graupel ${f(graupel)} hail ${f(hail)} (ground ${f(groundHail)}) g/m3 [${((performance.now() - t0) / 1000).toFixed(0)} s]`)
  for (let b = 0; b < bands.length; b++) { const s = bands[b]; if (s.n) console.log(`   ${-5 * b}…${-5 * b - 5} °C (${s.n}): water ${f(s.w / s.n)} ice ${f(s.i / s.n)} snow ${f(s.s / s.n)} graupel ${f(s.g / s.n)} hail ${f(s.h / s.n)} crystals ${((s.c ?? 0) / s.n).toFixed(0)}/L`) }
  ic = neg = pos = 0
}
