// @ts-nocheck
// How the mesocyclone label depends on its threshold: a scenario (index) or a sounding file (nudged start), the core's
// w-weighted vorticity every step, its peak and the longest stretch above each threshold (the label asks MESO_PERSISTENCE).
//   node .bench/meso/meso.js <scenario index | file> [minutes=40] [spacing=km]
import { readFileSync } from 'node:fs'
import { AtmosphereModel, DT, MESO_CORE_ZETA, MESO_PERSISTENCE, parseSounding, SCENARIOS } from '../../src/core'
import { DEFAULTS, fillLowWind } from '../../src/defaults'
const args = process.argv.slice(2), a = args[0], isFile = isNaN(Number(a)), opt = (k, d) => Number(args.find(x => x.startsWith(`${k}=`))?.slice(k.length + 1) ?? d)
const minutes = opt('minutes', 40), spacing = opt('spacing', 0)
const config = isFile
  ? { ...structuredClone(DEFAULTS), sounding: { ...parseSounding(readFileSync(a, 'utf8')), name: 'x' }, start: 'nudge' }
  : { ...structuredClone(DEFAULTS), ...structuredClone(SCENARIOS[Number(a)].values) }
if (spacing) config.spacing = spacing
if (isFile) fillLowWind(config)
const m = new AtmosphereModel(config), THRESHOLDS = [3, 4, 5, 6, 8, 10].map(x => x * 1e-3)
const run = THRESHOLDS.map(() => 0), longest = THRESHOLDS.map(() => 0)
let peak = 0, uh = 0, w = 0, held = 0
for (let t = DT; t <= minutes * 60 + 1e-9; t += DT) {
  m.step(DT); m.time = Math.round(t * 1000) / 1000
  const z = m.rotation.coreZeta
  peak = Math.max(peak, z); uh = Math.max(uh, m.rotation.uh); held = Math.max(held, m.rotation.persisted)
  if (Math.round(t) % 60 === 0) w = Math.max(w, m.diagnostics().updraft)
  THRESHOLDS.forEach((th, k) => { run[k] = z >= th ? run[k] + DT : 0; longest[k] = Math.max(longest[k], run[k]) })
}
const name = isFile ? a.split(/[\\/]/).pop() : SCENARIOS[Number(a)].name, meant = isFile ? '' : ` meant ${SCENARIOS[Number(a)].mesocyclone ?? '—'}`
console.log(`${name}${spacing ? ` ${spacing} km` : ''}${meant}: w ${w.toFixed(0)}, UH ${uh.toFixed(0)}, core zeta peak ${(peak * 1e3).toFixed(1)}e-3; longest s above ${THRESHOLDS.map((th, k) => `${th * 1e3}e-3: ${longest[k]}${longest[k] >= MESO_PERSISTENCE ? '*' : ''}`).join(', ')} (* = 600 s); the label on this grid: threshold ${(m.rotation.mesoZeta * 1e3).toFixed(1)}e-3, held ${held} s${held >= MESO_PERSISTENCE ? " - mesocyclone" : ""}`)
