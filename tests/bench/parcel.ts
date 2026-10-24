// @ts-nocheck
// The buoyancy of the standard parcels with height in a sounding file (or a scenario), also with entrainment:
//   node .bench/parcel/parcel.js <file | scenario index>
import { readFileSync } from 'node:fs'
import { AtmosphereModel, liftParcel, parseSounding, SCENARIOS } from '../../src/core'
import { DEFAULTS, fillLowWind } from '../../src/defaults'
const a = process.argv[2], isFile = isNaN(Number(a))
const config = isFile ? { ...structuredClone(DEFAULTS), sounding: { ...parseSounding(readFileSync(a, 'utf8')), name: 'x' } } : { ...structuredClone(DEFAULTS), ...SCENARIOS[Number(a)].values }
fillLowWind(config)
const m = new AtmosphereModel(config)
for (const kind of ['sb', 'ml']) {
  const p = liftParcel(m.env, m.grid.height, kind)
  console.log(kind, 'CAPE', p.cape.toFixed(0), 'CIN', p.cin.toFixed(0), 'LFC', p.lfc, 'EL', p.el)
  console.log('  Tv excess K by 0.25 km:', p.profile.filter(q => Math.abs(q.z * 4 - Math.round(q.z * 4)) < 1e-6 && q.z <= 6).map(q => `${q.z}:${((q.tv ?? q.parcel) - (q.envTv ?? q.env)).toFixed(1)}`).join(' '))
}
