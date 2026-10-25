// @ts-nocheck
// Cloud shadows on the ground's heating (roadmap B10): a scenario with and without them, every 5 min the strongest
// updraught, the number of updraught cores, the domain's mean sunlight share and the shaded share of the ground (< 50 %).
//   node .bench/shade/shade.js <scenario index> [minutes=60] [noshade]
import { AtmosphereModel, DT, SCENARIOS } from '../../src/core'
import { DEFAULTS } from '../../src/defaults'
const args = process.argv.slice(2), k = Number(args[0]), minutes = Number(args.find(a => a.startsWith('minutes='))?.slice(8) ?? 60)
const config = { ...structuredClone(DEFAULTS), ...structuredClone(SCENARIOS[k].values), ...(args.includes('noshade') ? { shade: false } : {}) }
const m = new AtmosphereModel(config), f = (v, d = 0) => v.toFixed(d)
const rows = []
let peak = 0, cores = 0, rain = 0
for (let t = DT, n = 1; t <= minutes * 60 + 1e-9; t += DT, n++) {
  m.step(DT); m.time = Math.round(t * 1000) / 1000
  if (n % Math.round(300 / DT)) continue
  const d = m.diagnostics(), sun = m.sunNow
  let mean = 0, dark = 0
  for (let c = 0; c < sun.length; c++) { mean += sun[c]; if (sun[c] < .5) dark++ }
  peak = Math.max(peak, d.updraft); cores = Math.max(cores, d.cores); rain = Math.max(rain, d.rainTotal)
  rows.push(`${f(t / 60)}:${f(d.updraft)}/${d.cores}/${f(100 * mean / sun.length)}/${f(100 * dark / sun.length)}`)
}
console.log(`${SCENARIOS[k].name}${config.shade === false ? ' no shade' : ''}: w max ${f(peak, 1)}, cores max ${cores}, rain total ${f(rain, 1)} mm`)
console.log(`  min: w / cores / mean sun % / shaded % — ${rows.join(' ')}`)
