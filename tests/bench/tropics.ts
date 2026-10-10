// @ts-nocheck
// Scouting the tropical scenario: ocean, moist to 5-6 km, a ~16 km tropopause under a 22 km top, weak trade wind.
// Its CAPE and precipitable water, then every 5 model minutes the strongest updraught, the cloud top, rain, the cold pool.
//   npx vite build --ssr tests/bench/tropics.ts --outDir .bench/tropics && node .bench/tropics/tropics.js <variant> [minutes=40] [env]
import { AtmosphereModel, createGrid, domainGrid, DT, Environment, parcelIndices, skewIndices } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const TROPICS = {
  surfaceTemp: 28, lapseLow: 6.3, lapseMid: 5.6, lapseUpper: 7.5, tropopause: 16, stratoWarming: 1.5, top: 22,
  rhSurface: 80, rhLow: 80, rhMid: 75, rhUpper: 50, moistLayer: .5, capStrength: 0, surfaceType: 'water', latitude: 15,
  wind0: 4, windDir0: 90, wind3: 6, windDir3: 100, wind6: 7, windDir6: 110, wind10: 9, windDir10: 120, bubbleRadius: 2.5, bubble: 1.2,
}
export const VARIANTS = [TROPICS, { ...TROPICS, rhMid: 65 }, { ...TROPICS, surfaceTemp: 28.5 }, { ...TROPICS, surfaceTemp: 27.5 }]
const [variant, minutes = 40] = process.argv.slice(2).map(Number), envOnly = process.argv.includes('env')
const config = { ...SUMMER_DAY, ...VARIANTS[variant] }, grid = createGrid(domainGrid(undefined, config.top))
const env = new Environment(config, grid), i = parcelIndices(env, grid.height), s = skewIndices(env, grid.height)
console.log(`variant ${variant}: SB CAPE ${i.sb.cape.toFixed(0)} CIN ${i.sb.cin.toFixed(0)}, ML CAPE ${i.ml.cape.toFixed(0)}, EL ${i.sb.el?.toFixed(1)} km, PW ${s.pw.toFixed(0)} mm, 0 °C ${s.freezing?.toFixed(1)} km, sqrt(2 CAPE) ${Math.sqrt(2 * i.sb.cape).toFixed(0)} m/s`)
if (!envOnly) {
  const model = new AtmosphereModel(config, grid)
  let peakW = 0, longest = 0
  for (let t = DT; t <= minutes * 60; t += DT) {
    model.step(DT); model.time += DT; longest = Math.max(longest, model.rotation.persisted)
    if (t % 300) continue
    const d = model.diagnostics(); peakW = Math.max(peakW, d.updraft)
    console.log(`${t / 60} min: w ${d.updraft.toFixed(1)}, top ${d.cloudTop.toFixed(1)} km, rain ${d.rainTotal.toFixed(1)} mm (rate ${d.rainRate.toFixed(0)} mm/h), cold ${d.coldMax.toFixed(1)} K, UH ${model.rotation.uh.toFixed(0)}, meso ${longest} s, clipped ${model.clipped}`)
  }
}
