// @ts-nocheck
// Lightning against the grid spacing and the time step (plan 2.11): a scenario's flashes with what each did — the charge
// it neutralized (IC, each sign) or lowered (CG), its channel's nodes and length — and how often a step hit its limit (flashLimit)
// (the storm wanted more flashes than a step allows), with the storm's own charge (the largest |rho| and its integral
// of each sign) so a change in the flashes can be told from a change in the charging:
//   npx vite build --ssr tests/bench/flashgrid.ts --outDir .bench/flashgrid && node .bench/flashgrid/flashgrid.js <scenario index> [spacing=km] [dt=s] [minutes=40] [domain=large]
import { AtmosphereModel, flashLimit, Lightning, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const args = process.argv.slice(2), s = SCENARIOS[Number(args[0])], opt = (k, d) => args.find(x => x.startsWith(`${k}=`))?.slice(k.length + 1) ?? d
const spacing = Number(opt('spacing', 0)) || undefined, dt = Number(opt('dt', 3)), minutes = Number(opt('minutes', 40)), domain = opt('domain', 'large')
const m = new AtmosphereModel({ ...SUMMER_DAY, ...structuredClone(s.values), domain, spacing })
const g = m.grid, cell = (i) => g.dx * g.dy * g.hz[Math.floor(i / g.layer)]
const flashes = [], perStep = []
// The model makes its Lightning on the first electrified step: catch every discharge through the class.
const discharge = Lightning.prototype.discharge
let lightning
Lightning.prototype.discharge = function (...a) { lightning = this; const f = discharge.apply(this, a); perStep.push(f.length); flashes.push(...f); return f }
let qPos = 0, qNeg = 0, rhoMax = 0
for (let t = dt; t <= minutes * 60 + 1e-9; t += dt) {
  m.step(dt); m.time = Math.round(t * 1000) / 1000
  if (lightning && Math.round(m.time) % 300 === 0) {
    let p = 0, n = 0, r = 0
    const rho = lightning.rho
    for (let i = 0; i < rho.length; i++) { const q = rho[i] * cell(i); if (q > 0) p += q; else n -= q; r = Math.max(r, Math.abs(rho[i])) }
    qPos = Math.max(qPos, p); qNeg = Math.max(qNeg, n); rhoMax = Math.max(rhoMax, r)
  }
}
const median = (a) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[b.length >> 1] }
const ic = flashes.filter(f => f.kind === 'IC'), cg = flashes.filter(f => f.kind === 'CG')
const active = perStep.filter(n => n > 0), saturated = perStep.filter(n => n >= flashLimit(dt)).length
const minutesActive = flashes.length ? (flashes[flashes.length - 1].time - flashes[0].time) / 60 : 0
console.log(`${s.name} | ${domain} ${(g.dx / 1000).toFixed(2)} km dt ${dt} s ${minutes} min | IC ${ic.length} CG ${cg.length} (+CG ${cg.filter(f => f.charge > 0).length}) | ${(flashes.length / Math.max(1, minutesActive)).toFixed(0)} per min over ${minutesActive.toFixed(0)} min | IC charge median ${median(ic.map(f => f.charge)).toFixed(2)} C, CG |charge| median ${median(cg.map(f => Math.abs(f.charge))).toFixed(2)} C | nodes median IC ${median(ic.map(f => f.nodes.length))} CG ${median(cg.map(f => f.nodes.length))} | steps with flashes ${active.length}, mean ${(active.reduce((a, b) => a + b, 0) / Math.max(1, active.length)).toFixed(2)} per step, at the limit ${saturated} | storm charge max +${qPos.toFixed(0)} / -${qNeg.toFixed(0)} C, |rho| max ${(rhoMax * 1e9).toFixed(1)} nC/m3`)
