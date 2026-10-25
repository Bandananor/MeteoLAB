// @ts-nocheck
// The real soundings of tests/fixtures/soundings run as the simulator runs them (the defaults, the sounding, a thermal
// of the chosen strength): the parcels' CAPE and CIN, then the strongest updraught, the cloud top and the rain minute by
// minute — does the storm live or decay, and why (testers, 24.10.2026: «a decay on every sounding, even the moistest»).
//   npx vite build --ssr tests/bench/soundings.ts --outDir .bench/soundings && node .bench/soundings/soundings.js <file> [bubble=1] [minutes=60] [nosun] [nudge] [nudge=W] [dt=3]
import { readFileSync } from 'node:fs'
import { AtmosphereModel, DT, MESO_CORE_ZETA, parcelIndices, parseSounding, stormIndices } from '../../src/core'
import { DEFAULTS, fillLowWind } from '../../src/defaults'

const args = process.argv.slice(2), file = args[0], opt = (k: string, d: number) => Number(args.find(a => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? d)
const sounding = parseSounding(readFileSync(file, 'utf8')), minutes = opt('minutes', 60)
const config = { ...structuredClone(DEFAULTS), sounding: { ...sounding, name: file.split(/[\\/]/).pop() }, bubble: opt('bubble', 1), ...(args.includes('nosun') ? { solarMax: 0 } : {}), ...(args.some(a => a.startsWith('nudge')) ? { start: 'nudge', ...(opt('nudge', 0) ? { nudge: opt('nudge', 0) } : {}) } : {}) }
fillLowWind(config)
const model = new AtmosphereModel(config), idx = parcelIndices(model.env, model.grid.height)
const f = (v: number, d = 0) => v.toFixed(d)
console.log(`${config.sounding.name} (${sounding.station ?? ''} ${sounding.time ?? ''}) bubble ${config.bubble}${config.start === 'nudge' ? ` nudged to ${config.nudge ?? 10} m/s` : ''}${args.includes('nosun') ? ' no sun' : ''}: SB CAPE ${f(idx.sb.cape)} CIN ${f(idx.sb.cin)}, ML ${f(idx.ml.cape)} / ${f(idx.ml.cin)}, MU ${f(idx.mu.cape)}; ground T ${f(model.env.temperatureEnv(0) - 273.15, 1)} °C, q ${f(model.env.q[0] * 1000, 1)} g/kg`)
const k = stormIndices(model.env, idx)
console.log(`  shear 0-6 ${f(k.shear06)} m/s, SRH 0-1 / 0-3 ${f(k.srh01)} / ${f(k.srh03)}, effective ${k.effective ? `${f(k.effective.base)}-${f(k.effective.top)} m SRH ${f(k.effective.srh)} shear ${f(k.effective.shear)}` : 'none'}, SCP ${f(k.scp, 1)} STP ${f(k.stp, 1)}`)
const rows: string[] = [], spin: string[] = []
let uhMax = 0, zetaMax = 0, mesoFrom = 0
let peak = 0, peakAt = 0
const dt = opt('dt', DT)
for (let t = dt; t <= minutes * 60 + 1e-9; t += dt) {
  model.step(dt); model.time = Math.round(t * 1000) / 1000
  uhMax = Math.max(uhMax, model.rotation.uh); zetaMax = Math.max(zetaMax, model.rotation.coreZeta)
  if (!mesoFrom && model.rotation.persisted >= 600) mesoFrom = t / 60
  if (Math.abs(t / 60 - Math.round(t / 60)) < 1e-6 && Math.round(t / 60) % 2 === 0) {
    const d = model.diagnostics()
    if (d.updraft > peak) { peak = d.updraft; peakAt = t / 60 }
    spin.push(`${t / 60}:${f(model.rotation.uh)}/${f(model.rotation.coreZeta * 1000, 1)}`)
    rows.push(`${t / 60}:${f(d.updraft)}/${f(d.cloudTop, 1)}${d.rainRate > 1 ? `/${f(d.rainRate)}` : ''}`)
  }
}
console.log(`  w max / top km / rain mm/h every 2 min: ${rows.join(' ')}`)
console.log(`  UH 2-5 / core zeta 1e-3 1/s every 2 min: ${spin.join(' ')}`)
console.log(`  UH max ${f(uhMax)}, core zeta max ${f(zetaMax * 1000, 1)}e-3 (threshold ${MESO_CORE_ZETA * 1000}e-3), mesocyclone label ${mesoFrom ? `from ${f(mesoFrom, 1)} min` : 'never'}`)
console.log(`  peak ${f(peak, 1)} m/s at ${peakAt} min; at the end w ${f(model.diagnostics().updraft, 1)} m/s, cells ${model.diagnostics().cores}, clipped ${model.clipped}`)
