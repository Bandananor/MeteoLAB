// @ts-nocheck
// The mesoscale mode (SimConfig.domain 'meso', 2 km spacing; roadmap 2.x «Режим "мезомасштаб"»): a scenario on its own
// domain against the same scenario in the mesoscale mode — the cost per step, the storm (peak updraught, rain, echo area,
// cold pool, gust, rotation) every 10 model minutes, and whether the run stays sane (clipped, NaN):
//   npx vite build --ssr tests/bench/mesoscale.ts --outDir .bench/mesoscale && node .bench/mesoscale/mesoscale.js <scenario index> <domain: standard|large|meso> [minutes=60] [size=WxD] [key=value…]
// key=value overrides a setting (numbers as numbers, e.g. single=true start=nudge).
import { AtmosphereModel, DT, SCENARIOS } from '../../src/core'
import { reflectivity } from '../../src/core/radar'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [index, domain, minutesArg = '60', ...rest] = process.argv.slice(2), s = SCENARIOS[Number(index)], minutes = Number(minutesArg)
const extra = Object.fromEntries(rest.filter(a => a.includes('=') && !a.startsWith('size=')).map(a => { const [k, v] = a.split('='); return [k, v === 'true' ? true : v === 'false' ? false : Number.isFinite(Number(v)) ? Number(v) : v] }))
const size = rest.find(a => a.startsWith('size='))?.slice(5).split('x').map(Number)
const model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values, domain, ...(size ? { domainSize: size } : {}), ...extra })
const g = model.grid, { layer, zs } = g, cell = g.dx * g.dy / 1e6
console.log(`${s.name} (${domain}): ${g.nx} x ${g.ny} x ${g.nz} = ${(g.n / 1e6).toFixed(2)} M nodes, ${g.width / 1000} x ${g.depth / 1000} km, dx ${g.dx.toFixed(0)} dy ${g.dy.toFixed(0)} m, meso threshold ${model.rotation.mesoZeta.toExponential(1)} 1/s`)
const e = model.env, k1 = zs.findIndex(z => z >= 1000), l1 = k1 * layer, l5 = zs.findIndex(z => z >= 5000) * layer
let maxW = 0, maxUH = 0, longest = 0, maxGust = 0, steps = 0, firstEcho = NaN
const t0 = performance.now()
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT; steps++
  maxUH = Math.max(maxUH, model.rotation.uh); longest = Math.max(longest, model.rotation.persisted)
  if (t % 60) continue
  const d = model.diagnostics()
  if (!Number.isFinite(d.updraft)) { console.log(`blow-up at ${t} s`); break }
  maxW = Math.max(maxW, d.updraft); maxGust = Math.max(maxGust, d.gust)
  // Echo >= 40 dBZ at 1 km, km^2; updraught >= 10 m/s at 5 km, km^2.
  let echo = 0, up = 0
  for (let c = 0; c < layer; c++) {
    const i = l1 + c
    if (reflectivity(e.rho[k1], model.rain[i], model.snow[i], model.graupel[i], model.theta[i] * e.exner[k1] - 273.15, model.hail[i]) >= 40) echo += cell
    if (model.w[l5 + c] >= 10) up += cell
  }
  if (echo > 0 && !(firstEcho >= 0)) firstEcho = t / 60
  if (t % 600 === 0) console.log(`  ${t / 60} min: w ${d.updraft.toFixed(1)} m/s, up>=10 at 5 km ${up.toFixed(0)} km2, echo>=40 dBZ ${echo.toFixed(0)} km2, rain ${d.rainRate.toFixed(0)} mm/h total ${d.rainTotal.toFixed(1)} mm, outflow ${d.outflow.toFixed(1)} K, gust ${d.gust.toFixed(1)} m/s, cores ${d.cores}, UH ${model.rotation.uh.toFixed(0)}, ${((performance.now() - t0) / steps).toFixed(0)} ms/step`)
}
const ms = (performance.now() - t0) / steps
console.log(`${s.name} ${domain}: max w ${maxW.toFixed(1)} m/s, max UH ${maxUH.toFixed(0)}, mesocyclone ${longest} s, gust ${maxGust.toFixed(1)} m/s, first echo>=40 dBZ ${firstEcho} min, clipped ${model.clipped}, ${ms.toFixed(0)} ms/step (${(ms / DT / 1000).toFixed(2)} s of compute per model second)`)
