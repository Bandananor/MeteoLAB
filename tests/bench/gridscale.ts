// @ts-nocheck
// The grid-dependent thresholds (plan 2.11): a scenario on a chosen domain, horizontal spacing and time step, the peaks
// the labels are judged by — w, UH 2-5 / 0-3 / 0-1 km, the updraught core's vorticity (the mesocyclone), the largest
// vorticity at 2-5 km (the 3D mesocyclone column) — and how long each stayed above today's thresholds, with the
// flashes (the channel's capacitance is calibrated on 1.2 km) and the run's sanity (clipped, the eddy viscosity's cap):
//   npx vite build --ssr tests/bench/gridscale.ts --outDir .bench/gridscale && node .bench/gridscale/gridscale.js <scenario index> [spacing=km] [dt=s] [minutes=40] [domain=standard|large|meso] [start=nudge]
import { AtmosphereModel, MESO_CORE_ZETA, MESO_PERSISTENCE, SCENARIOS, UH_MESOCYCLONE, UH_ROTATING, UH03_ROTATING, UH01_LOW_MESO, VORTEX_ZETA } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const args = process.argv.slice(2), s = SCENARIOS[Number(args[0])], opt = (k, d) => args.find(x => x.startsWith(`${k}=`))?.slice(k.length + 1) ?? d
const spacing = Number(opt('spacing', 0)) || undefined, dt = Number(opt('dt', 3)), minutes = Number(opt('minutes', 40)), domain = opt('domain', 'large')
const start = opt('start', undefined), m = new AtmosphereModel({ ...SUMMER_DAY, ...structuredClone(s.values), domain, spacing, ...(start ? { start } : {}) })
const g = m.grid, { layer, zs } = g, k2 = zs.findIndex(z => z >= 2000), k5 = zs.findIndex(z => z >= 5000)
// [quantity, threshold]: the longest stretch above it, s.
const watched = { uh: UH_ROTATING, uhMeso: UH_MESOCYCLONE, uh03: UH03_ROTATING, uh01: UH01_LOW_MESO, core: MESO_CORE_ZETA, zeta: VORTEX_ZETA }
const peak = Object.fromEntries(Object.keys(watched).map(k => [k, 0])), run = { ...peak }, longest = { ...peak }
let w = 0, capped = 0, counted = 0, steps = 0
const t0 = performance.now()
for (let t = dt; t <= minutes * 60 + 1e-9; t += dt) {
  m.step(dt); m.time = Math.round(t * 1000) / 1000; steps++
  const r = m.rotation
  let zMax = 0
  for (let i = k2 * layer; i < (k5 + 1) * layer; i++) if (m.zeta[i] > zMax) zMax = m.zeta[i]
  const now = { uh: r.uh, uhMeso: r.uh, uh03: r.uh03, uh01: r.uh01, core: r.coreZeta, zeta: zMax }
  for (const k in watched) { peak[k] = Math.max(peak[k], now[k]); run[k] = now[k] >= watched[k] ? run[k] + dt : 0; longest[k] = Math.max(longest[k], run[k]) }
  if (Math.round(m.time) % 60 === 0) {
    const d = m.diagnostics(); w = Math.max(w, d.updraft)
    if (!Number.isFinite(d.updraft)) { console.log(`blow-up at ${m.time} s`); break }
    const km = m.turbulence.km
    for (let z = 0; z < g.nz; z++) { const cap = .05 * Math.min(g.dx, g.dy, z > 0 ? g.dzs[z - 1] : Infinity, z < g.nz - 1 ? g.dzs[z] : Infinity) ** 2 / dt; for (let i = z * layer; i < (z + 1) * layer; i++) if (km[i] > 1) { counted++; if (km[i] >= cap * .999) capped++ } }
  }
}
const f = m.flashCount, ms = (performance.now() - t0) / steps
const show = (k, digits = 0, scale = 1) => `${(peak[k] * scale).toFixed(digits)} (${longest[k]} s)`
console.log(`${s.name} | ${domain} ${(g.dx / 1000).toFixed(2)} km dt ${dt} s ${minutes} min${start ? ` start ${start}` : ""} | w ${w.toFixed(1)} | UH25 ${show('uh')} | UH03 ${show('uh03')} | UH01 ${show('uh01')} | coreZeta e-3 ${show('core', 1, 1e3)} | zeta25 e-3 ${show('zeta', 1, 1e3)} | meso label ${m.rotation.persisted >= MESO_PERSISTENCE ? 'yes' : 'no'} (threshold ${(m.rotation.mesoZeta * 1e3).toFixed(1)}e-3) | flashes IC ${f.ic} CG ${f.cg} | clipped ${m.clipped} | K capped ${(100 * capped / Math.max(1, counted)).toFixed(2)} % | ${ms.toFixed(0)} ms/step`)
