// @ts-nocheck
// A scenario with a given time step, and how often the eddy viscosity hits its stability cap:
//   npx vite build --ssr tests/bench/dt.ts --outDir .bench/dt && node .bench/dt/dt.js <scenario index> <dt> [minutes=40]
import { AtmosphereModel, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [index, dt, minutes = 40] = process.argv.slice(2).map(Number), s = SCENARIOS[index]
const model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values })
let capped = 0, capHi = 0, counted = 0
let longest = 0, maxW = 0, maxUH = 0, gust = 0, next = 0
const { layer, zs } = model.grid, near = zs.findIndex(z => z >= 100) * layer, [fu, fv] = model.frame, t0 = performance.now()
for (let t = 0; t < minutes * 60; t += dt) {
  model.step(dt); model.time += dt; longest = Math.max(longest, model.rotation.persisted); maxUH = Math.max(maxUH, model.rotation.uh)
  if (t >= next) {
    next += 30; { const g = model.grid, km = model.turbulence.km; for (let z = 0; z < g.nz; z++) { const cap = .05 * Math.min(g.dx, g.dy, z > 0 ? g.dzs[z - 1] : Infinity, z < g.nz - 1 ? g.dzs[z] : Infinity) ** 2 / dt; for (let i = z * g.layer; i < (z + 1) * g.layer; i++) { if (km[i] > 1) { counted++; if (km[i] >= cap * .999) { capped++; if (g.zs[z] > 1000) capHi++ } } } } } maxW = Math.max(maxW, model.diagnostics().updraft)
    for (let c = 0; c < layer; c++) gust = Math.max(gust, Math.hypot(model.u[near + c] + fu, model.v[near + c] + fv))
  }
  if (!Number.isFinite(model.w[0]) || !Number.isFinite(maxW)) { console.log('blow-up at', t); break }
}
console.log(`${s.name} dt ${dt}: max w ${maxW.toFixed(1)} m/s, max UH ${maxUH.toFixed(0)}, mesocyclone ${longest} s, wind at 100 m ${gust.toFixed(1)} m/s, rain ${Math.max(...model.precipitation).toFixed(1)} mm, hail ${(Math.max(...model.hailSize) / 10).toFixed(1)} cm / ${Math.max(...model.hailGround).toFixed(1)} mm, clipped ${model.clipped}, K capped ${capped} of ${counted} mixing nodes (${capHi} above 1 km), water fix ${model.negativeFilled.toExponential(2)}, ${((performance.now() - t0) / 1000).toFixed(0)} s`)
