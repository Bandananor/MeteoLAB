// @ts-nocheck
// Where the non-inductive charging acts, by temperature band (B6, the missing lower positive charge): every `every` model
// minutes, over the nodes of each 5 K band between 0 and -35 °C, the domain-integrated charge separated per second that
// goes to the rimers as positive and as negative (C/s, from chargingRate with the model's own crystals), and in the band's
// charging nodes the mean cloud water, crystals, snow and graupel, the share of rimer nodes in wet growth, and the share
// of nodes whose RAR exceeds the critical one (positive graupel). Also the net charge density by band (nC/m³).
//   npx vite-node tests/bench/chargebands.ts ["<scenario>"] [minutes=40] [every=10]
import { AtmosphereModel, createGrid, domainGrid, DT, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'
import { chargingRate, COLLECTION_EFFICIENCY, CHARGING_SPEED, criticalRar } from '../../src/core/charge'
import { graupelFallSpeed } from '../../src/core/graupel'

const args = process.argv.slice(2).filter(a => !a.includes('=')), opt = (k, d) => Number(process.argv.find(a => a.startsWith(k + '='))?.slice(k.length + 1) ?? d)
const name = args[0] ?? 'Классическая суперячейка', minutes = opt('minutes', 40), every = opt('every', 10)
const scenario = SCENARIOS.find(s => s.name === name), config = { ...SUMMER_DAY, ...scenario.values }
const model = new AtmosphereModel(config, createGrid(domainGrid(config.domain, config.top, config.domainSize)))
const { nz, layer, dx, dy, hz } = model.grid, e = model.env
console.log(`${name}: charging by temperature band (C/s to the rimers; + positive graupel)`)
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (Math.round(t) % (every * 60)) continue
  const bands = Array.from({ length: 7 }, () => ({ pos: 0, neg: 0, n: 0, qc: 0, ni: 0, qs: 0, qg: 0, wet: 0, above: 0, net: 0, vol: 0 }))
  for (let z = 0; z < nz; z++) {
    const rho = e.rho[z], exner = e.exner[z], vol = dx * dy * hz[z]
    for (let c = 0; c < layer; c++) {
      const i = c + z * layer, tc = model.theta[i] * exner - 273.15
      if (tc >= 0 || tc < -35) continue
      const b = bands[Math.min(6, Math.floor(-tc / 5))]
      b.net += (model.chargeIce[i] + model.chargeGraupel[i] + model.chargeRain[i] + model.chargeAir[i]) * rho * vol; b.vol += vol
      if (model.graupel[i] + model.hail[i] <= 1e-7 || model.cloud[i] <= 0) continue
      const rate = chargingRate(tc, rho, model.cloud[i], model.ice[i], model.snow[i], model.graupel[i], model.hail[i], model.snowFall[i], false, false, model.iceNumber[i] * rho)
      if (rate > 0) b.pos += rate * vol; else b.neg -= rate * vol
      const impact = Math.min(graupelFallSpeed(model.graupel[i], rho), CHARGING_SPEED), rar = COLLECTION_EFFICIENCY * rho * model.cloud[i] * 1000 * impact
      b.n++; b.qc += rho * model.cloud[i] * 1000; b.ni += model.iceNumber[i] * rho / 1000; b.qs += rho * model.snow[i] * 1000; b.qg += rho * model.graupel[i] * 1000
      if (rar > criticalRar(tc)) b.above++
    }
  }
  console.log(`${t / 60} min`)
  bands.forEach((b, k) => console.log(`  ${-5 * k}…${-5 * (k + 1)} °C: +${b.pos.toExponential(1)} −${b.neg.toExponential(1)} C/s | net ${(b.net / Math.max(1, b.vol) * 1e9).toFixed(3)} nC/m³ | ${b.n} rimer nodes: cloud ${(b.qc / Math.max(1, b.n)).toFixed(2)} g/m³, crystals ${(b.ni / Math.max(1, b.n)).toFixed(1)} /L, snow ${(b.qs / Math.max(1, b.n)).toFixed(2)}, graupel ${(b.qg / Math.max(1, b.n)).toFixed(2)} g/m³, RAR > RARc ${(b.above / Math.max(1, b.n) * 100).toFixed(0)} %`))
}
