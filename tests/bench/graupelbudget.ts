// @ts-nocheck
// Where a cell's graupel comes from: every `every` model minutes, over the nodes colder than 0 °C, the domain-integrated
// rates (kg/s) of the processes that make graupel and of the snow's riming, each from the scheme's own functions on a
// one-node copy of the state over 1 s, so the numbers are the model's:
//   rain freezing into graupel (P_gfr) and the rain mass below 0 °C it works on, snow turning into graupel (P_gaut),
//   graupel riming cloud water (P_gacw) and collecting snow and ice (P_gacs + P_gaci), snow riming cloud water (P_sacw,
//   which stays snow in Lin et al. 1983), cloud water becoming rain (autoconversion + accretion) below 0 °C.
//   npx vite-node tests/bench/graupelbudget.ts [winter] [minutes=40] [every=10]
// winter: the thundersnow probe of tests/bench/winter.ts (-2 °C, 9.8 / 7.5 K/km, ML CAPE ~410); else «Летний день».
import { AtmosphereModel, createGrid, DT, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'
import { graupelProcesses } from '../../src/core/graupel'
import { snowProcesses } from '../../src/core/ice'
import { rainProcesses } from '../../src/core/microphysics'

const args = process.argv.slice(2), opt = (k, d) => Number(args.find(a => a.startsWith(k + '='))?.slice(k.length + 1) ?? d)
const winter = args.includes('winter'), minutes = opt('minutes', 40), every = opt('every', 10)
const config = winter
  ? { ...SUMMER_DAY, surfaceTemp: -2, lapseLow: 9.8, lapseMid: 7.5, lapseUpper: 6.5, tropopause: 7, rhSurface: 90, rhLow: 90, rhMid: 75, rhUpper: 50, wind0: 5, wind3: 15, wind6: 20, wind10: 25, solarMax: 0, bubble: 1, capStrength: 0 }
  : { ...SUMMER_DAY, ...SCENARIOS.find(s => s.name === 'Летний день').values }
const model = new AtmosphereModel(config, createGrid())
const { layer, nz, zs } = model.grid, e = model.env
const one = () => new Float32Array(1)
const copy = (i) => { const s = {}; for (const k of ['theta', 'q', 'cloud', 'ice', 'snow', 'rain', 'graupel']) { s[k] = one(); s[k][0] = model[k][i] } return s }
console.log(`${winter ? 'winter thundersnow probe' : '«Летний день»'}: rates over the nodes below 0 °C, kg/s (domain integral, node volume × rho)`)
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (Math.round(t) % (every * 60)) continue
  const r = { gfr: 0, gaut: 0, gacw: 0, gacsi: 0, sacw: 0, cToRain: 0, rainCold: 0, graupel: 0, snow: 0, cloudCold: 0 }
  for (let z = 0; z < nz; z++) {
    const exner = e.exner[z], p = e.p ? e.p[z] : e.pressure[z], rho = e.rho[z], vol = model.grid.dx * model.grid.dy * model.grid.hz[z] * rho
    for (let c = 0; c < layer; c++) {
      const i = c + z * layer, tc = model.theta[i] * exner - 273.15
      if (tc >= 0) continue
      r.rainCold += model.rain[i] * vol; r.graupel += model.graupel[i] * vol; r.snow += model.snow[i] * vol; r.cloudCold += model.cloud[i] * vol
      if (model.cloud[i] + model.rain[i] + model.snow[i] + model.graupel[i] <= 1e-9) continue
      // Rain freezing and snow autoconversion alone: graupel set to zero so no collection follows.
      let s = copy(i); s.graupel[0] = 0; s.cloud[0] = 0; s.ice[0] = 0
      const rain0 = s.rain[0], snow0 = s.snow[0]
      graupelProcesses(s.theta, s.q, s.cloud, s.ice, s.snow, s.rain, s.graupel, 0, exner, p, rho, 1)
      const gfr = (rain0 - s.rain[0]) * vol, gaut = (snow0 - s.snow[0]) * vol; r.gfr += gfr; r.gaut += gaut
      // Graupel's collection: the full call minus the two above.
      s = copy(i); const g0 = s.graupel[0]
      graupelProcesses(s.theta, s.q, s.cloud, s.ice, s.snow, s.rain, s.graupel, 0, exner, p, rho, 1)
      const collected = Math.max(0, s.graupel[0] - g0) * vol - 0
      const c0 = model.cloud[i]
      r.gacw += (c0 - s.cloud[0]) * vol; r.gacsi += Math.max(0, collected - (c0 - s.cloud[0]) * vol - gfr - gaut)
      // Snow riming (P_sacw): the cloud water snowProcesses takes.
      s = copy(i); snowProcesses(s.theta, s.q, s.cloud, s.ice, s.snow, s.rain, 0, exner, p, rho, e.rho[0], 1)
      r.sacw += (c0 - s.cloud[0]) * vol
      // Cloud water to rain.
      s = copy(i); rainProcesses(s.q, s.cloud, s.rain, 0, model.theta[i] * exner, p, rho, 1)
      r.cToRain += (c0 - s.cloud[0]) * vol
    }
  }
  const f = (x) => x.toExponential(2)
  console.log(`${t / 60} min: graupel ${f(r.graupel)} kg, snow ${f(r.snow)}, rain<0°C ${f(r.rainCold)}, cloud<0°C ${f(r.cloudCold)} | P_gfr ${f(r.gfr)} P_gaut ${f(r.gaut)} P_gacw ${f(r.gacw)} P_gacs+gaci+gacr ${f(r.gacsi)} | P_sacw (stays snow) ${f(r.sacw)} | cloud→rain ${f(r.cToRain)}`)
}
