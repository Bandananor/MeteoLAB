// @ts-nocheck
// Echo tops on a real run (PPI.composite: ET and the DMRL-C's ВГО): along one radial from the radar, every 2 km, the
// strongest echo, ET and ВГО with the highest tilt that had the echo — to see the stair-steps of tops taken from the beam
// heights of the tilts.
//   npx vite build --ssr tests/bench/tops.ts --outDir .bench/tops && node .bench/tops/tops.js [scenario=2] [minutes=65] [radar=dmrl] [az=0] [large]
import { AtmosphereModel, createGrid, domainGrid, DT, PPI, RADARS, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'
import { writeFileSync } from 'node:fs'

const option = (name, d) => process.argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? d
const scenario = SCENARIOS[Number(option('scenario', 2))], minutes = Number(option('minutes', 65)), az = Number(option('az', 0)) * Math.PI / 180
const config = { ...SUMMER_DAY, ...scenario.values, ...(process.argv.includes('large') ? { domain: 'large' } : {}) }, model = new AtmosphereModel(config, createGrid(domainGrid(config.domain)))
const ppi = new PPI(model, Math.round(model.grid.width / 500), Math.round(model.grid.depth / 500))
ppi.bins = null; ppi.setProfile(RADARS[option('radar', 'dmrl')]); ppi.layout()
for (let t = DT; t <= minutes * 60; t += DT) { model.step(DT); model.time += DT }
ppi.composite()
const { width, depth } = model.grid, px = width / ppi.w
let jumpEt = 0, jumpVgo = 0, n = 0
for (let y = 0; y < ppi.h; y++) for (let x = 1; x < ppi.w; x++) { const i = x + y * ppi.w; if (ppi.vgo[i] > 0 && ppi.vgo[i - 1] > 0) { jumpVgo += Math.abs(ppi.vgo[i] - ppi.vgo[i - 1]); n++ } if (ppi.echoTop[i] > 0 && ppi.echoTop[i - 1] > 0) jumpEt += Math.abs(ppi.echoTop[i] - ppi.echoTop[i - 1]) }
console.log(`mean jump between neighbouring pixels: ВГО ${(jumpVgo / n).toFixed(2)} km over ${n} pairs, ET ${(jumpEt / n).toFixed(2)} km`)
// How high the echo reaches in the model: the highest level with >= -5 and >= 18 dBZ anywhere, and the share of columns.
{ const { nz, layer, zs } = model.grid, d = ppi.nodeDbz; let h5 = 0, h18 = 0, cols = 0
  for (let z = 0; z < nz; z++) for (let c = 0; c < layer; c++) { const v = d[c + z * layer]; if (v >= -5) h5 = zs[z]; if (v >= 18) h18 = zs[z] }
  for (let c = 0; c < layer; c++) for (let z = 0; z < nz; z++) if (d[c + z * layer] >= -5) { cols++; break }
  console.log(`model echo: >= -5 dBZ up to ${(h5 / 1000).toFixed(1)} km, >= 18 up to ${(h18 / 1000).toFixed(1)} km (top ${(model.grid.height / 1000).toFixed(1)}), echo in ${(100 * cols / layer).toFixed(0)} % of columns`) }
const out = option('out', '')
if (out) writeFileSync(out, Buffer.concat([Buffer.from(JSON.stringify({ w: ppi.w, h: ppi.h }) + '\n'), Buffer.from(ppi.vgo.buffer), Buffer.from(ppi.echoTop.buffer), Buffer.from(ppi.compositeDbz.buffer)]))
console.log(`${scenario.name}, ${minutes} min, ${ppi.profile.name}; site ${(ppi.site.x / 1000).toFixed(0)}, ${(ppi.site.y / 1000).toFixed(0)} km of ${width / 1000} x ${depth / 1000}`)
for (let r = 2000; r < 80_000; r += 1000) {
  const x = ppi.site.x + r * Math.sin(az), y = ppi.site.y + r * Math.cos(az), i = Math.floor(x / px) + ppi.w * Math.floor(y / px)
  if (x < 0 || y < 0 || x >= width || y >= depth) break
  console.log(`${(r / 1000).toFixed(0).padStart(3)} km: CR ${ppi.compositeDbz[i].toFixed(0).padStart(4)}, ET ${ppi.echoTop[i].toFixed(1).padStart(5)}, ВГО ${ppi.vgo[i].toFixed(1).padStart(5)}`)
}
