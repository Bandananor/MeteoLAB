// @ts-nocheck
// Scouting the diurnal cycle: a dawn start (hour 6) with a night inversion and no thermal; the sun burns the inversion
// off, a mixed layer grows, cumulus form and some of them become thunderstorms. Every 15 model minutes: local time, the
// surface sensible flux, the near-ground air against the day profile, how strong the inversion still is, the mixed
// layer top, cloud cover, the strongest updraught and cloud top, rain and the cells (numbered = deep convection).
//   npx vite build --ssr tests/bench/diurnal.ts --outDir .bench/diurnal && node .bench/diurnal/diurnal.js <variant> [hours=9] [env]
import { AtmosphereModel, CellTracker, createGrid, DEFAULT_GRID, DT, Environment, parcelIndices, surfaceFluxes } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'
import { SCENARIOS } from '../../src/core/scenarios'

const DAWN = SCENARIOS.find(s => s.name === 'Суточный ход').values
// The scenario; with the moist layer (eddies at its top before sunrise, wisps of cloud by 07:30); with the 1 K lid of
// «Летний день» (the mixed layer stops under it, no cloud all day); a stronger night inversion.
export const VARIANTS = [DAWN, { ...DAWN, moistLayer: 1 }, { ...DAWN, capStrength: 1, capHeight: 1.4 }, { ...DAWN, nightInversion: 8 }]
const [variant, hours = 9] = process.argv.slice(2).map(Number), envOnly = process.argv.includes('env')
const config = { ...SUMMER_DAY, ...VARIANTS[variant] }, grid = createGrid(DEFAULT_GRID), env = new Environment(config, grid)
const i = parcelIndices(env, grid.height), day = new Environment({ ...config, nightInversion: 0 }, grid), d = parcelIndices(day, grid.height)
console.log(`variant ${variant}: dawn SB CAPE ${i.sb.cape.toFixed(0)} CIN ${i.sb.cin.toFixed(0)} (ground ${env.temperatureEnv(0).toFixed(1)} °C, Td ${env.dewpoint(env.qEnv(0), 0).toFixed(1)}); day SB CAPE ${d.sb.cape.toFixed(0)} CIN ${d.sb.cin.toFixed(0)}`)
if (!envOnly) {
  const model = new AtmosphereModel(config, grid), cells = new CellTracker(), { nz, layer, zs } = grid, t0 = performance.now()
  const mean = (f, k) => { let s = 0; for (let j = k * layer; j < (k + 1) * layer; j++) s += f[j]; return s / layer }
  const k400 = zs.findIndex(z => z >= 400)
  let firstCloud = NaN, firstCell = NaN
  for (let t = DT; t <= hours * 3600; t += DT) {
    model.step(DT); model.time += DT
    if (t % 60) continue
    cells.update(model)
    const diag = model.diagnostics()
    if (Number.isNaN(firstCloud) && diag.maxCloud > 1e-4) firstCloud = t
    if (Number.isNaN(firstCell) && cells.cells.length) firstCell = t
    if (t % 900) continue
    // Mixed-layer top: lowest level where the mean theta exceeds the ground level's by 0.5 K.
    const th0 = mean(model.theta, 0); let top = 0
    for (let k = 1; k < nz; k++) if (mean(model.theta, k) > th0 + .5) { top = zs[k]; break }
    let cover = 0
    for (let c = 0; c < layer; c++) for (let k = 0; k < nz; k++) if (model.cloud[c + k * layer] + model.ice[c + k * layer] > 1e-5) { cover++; break }
    const hour = config.hour + t / 3600, hh = Math.floor(hour), mm = Math.round((hour - hh) * 60), flux = surfaceFluxes(config, model.time)
    console.log(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} H ${flux.sensible.toFixed(0)} W/m2, ground theta ${(th0 - day.thetaEnv(zs[0])).toFixed(1)} K vs day, theta(400 m) - ground ${(mean(model.theta, k400) - th0).toFixed(1)} K, mixed to ${(top / 1000).toFixed(1)} km, cover ${(100 * cover / layer).toFixed(0)} %, w ${diag.updraft.toFixed(1)}, top ${diag.cloudTop.toFixed(1)} km, rain ${diag.rainTotal.toFixed(1)} mm, cells ${cells.cells.length} (+${cells.unnumbered}), ${((performance.now() - t0) / 1000).toFixed(0)} s`)
  }
  const at = s => Number.isNaN(s) ? 'never' : `${(config.hour + s / 3600).toFixed(2)} h`
  console.log(`first cloud ${at(firstCloud)}, first thunderstorm ${at(firstCell)}`)
}
