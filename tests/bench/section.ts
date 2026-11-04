// @ts-nocheck
// The radar section made of the radar's own samples (PPI.crossSection with bins) on a real run: from the site through the
// strongest echo, for the WSR-88D, DMRL-C and mobile X; the fields go to a file for a plot.
//   npx vite build --ssr tests/bench/section.ts --outDir .bench/section && node .bench/section/section.js [scenario=2] [minutes=30] [out=file]
import { writeFileSync } from 'node:fs'
import { AtmosphereModel, createGrid, domainGrid, DT, PPI, RADARS, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const option = (name, d) => process.argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? d
const scenario = SCENARIOS[Number(option('scenario', 2))], minutes = Number(option('minutes', 30)), out = option('out', '.bench/section.bin')
const config = { ...SUMMER_DAY, ...scenario.values }, model = new AtmosphereModel(config, createGrid(domainGrid(config.domain)))
const ppi = new PPI(model, Math.round(model.grid.width / 500), Math.round(model.grid.depth / 500))
for (let t = DT; t <= minutes * 60; t += DT) { model.step(DT); model.time += DT }
const dz = 125, step = 125, rows = 144, parts = [], heads = []
for (const key of ['wsr88d', 'dmrl', 'x']) {
  const p = RADARS[key]; ppi.setProfile(p); ppi.bins = { gate: Math.max(p.gate, 250), beam: p.step }; ppi.layout(); ppi.prepare(); ppi.composite()
  let best = 0, at = 0; ppi.compositeDbz.forEach((d, i) => { if (d > best) { best = d; at = i } })
  const g = ppi.ground(at % ppi.w, Math.floor(at / ppi.w)), r = Math.hypot(g.x - ppi.site.x, g.y - ppi.site.y) || 1, far = Math.min(r + 8000, p.range)
  const b = { x: ppi.site.x + (g.x - ppi.site.x) / r * far, y: ppi.site.y + (g.y - ppi.site.y) / r * far }, gates = Math.ceil(far / step)
  const { dbz } = ppi.crossSection(ppi.site, b, gates, dz, rows)
  parts.push(Buffer.from(dbz.buffer)); heads.push({ name: p.name, gates, rows, dz, far })
}
writeFileSync(out, Buffer.concat([Buffer.from(JSON.stringify(heads) + '\n'), ...parts]))
console.log(heads)
