// @ts-nocheck
// Grid convergence on a full storm (roadmap A2): one scenario in the single-storm mode (one thermal in the middle, no
// sun, no random perturbations — the same start on every grid) at a given horizontal spacing, the levels and the domain
// unchanged. Every minute: the peaks (updraught, UH 2-5 km, gust, cold pool) and the integral quantities a coarse grid
// may get right while the peaks do not — the rain volume on the ground, the area of the echo >= 40 dBZ (column maximum),
// the area of the updraught >= 10 m/s at ~5 km and of the cold pool (theta' <= -2 K at the ground node).
//   npx vite build --ssr tests/bench/converge.ts --outDir .bench/converge && node .bench/converge/converge.js <scenario index> <spacing km|-> [minutes=60] [out.json]
// The 96 x 72 km domain (as the WK check, src/validation/cases.ts): on 48 x 36 km the cold pool fills the periodic
// domain by ~60 min and the storm breathes its own outflow on every grid.
import { writeFileSync } from 'node:fs'
import { AtmosphereModel, DT, SCENARIOS } from '../../src/core'
import { reflectivity } from '../../src/core/radar'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [index, spacingArg, minutesArg, out] = process.argv.slice(2), s = SCENARIOS[Number(index)]
const spacing = spacingArg === '-' ? undefined : Number(spacingArg), minutes = Number(minutesArg ?? 60)
const model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values, spacing, single: true, domain: 'large' })
const g = model.grid, e = model.env, cell = g.dx * g.dy / 1e6
const at5 = g.zs.reduce((k, z, i) => Math.abs(z - 5000) < Math.abs(g.zs[k] - 5000) ? i : k, 0)
console.log(`${s.name}: ${g.nx} x ${g.ny} x ${g.nz}, dx ${g.dx.toFixed(0)} m, single storm, ${minutes} min; 5 km level ${g.zs[at5].toFixed(0)} m`)

const rows = []
let uh = 0
const t0 = performance.now()
for (let step = 1; step * DT <= minutes * 60 + 1e-6; step++) {
  model.step(DT); model.time += DT
  uh = Math.max(uh, model.rotation.uh)
  if (Math.round(model.time) % 60) continue
  const d = model.diagnostics(), dbz = new Float32Array(g.layer)
  for (let z = 0, i = 0; z < g.nz; z++) for (let c = 0; c < g.layer; c++, i++) {
    if (model.rain[i] + model.snow[i] + model.graupel[i] + model.hail[i] < 1e-7) continue
    dbz[c] = Math.max(dbz[c], reflectivity(e.rho[z], model.rain[i], model.snow[i], model.graupel[i], model.theta[i] * e.exner[z] - 273.15, model.hail[i]))
  }
  let echo = 0, up = 0, pool = 0, volume = 0
  for (let c = 0; c < g.layer; c++) {
    if (dbz[c] >= 40) echo += cell
    if (model.w[c + at5 * g.layer] >= 10) up += cell
    if (model.theta[c] - e.theta[0] <= -2) pool += cell
    volume += model.precipitation[c] / 1000 * g.dx * g.dy
  }
  rows.push({ t: model.time / 60, w: d.updraft, uh, gust: d.gust, coldPool: d.outflow, rainMax: d.rainTotal, rainVolume: volume / 1e6, echo40: echo, updraft10: up, pool2: pool, top: d.cloudTop, meso: model.rotation.persisted, clipped: d.clipped })
  uh = 0
  const r = rows.at(-1)
  if (r.t % 5 === 0) console.log(`  ${r.t} min: w ${r.w.toFixed(1)}, UH ${r.uh.toFixed(0)}, rain ${r.rainVolume.toFixed(2)} Mm3 (max ${r.rainMax.toFixed(1)} mm), echo40 ${r.echo40.toFixed(0)} km2, w10@5km ${r.updraft10.toFixed(0)} km2, pool ${r.pool2.toFixed(0)} km2 / ${r.coldPool.toFixed(1)} K, gust ${r.gust.toFixed(1)}, ${((performance.now() - t0) / 60000).toFixed(1)} min`)
}
if (out) writeFileSync(out, JSON.stringify({ scenario: s.name, spacing: g.dx / 1000, nx: g.nx, ny: g.ny, nz: g.nz, minutes, seconds: (performance.now() - t0) / 1000, rows }))
console.log(`done in ${((performance.now() - t0) / 60000).toFixed(1)} min`)
