// @ts-nocheck
// The phenomena map (src/core/phenomena.ts) on a real run: every `every` model minutes the area of each code (km²) as
// the chosen radar sees it from the domain's middle, the levels it used, and the strongest echo.
//   npx vite build --ssr tests/bench/phenomena.ts --outDir .bench/phenomena && node .bench/phenomena/phenomena.js [scenario=0] [minutes=60] [every=10] [radar=dmrl]
import { AtmosphereModel, createGrid, domainGrid, DT, PHENOMENA, PPI, RADARS, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const option = (name, d) => process.argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? d
const scenario = SCENARIOS[Number(option('scenario', 0))], minutes = Number(option('minutes', 60)), every = Number(option('every', 10)), radar = RADARS[option('radar', 'dmrl')]
const config = { ...SUMMER_DAY, ...scenario.values }, model = new AtmosphereModel(config, createGrid(domainGrid(config.domain)))
const ppi = new PPI(model, Math.round(model.grid.width / 500), Math.round(model.grid.depth / 500)), motion = model.frame
ppi.setProfile(radar); ppi.bins = null; ppi.layout()
console.log(`${scenario.name} · ${radar.name}, cell motion ${Math.hypot(...motion).toFixed(1)} m/s`)
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % (every * 60)) continue
  ppi.composite(); const lv = ppi.phenomena(Math.hypot(...motion)), px = (model.grid.width / ppi.w) * (model.grid.depth / ppi.h) / 1e6
  const area = new Map()
  for (const c of ppi.codes) if (c) area.set(c, (area.get(c) ?? 0) + px)
  const list = [...area].sort((a, b) => a[0] - b[0]).map(([c, a]) => `${c} ${a.toFixed(0)}`).join(', ')
  console.log(`${t / 60} min: CR max ${Math.max(...ppi.compositeDbz).toFixed(0)} dBZ, top ${Math.max(...ppi.vgo).toFixed(1)} km (H0 ${lv.h0.toFixed(1)}, H-22 ${lv.h22.toFixed(1)}, trop ${lv.tropopause.toFixed(1)}) | km²: ${list || '-'}`)
}
