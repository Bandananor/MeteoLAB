// @ts-nocheck
// The environments of all scenarios side by side (no run): CAPE/CIN, LCL/LFC/EL, DCAPE, shear, SRH, PW, 0 °C, lapse rates.
//   npx vite build --ssr tests/bench/envs.ts --outDir .bench/envs && node .bench/envs/envs.js
import { createGrid, domainGrid, Environment, parcelIndices, SCENARIOS, skewIndices, stormIndices } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const f = (x, d = 0) => x === null || x === undefined ? '—' : x.toFixed(d)
for (const s of SCENARIOS) {
  const config = { ...SUMMER_DAY, ...s.values }, grid = createGrid(domainGrid(config.domain, config.top))
  const env = new Environment(config, grid), i = parcelIndices(env, grid.height), k = skewIndices(env, grid.height), st = stormIndices(env, i)
  console.log(`${s.name.padEnd(22)} SB ${f(i.sb.cape)}/${f(i.sb.cin)} ML ${f(i.ml.cape)}/${f(i.ml.cin)} MU ${f(i.mu.cape)} | LCL ${f(i.ml.lcl, 1)} LFC ${f(i.ml.lfc, 1)} EL ${f(i.ml.el, 1)} | DCAPE ${f(i.dcape)} | S06 ${f(st.shear06)} SRH1 ${f(st.srh01)} SRH3 ${f(st.srh03)} | PW ${f(k.pw)} 0C ${f(k.freezing, 1)} LR03 ${f(k.lapse03, 1)} LR75 ${f(k.lapse75, 1)} SCP ${f(st.scp, 1)} STP ${f(st.stp, 1)}`)
}
