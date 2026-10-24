// @ts-nocheck
// The lowest km of the model's environment: a sounding file or a scenario (debugging the real soundings, 24.10.2026).
//   node .bench/envdump/envdump.js <file | scenario index>
import { readFileSync } from 'node:fs'
import { AtmosphereModel, parcelIndices, parseSounding, SCENARIOS, qsatP } from '../../src/core'
import { DEFAULTS, fillLowWind } from '../../src/defaults'
const a = process.argv[2], isFile = isNaN(Number(a))
const config = isFile ? { ...structuredClone(DEFAULTS), sounding: { ...parseSounding(readFileSync(a, 'utf8')), name: 'x' } } : { ...structuredClone(DEFAULTS), ...SCENARIOS[Number(a)].values }
fillLowWind(config)
const m = new AtmosphereModel(config), e = m.env, idx = parcelIndices(e, m.grid.height)
console.log(isFile ? a : SCENARIOS[Number(a)].name, 'SB', idx.sb, 'ML', idx.ml)
for (let z = 0; z < m.grid.nz && m.grid.zs[z] < 5000; z++) {
  const T = e.theta[z] * e.exner[z] - 273.15, rh = e.q[z] / qsatP(T, e.p[z])
  console.log(`${m.grid.zs[z].toFixed(0).padStart(5)} m  p ${(e.p[z] / 100).toFixed(0)}  T ${T.toFixed(1)}  th ${e.theta[z].toFixed(1)}  thv ${(e.theta[z] * (1 + .61 * e.q[z])).toFixed(1)}  q ${(e.q[z] * 1000).toFixed(1)}  RH ${(rh * 100).toFixed(0)}  u ${e.u[z].toFixed(1)} v ${e.v[z].toFixed(1)}`)
}
