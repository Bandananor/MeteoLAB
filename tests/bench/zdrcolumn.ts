// @ts-nocheck
// The ZDR column on a run (PPI.zdrColumn): every `every` model minutes its deepest point above the 0 °C level, the
// area deeper than 1 km, and the strongest updraught, for comparison.
//   npx vite-node tests/bench/zdrcolumn.ts ["<scenario>"] [minutes=40] [every=5] [radar=wsr88d]
import { AtmosphereModel, createGrid, domainGrid, DT, PPI, RADARS, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const opt = (k, d) => process.argv.find(a => a.startsWith(k + '='))?.slice(k.length + 1) ?? d
const name = process.argv.slice(2).find(a => !a.includes('=')) ?? 'Классическая суперячейка', minutes = Number(opt('minutes', 40)), every = Number(opt('every', 5))
const s = SCENARIOS.find(x => x.name === name), config = { ...SUMMER_DAY, ...s.values }
const model = new AtmosphereModel(config, createGrid(domainGrid(config.domain, config.top, config.domainSize)))
const ppi = new PPI(model, 160, 120)
ppi.setProfile(RADARS[opt('radar', 'wsr88d')] ?? Object.values(RADARS)[0]); ppi.dual = true
console.log(`${name}, radar ${ppi.profile.name}`)
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (Math.round(t) % (every * 60)) continue
  ppi.prepare(); ppi.zdrColumn()
  let deep = 0, over1 = 0, w = 0
  for (const d of ppi.zdrColumnDepth) if (d > 0) { deep = Math.max(deep, d); if (d >= 1) over1++ }
  for (const v of model.w) w = Math.max(w, v)
  console.log(`${t / 60} min: 0 °C at ${(ppi.levelH2 / 1000).toFixed(1)} km, deepest column ${deep.toFixed(2)} km, ${over1} px >= 1 km, w max ${w.toFixed(1)} m/s`)
}
