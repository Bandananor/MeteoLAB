// @ts-nocheck
// Estimated peak currents of the CG flashes on a run (peakCurrents in lightning.ts): the first-stroke current of -CG
// and +CG (5 / 50 / 95 %), the strokes per -CG and the subsequent strokes' currents.
//   npx vite-node tests/bench/currents.ts ["<scenario>"] [minutes=50]
import { AtmosphereModel, createGrid, domainGrid, DT, peakCurrents, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const name = process.argv.slice(2).find(a => !a.includes('=')) ?? 'Классическая суперячейка', minutes = Number(process.argv.find(a => a.startsWith('minutes='))?.slice(8) ?? 50)
const s = SCENARIOS.find(x => x.name === name), config = { ...SUMMER_DAY, ...s.values }
const model = new AtmosphereModel(config, createGrid(domainGrid(config.domain, config.top, config.domainSize)))
const cg = []
let seen = 0
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  const total = model.flashCount.ic + model.flashCount.cg
  for (const f of model.flashes.slice(Math.max(0, model.flashes.length - (total - seen)))) if (f.kind === 'CG') cg.push(f)
  seen = total
}
const q = (v, p) => { if (!v.length) return '—'; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(0) }
const neg = cg.filter(f => f.charge < 0), pos = cg.filter(f => f.charge > 0)
const first = list => list.map(f => Math.abs(peakCurrents(f)[0]))
const later = neg.flatMap(f => peakCurrents(f).slice(1).map(Math.abs))
console.log(`${name}, ${minutes} min: ${neg.length} -CG, ${pos.length} +CG`)
console.log(`-CG first stroke kA 5/50/95 %: ${q(first(neg), .05)} / ${q(first(neg), .5)} / ${q(first(neg), .95)}; strokes per flash mean ${(neg.reduce((a, f) => a + (f.strokes?.length ?? 1), 0) / Math.max(1, neg.length)).toFixed(1)}; subsequent kA 50 %: ${q(later, .5)}`)
console.log(`+CG kA 5/50/95 %: ${q(first(pos), .05)} / ${q(first(pos), .5)} / ${q(first(pos), .95)}`)
