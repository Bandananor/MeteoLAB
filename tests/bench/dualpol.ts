// @ts-nocheck
// Dual-polarisation signatures in a modelled storm (2.1): every 10 model minutes, from the model nodes,
//  - the ZDR column: the highest node above the 0 °C level with ZDR >= 1 dB and Z >= 20 dBZ, and its updraught;
//  - the hail core: nodes below 2 km with Z >= 55 dBZ — their mean ZDR and rho_hv (vs. the rain nodes of 40-50 dBZ);
//  - the melting layer: rho_hv of the nodes within 1 km below the 0 °C level with snow or graupel and Z >= 25 dBZ;
//  - the largest KDP below 2 km.
//   npx vite build --ssr tests/bench/dualpol.ts --outDir .bench/dualpol && node .bench/dualpol/dualpol.js <scenario name> [minutes=50]
import { AtmosphereModel, DT, dualPol, reflectivity, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [name = 'Суперячейка WK', minutes = '50'] = process.argv.slice(2)
const model = new AtmosphereModel({ ...SUMMER_DAY, ...SCENARIOS.find(s => s.name === name).values })
const { nz, layer, zs } = model.grid, e = model.env
const freezing = zs[zs.findIndex((_, z) => e.theta[z] * e.exner[z] - 273.15 <= 0)]
console.log(`${name}: 0 °C at ${(freezing / 1000).toFixed(1)} km`)
for (let t = DT; t <= Number(minutes) * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % 600) continue
  let column = 0, columnW = 0, hailN = 0, hailZdr = 0, hailRho = 0, rainN = 0, rainZdr = 0, rainRho = 0, meltN = 0, meltRho = 0, meltMin = 1, kdp = 0
  for (let z = 0, i = 0; z < nz; z++) {
    const rho = e.rho[z], h = zs[z]
    for (let end = i + layer; i < end; i++) {
      const r = model.rain[i], s = model.snow[i], g = model.graupel[i], hl = model.hail[i]
      if (r <= 0 && s <= 0 && g <= 0 && hl <= 0) continue
      const tc = model.theta[i] * e.exner[z] - 273.15, dbz = reflectivity(rho, r, s, g, tc, hl)
      if (dbz < 20) continue
      const d = dualPol(rho, r, s, g, tc, hl)
      if (tc < 0 && d.zdr >= 1 && h > column) { column = h; columnW = model.w[i] }
      if (h < 2000 && dbz >= 55) { hailN++; hailZdr += d.zdr; hailRho += d.rho }
      if (h < 2000 && dbz >= 40 && dbz < 50 && hl < 1e-5 && g < 1e-5) { rainN++; rainZdr += d.zdr; rainRho += d.rho }
      if (h < freezing && h > freezing - 1000 && dbz >= 25 && (s > 1e-5 || g > 1e-5)) { meltN++; meltRho += d.rho; meltMin = Math.min(meltMin, d.rho) }
      if (h < 2000) kdp = Math.max(kdp, d.kdp)
    }
  }
  const avg = (sum, n, digits = 2) => n ? (sum / n).toFixed(digits) : '—'
  console.log(`${t / 60} min: ZDR column top ${(column / 1000).toFixed(1)} km (w ${columnW.toFixed(0)} m/s) | hail core ${hailN} nodes ZDR ${avg(hailZdr, hailN)} rho ${avg(hailRho, hailN, 3)} | rain 40-50 dBZ ZDR ${avg(rainZdr, rainN)} rho ${avg(rainRho, rainN, 3)} | melting ${meltN} nodes rho ${avg(meltRho, meltN, 3)} (min ${meltMin.toFixed(3)}) | KDP max ${kdp.toFixed(1)}`)
}
