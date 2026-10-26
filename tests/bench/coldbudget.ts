// @ts-nocheck
// The cold pool's budget (roadmap D2): the ground air's θv deficit split into what each process did to the air on its
// way down (SimConfig.budget: rain evaporating, melting and sublimating snow, graupel and hail, the saturation
// adjustment, the ground's heat) and where it came from (theta brought down from aloft, the transport's error), each
// against the undisturbed air at the ground (the mean of the columns at or above the OUTFLOW_WARM percentile of θv: the
// deficit here is against that mean, ~0.1-0.3 K more than outflowDeficit's against the percentile), plus the
// vapour's share of θv and the condensate's load (θ q_cond, K: what it takes off the buoyancy).
//   npx vite build --ssr tests/bench/coldbudget.ts --outDir .bench/coldbudget && node .bench/coldbudget/coldbudget.js <scenario index> [minutes=60] [single] [large] [spacing=km] [diagnosed | n0=m^-4] [out.json]
// diagnosed: the rain's intercept from its water content (AtmosphereModel.rainIntercept, Zhang et al. 2008) instead of
// Marshall-Palmer's; n0: a fixed intercept (Dawson et al. 2010 ran 4e5) — the sensitivity of the cold pool to the rain's
// evaporation.
// Regions: "rotation" — the ground columns within OUTFLOW_NEAR of the low-level rotation with a deficit >= 1 K (under
// the RFD and the occlusion); "pool" — every column with a deficit >= 2 K; "coldest" — the coldest column.
import { writeFileSync } from 'node:fs'
import { AtmosphereModel, BUDGET_TERMS, DT, SCENARIOS } from '../../src/core'
import { OUTFLOW_NEAR, OUTFLOW_WARM } from '../../src/core/rkw'
import { SUMMER_DAY } from '../../src/core/fixtures'

const args = process.argv.slice(2), s = SCENARIOS[Number(args[0])], minutes = Number(args[1] ?? 60)
const spacing = args.find(a => a.startsWith('spacing='))?.slice(8), out = args.find(a => a.endsWith('.json'))
const model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values, budget: true, single: args.includes('single') || undefined, domain: args.includes('large') ? 'large' : s.values.domain, spacing: spacing ? Number(spacing) : undefined })
const n0 = args.find(a => a.startsWith('n0='))?.slice(3)
if (args.includes('diagnosed')) model.rainIntercept = 'diagnosed'
else if (n0) model.rainIntercept = Number(n0)
let peakW = 0, peakUH = 0, peakRate = 0
const g = model.grid, { nx, ny, layer, dx, dy } = g, b = model.budget
// theta0: the environment's at the ground (not each column's at the start: the domain follows the storm, and the
// starting thermal's warmth carried by the flow is part of where the air came from).
const theta0 = model.env.theta[0]
const PARTS = ['origin', ...BUDGET_TERMS, 'vapour']
console.log(`${s.name}: ${nx} x ${ny}, dx ${dx.toFixed(0)} m, ${minutes} min${args.includes('single') ? ', single' : ''}${args.includes('large') ? ', large' : ''}`)

/** Each ground column's θv deficit split into the parts (positive = colder than the undisturbed air), and its load. */
function split() {
  const thv = new Float32Array(layer)
  for (let c = 0; c < layer; c++) thv[c] = model.theta[c] * (1 + .61 * model.q[c])
  const warm = Float32Array.from(thv).sort()[Math.floor((layer - 1) * OUTFLOW_WARM)]
  // The undisturbed air: the mean of each part over the columns at least as warm as the percentile.
  const part = (c: number) => {
    const th = model.theta[c], q = model.q[c], k = 1 + .61 * q, r: Record<string, number> = {}
    let named = 0
    for (const t of BUDGET_TERMS) { r[t] = b[t][c] * k; named += b[t][c] }
    r.origin = (th - theta0 - named) * k
    r.vapour = .61 * th * q
    return r
  }
  const ref: Record<string, number> = Object.fromEntries(PARTS.map(p => [p, 0]))
  let n = 0, refThv = 0
  for (let c = 0; c < layer; c++) if (thv[c] >= warm) { const r = part(c); for (const p of PARTS) ref[p] += r[p]; refThv += thv[c]; n++ }
  for (const p of PARTS) ref[p] /= n
  refThv /= n
  const cols = new Array(layer)
  for (let c = 0; c < layer; c++) {
    const r = part(c), d: Record<string, number> = { deficit: refThv - thv[c] }
    // theta' (1 + .61 q) + .61 theta q' ~ thv' to second order; the parts are the deficit's (ref minus column).
    for (const p of PARTS) d[p] = ref[p] - r[p]
    d.load = model.theta[c] * (model.cloud[c] + model.ice[c] + model.rain[c] + model.snow[c] + model.graupel[c] + model.hail[c])
    cols[c] = d
  }
  return cols
}

