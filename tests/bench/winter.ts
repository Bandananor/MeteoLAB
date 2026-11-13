// @ts-nocheck
// Winter convection probe: a cold-air outbreak with a negative ground temperature. Does the core stay finite, does the
// snow and graupel reach the ground unmelted, is there rain at the ground, lightning?
//   npx vite-node tests/bench/winter.ts [t0=-3] [low=9] [mid=7.5] [trop=8] [rhl=85] [rhm=70] [bubble=2] [minutes=60]
// Every 10 min: w, ground T, precipitation at the ground, and in -33…0 °C the cloud water, graupel, crystals, the nodes
// where charging can act and the strongest net charge.
import { AtmosphereModel, createGrid, DT } from '../../src/core'
import { environmentOf } from '../../src/regime/grid'
import { SUMMER_DAY } from '../../src/core/fixtures'

const opt = (k: string, d: number) => Number(process.argv.find(a => a.startsWith(k + '='))?.slice(k.length + 1) ?? d)
const t0 = opt('t0', -3), minutes = opt('minutes', 60)
const config = {
  ...SUMMER_DAY, surfaceTemp: t0, lapseLow: opt('low', 9), lapseMid: opt('mid', 7.5), lapseUpper: 6.5, tropopause: opt('trop', 8), rhSurface: 90, rhLow: opt('rhl', 85), rhMid: opt('rhm', 70), rhUpper: 50,
  wind0: 5, wind3: 15, wind6: 20, wind10: 25, solarMax: 0, bubble: opt('bubble', 2), capStrength: 0,
}
const env = environmentOf(config)
console.log(`t0 ${t0} °C: SB CAPE ${env.cape?.toFixed?.(0)} J/kg`, JSON.stringify(Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, Math.round(v as number * 10) / 10]))).slice(0, 300))
const model = new AtmosphereModel(config, createGrid())
const { layer, zs } = model.grid
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (Math.round(t) % 600) continue
  let w = 0, bad = 0, rain0 = 0, snow0 = 0, gr0 = 0, hail0 = 0, tmin = 99, tmax = -99
  for (let i = 0; i < model.w.length; i++) { const v = model.w[i]; if (!Number.isFinite(v) || !Number.isFinite(model.theta[i])) bad++; else if (v > w) w = v }
  for (let c = 0; c < layer; c++) {
    rain0 = Math.max(rain0, model.rain[c]); snow0 = Math.max(snow0, model.snow[c]); gr0 = Math.max(gr0, model.graupel[c]); hail0 = Math.max(hail0, model.hail[c])
    const tk = model.theta[c] * model.env.exner[0] - 273.15; tmin = Math.min(tmin, tk); tmax = Math.max(tmax, tk)
  }
  let qcMix = 0, qgMix = 0, qiMix = 0, mixed = 0, q = 0
  for (let z = 0; z < model.grid.nz; z++) for (let c = 0; c < layer; c++) {
    const i = c + z * layer, tc = model.theta[i] * model.env.exner[z] - 273.15
    const net = Math.abs(model.chargeIce[i] + model.chargeGraupel[i] + model.chargeRain[i] + model.chargeAir[i]) * model.env.rho[z] * 1e9
    if (net > q) q = net
    if (tc < 0 && tc > -33) { qcMix = Math.max(qcMix, model.cloud[i]); qgMix = Math.max(qgMix, model.graupel[i]); qiMix = Math.max(qiMix, model.ice[i] + model.snow[i]); if (model.cloud[i] > 1e-5 && model.graupel[i] > 1e-5 && model.ice[i] + model.snow[i] > 1e-6) mixed++ }
  }
  console.log(`   -33..0 C: max cloud ${(qcMix * 1000).toFixed(3)} graupel ${(qgMix * 1000).toFixed(3)} ice+snow ${(qiMix * 1000).toFixed(3)} g/kg, charging nodes ${mixed}; max |net charge| ${q.toFixed(3)} nC/m3`)
  const g = (x: number) => (x * 1000).toFixed(3)
  console.log(`${t / 60} min: w ${w.toFixed(1)}, non-finite ${bad}, ground (${zs[0].toFixed(0)} m) T ${tmin.toFixed(1)}…${tmax.toFixed(1)} °C, max g/kg rain ${g(rain0)} snow ${g(snow0)} graupel ${g(gr0)} hail ${g(hail0)}, flashes CG ${model.flashCount.cg} IC ${model.flashCount.ic}`)
}
