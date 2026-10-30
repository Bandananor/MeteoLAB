// @ts-nocheck
// Where the vertical eddy viscosity meets its explicit-stability cap and how much mixing that cuts (plan 2.11): every
// 10 model minutes the Smagorinsky K the scheme wants (the viscosity recomputed with a vanishing dt, so no cap) against
// the cap 0.05 min(dx, dy, dz)^2 / dt, over the nodes that mix (K > 1 m2/s): the share capped and the wanted / cap ratio
// (median, 90th percentile) by height band, in cloud and in clear air:
//   npx vite build --ssr tests/bench/kcap.ts --outDir .bench/kcap && node .bench/kcap/kcap.js <scenario index> [spacing=km] [minutes=40] [domain=large] [start=nudge]
import { AtmosphereModel, DT, SCENARIOS, SMAGORINSKY } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const args = process.argv.slice(2), s = SCENARIOS[Number(args[0])], opt = (k, d) => args.find(x => x.startsWith(`${k}=`))?.slice(k.length + 1) ?? d
const spacing = Number(opt('spacing', 0)) || undefined, minutes = Number(opt('minutes', 40)), domain = opt('domain', 'large'), start = opt('start', undefined)
const m = new AtmosphereModel({ ...SUMMER_DAY, ...structuredClone(s.values), domain, spacing, ...(start ? { start } : {}) })
const g = m.grid, { layer, nz, zs, dzs } = g, BANDS = [[0, 1000], [1000, 3000], [3000, 8000], [8000, 20000]]
const pct = (a, p) => { if (!a.length) return NaN; const b = Float64Array.from(a).sort(); return b[Math.min(b.length - 1, Math.floor(p * b.length))] }
const stats = BANDS.map(() => ({ cloud: { n: 0, r: [] }, clear: { n: 0, r: [] } }))
for (let t = DT; t <= minutes * 60 + 1e-9; t += DT) {
  m.step(DT); m.time = Math.round(t * 1000) / 1000
  if (Math.round(m.time) % 600) continue
  const e = m.env, moist = { q: m.q, condensate: m.withIce() ? m.condensate : m.cloud, exner: e.exner }, cs = SMAGORINSKY * m.config.turbulence / .55
  m.turbulence.viscosity(m.u, m.v, m.w, m.theta, e.theta, cs, 1e-9, moist)
  const wanted = Float64Array.from(m.turbulence.km)
  m.turbulence.viscosity(m.u, m.v, m.w, m.theta, e.theta, cs, DT, moist)
  for (let z = 0; z < nz; z++) {
    const cap = .05 * Math.min(g.dx, g.dy, z > 0 ? dzs[z - 1] : Infinity, z < nz - 1 ? dzs[z] : Infinity) ** 2 / DT, b = BANDS.findIndex(([lo, hi]) => zs[z] >= lo && zs[z] < hi)
    for (let i = z * layer; i < (z + 1) * layer; i++) {
      if (wanted[i] <= 1) continue
      const where = moist.condensate[i] > 1e-5 ? stats[b].cloud : stats[b].clear
      where.n++; if (wanted[i] > cap) where.r.push(wanted[i] / cap)
    }
  }
}
console.log(`${s.name} | ${domain} ${(g.dx / 1000).toFixed(2)} km ${minutes} min${start ? ` ${start}` : ''} | w max ${m.diagnostics().updraft.toFixed(0)} now`)
BANDS.forEach(([lo, hi], b) => {
  const line = (k) => { const x = stats[b][k]; return `${k} ${x.n} nodes, capped ${(100 * x.r.length / Math.max(1, x.n)).toFixed(1)} %, wanted/cap median ${pct(x.r, .5).toFixed(1)} p90 ${pct(x.r, .9).toFixed(1)}` }
  console.log(`  ${lo / 1000}-${hi / 1000} km: ${line('cloud')}; ${line('clear')}`)
})