const near = (c: number, c0: number) => {
  const x = c % nx, y = Math.floor(c / nx), x0 = c0 % nx, y0 = Math.floor(c0 / nx)
  const ddx = Math.min(Math.abs(x - x0), nx - Math.abs(x - x0)) * dx, ddy = Math.min(Math.abs(y - y0), ny - Math.abs(y - y0)) * dy
  return ddx * ddx + ddy * ddy <= OUTFLOW_NEAR ** 2
}
const mean = (cols, pick: (c: number) => boolean) => {
  const sum: Record<string, number> = {}, keys = ['deficit', ...PARTS, 'load']
  for (const k of keys) sum[k] = 0
  let n = 0
  for (let c = 0; c < layer; c++) if (pick(c)) { for (const k of keys) sum[k] += cols[c][k]; n++ }
  if (!n) return null
  for (const k of keys) sum[k] /= n
  sum.area = n * dx * dy / 1e6
  return sum
}

const rows = []
const fmt = (r) => r ? `${r.deficit.toFixed(1)} K = ${PARTS.map(p => `${p} ${r[p].toFixed(1)}`).join(', ')} (load ${r.load.toFixed(1)}, ${r.area.toFixed(0)} km2)` : '—'
for (let step = 1; step * DT <= minutes * 60 + 1e-6; step++) {
  model.step(DT); model.time += DT
  peakUH = Math.max(peakUH, model.rotation.uh)
  if (Math.round(model.time) % 60 === 0) { const d = model.diagnostics(); peakW = Math.max(peakW, d.updraft); peakRate = Math.max(peakRate, d.rainRate) }
  const t = Math.round(model.time)
  if (t % 120 || t < 1200) continue
  const cols = split(), low = model.rotation.low, coldest = cols.reduce((k, v, i) => v.deficit > cols[k].deficit ? i : k, 0)
  const row = { t: t / 60, rotation: model.rotation.uh > 0 ? mean(cols, c => cols[c].deficit >= 1 && near(c, low)) : null, pool: mean(cols, c => cols[c].deficit >= 2), coldest: mean(cols, c => c === coldest) }
  rows.push(row)
  if (t % 600 === 0) console.log(`${t / 60} min\n  rotation: ${fmt(row.rotation)}\n  pool:     ${fmt(row.pool)}\n  coldest:  ${fmt(row.coldest)}`)
}
// The 30-60 min means of each region.
const late = rows.filter(r => r.t >= 30)
for (const region of ['rotation', 'pool', 'coldest']) {
  const have = late.map(r => r[region]).filter(Boolean)
  if (!have.length) continue
  const avg = {}
  for (const k of Object.keys(have[0])) avg[k] = have.reduce((s, r) => s + r[k], 0) / have.length
  console.log(`mean 30-${minutes} min, ${region}: ${fmt(avg)}`)
}
const end = model.diagnostics()
let volume = 0
for (let c = 0; c < layer; c++) volume += model.precipitation[c] / 1000 * dx * dy
console.log(`storm: w max ${peakW.toFixed(1)} m/s, UH max ${peakUH.toFixed(0)}, rain rate max ${peakRate.toFixed(0)} mm/h, rain at the end: ${(volume / 1e6).toFixed(2)} Mm3 (point max ${end.rainTotal.toFixed(1)} mm), outflow ${end.outflow.toFixed(1)} K, gust ${end.gust.toFixed(1)} m/s`)
if (out) writeFileSync(out, JSON.stringify({ scenario: s.name, spacing: dx / 1000, rainIntercept: model.rainIntercept, peakW, peakUH, peakRate, volume: volume / 1e6, rows }))
