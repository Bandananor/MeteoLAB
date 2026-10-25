// @ts-nocheck
// The compensating subsidence around a nudged storm from a sounding file (E10): every 5 min the strongest updraught and,
// over the clear columns (no cloud or precipitation in the column), the mean w and the change of θ and q since the start
// at the cap's heights; with "large" on the 96 x 72 km domain instead of 48 x 36 km.
//   node .bench/sink/sink.js <file> [large] [minutes=60]
import { readFileSync } from 'node:fs'
import { AtmosphereModel, DT, parseSounding } from '../../src/core'
import { DEFAULTS, fillLowWind } from '../../src/defaults'
const args = process.argv.slice(2), file = args[0], minutes = Number(args.find(a => a.startsWith('minutes='))?.slice(8) ?? 60)
const config = { ...structuredClone(DEFAULTS), sounding: { ...parseSounding(readFileSync(file, 'utf8')), name: 'x' }, start: 'nudge', ...(args.includes('large') ? { domain: 'large' } : {}) }
fillLowWind(config)
const m = new AtmosphereModel(config), { nx, ny, nz, zs, layer } = m.grid
const HEIGHTS = [1, 1.5, 2, 2.5, 3], levels = HEIGHTS.map(h => zs.findIndex(z => z >= h * 1000))
const mean = (f, z) => { let s = 0; for (let i = z * layer; i < (z + 1) * layer; i++) s += f[i]; return s / layer }
const theta0 = levels.map(z => mean(m.theta, z)), q0 = levels.map(z => mean(m.q, z))
console.log(`${file.split(/[\\/]/).pop()} ${config.domain ?? 'standard'} ${nx} x ${ny}; levels ${levels.map(z => (zs[z] / 1000).toFixed(2)).join(' ')} km`)
console.log('min  wmax  clear%  w_clear cm/s by level  |  dθ_clear K by level  |  dq_clear g/kg by level')
const clear = new Uint8Array(layer), f = (v, d = 0) => v.toFixed(d)
for (let t = DT, k = 1; t <= minutes * 60 + 1e-9; t += DT, k++) {
  m.step(DT); m.time = Math.round(t * 1000) / 1000
  if (k % Math.round(300 / DT)) continue
  let n = 0
  for (let c = 0; c < layer; c++) {
    let wet = 0
    for (let z = 0; z < nz && !wet; z++) { const i = c + z * layer; wet = m.cloud[i] + m.rain[i] + m.ice[i] + m.snow[i] + m.graupel[i] + m.hail[i] > 1e-5 ? 1 : 0 }
    clear[c] = wet ? 0 : 1; n += clear[c]
  }
  const avg = (fld, z) => { let s = 0; for (let c = 0; c < layer; c++) if (clear[c]) s += fld[c + z * layer]; return s / Math.max(1, n) }
  console.log(`${f(t / 60).padStart(3)} ${f(m.diagnostics().updraft).padStart(5)} ${f(100 * n / layer).padStart(6)}   ${levels.map(z => f(100 * avg(m.w, z)).padStart(4)).join(' ')}  |  ${levels.map((z, j) => f(avg(m.theta, z) - theta0[j], 2).padStart(5)).join(' ')}  |  ${levels.map((z, j) => f(1000 * (avg(m.q, z) - q0[j]), 2).padStart(5)).join(' ')}`)
}
