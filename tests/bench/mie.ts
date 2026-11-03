// @ts-nocheck
// Mie against Rayleigh reflectivity (src/core/mie.ts, PPI.mie) on a real run: every `every` model minutes, for the S, C
// and X radars, the strongest composite echo, the area of >= 55 dBZ and the area the phenomena map marks hail (codes
// 13-15), Rayleigh / Mie. No attenuation, so only the scattering differs.
//   npx vite build --ssr tests/bench/mie.ts --outDir .bench/mie && node .bench/mie/mie.js [scenario=0] [minutes=60] [every=10]
import { AtmosphereModel, createGrid, domainGrid, DT, PPI, RADARS, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const option = (name, d) => process.argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? d
const scenario = SCENARIOS[Number(option('scenario', 0))], minutes = Number(option('minutes', 60)), every = Number(option('every', 10))
const config = { ...SUMMER_DAY, ...scenario.values }, model = new AtmosphereModel(config, createGrid(domainGrid(config.domain)))
const ppi = new PPI(model, Math.round(model.grid.width / 500), Math.round(model.grid.depth / 500)), motion = Math.hypot(...model.frame)
ppi.bins = null
console.log(scenario.name)
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % (every * 60)) continue
  const px = (model.grid.width / ppi.w) * (model.grid.depth / ppi.h) / 1e6, cells = []
  for (const key of ['wsr88d', 'dmrl', 'x']) {
    const seen = []
    for (const mie of [false, true]) {
      ppi.setProfile(RADARS[key]); ppi.mie = mie; ppi.layout(); ppi.prepare(); ppi.composite(); ppi.phenomena(motion)
      let strong = 0, hail = 0
      for (let i = 0; i < ppi.compositeDbz.length; i++) { if (ppi.compositeDbz[i] >= 55) strong += px; if (ppi.codes[i] >= 13 && ppi.codes[i] <= 15) hail += px }
      seen.push({ max: Math.max(...ppi.compositeDbz), strong, hail })
    }
    cells.push(`${RADARS[key].band}: CR max ${seen[0].max.toFixed(0)} / ${seen[1].max.toFixed(0)}, >= 55 dBZ ${seen[0].strong.toFixed(0)} / ${seen[1].strong.toFixed(0)} km², hail ${seen[0].hail.toFixed(0)} / ${seen[1].hail.toFixed(0)} km²`)
  }
  console.log(`${t / 60} min (Rayleigh / Mie) | ${cells.join(' | ')}`)
}
