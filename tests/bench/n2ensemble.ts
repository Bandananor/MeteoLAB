// @ts-nocheck
// One member of the ensembles behind the choice of the cloud's stability in the eddy viscosity (turbulence.ts
// moistStability; README 10.11.2026): the Weisman-Klemp split of the validation report or the «Высотная ложбина»
// situation with another seed (the noise in theta and the ground's pattern). The formula comes from the environment,
// as in a whole run: STORMLAB_MOISTN2=dk for Durran & Klemp's, nothing for g / theta_e d theta_e / dz.
//   npx vite build --ssr tests/bench/n2ensemble.ts --outDir .bench/n2ens && node .bench/n2ens/n2ensemble.js wk|trough <seed>
import { AtmosphereModel, createGrid, DT, LARGE_GRID, SCENARIOS, weismanKlemp } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'
import { situationRun, updraftCores } from '../../src/validation/cases'

const [which, seedArg] = process.argv.slice(2), seed = Number(seedArg ?? SUMMER_DAY.seed), formula = process.env.STORMLAB_MOISTN2 === 'dk' ? 'dk' : 'thetae'
const run = (model, seconds) => { for (let k = 0; k < seconds; k += DT) { model.step(DT); model.time += DT } }
if (which === 'wk') {
  // As weismanKlempSplit (cases.ts), with the seed.
  const model = new AtmosphereModel({ ...SUMMER_DAY, solarMax: 0, bubble: 0, seed }, createGrid(LARGE_GRID), weismanKlemp({ qvMax: .016 }))
  model.transport = 'weno'
  model.injectBubble(model.grid.width * .3, model.grid.depth * .5, 1.5)
  run(model, 35 * 60)
  const cores = updraftCores(model, 4500, 8), [right, left] = [...cores.slice(0, 2)].sort((a, b) => a.y - b.y)
  run(model, 25 * 60)
  const w60 = updraftCores(model, 4500, 0)[0]?.w ?? 0
  console.log(`wk ${formula} seed ${seed}: cores ${cores.length}, separation ${left && right ? ((left.y - right.y) / 1000).toFixed(1) : '-'} km, right w ${right?.w.toFixed(1)} UH ${right?.uh.toFixed(0)}, left w ${left?.w.toFixed(1)} UH ${left?.uh.toFixed(0)}, w at 60 min ${w60.toFixed(1)}`)
} else if (which === 'trough') {
  const values = SCENARIOS.find(s => s.name === 'Высотная ложбина').values, r = situationRun({ ...values, seed }, 180, 130, 170)
  console.log(`trough ${formula} seed ${seed}: max w ${r.maxW.toFixed(1)}, top ${r.top.toFixed(1)} km, 12:10-12:50 mean w ${r.late.toFixed(2)}, heaviest rain ${r.lateRain.toFixed(1)} mm/h`)
} else console.log('wk | trough, then a seed')
