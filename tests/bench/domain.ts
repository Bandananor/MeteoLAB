// @ts-nocheck
// The WK supercell on the standard and the large domain: every 5 model minutes the strongest updraught, UH, the core
// rotation, ground rain, and how much the air away from the storm (no cloud, |w| < 0.5 m/s) has warmed at 3, 6 and
// 9 km — the compensating subsidence of a periodic domain, spread over 4x less area on the standard one.
//   npx vite build --ssr tests/bench/domain.ts --outDir .bench/domain && node .bench/domain/domain.js <standard|large> [minutes=45]
import { AtmosphereModel, createGrid, DEFAULT_GRID, DT, LARGE_GRID, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const which = process.argv[2] ?? 'standard', minutes = Number(process.argv[3] ?? 45)
const model = new AtmosphereModel({ ...SUMMER_DAY, ...SCENARIOS.find(s => s.name === 'Суперячейка WK').values }, createGrid(which === 'large' ? LARGE_GRID : DEFAULT_GRID))
const { layer, zs } = model.grid
const far = (h: number) => {
  const l = zs.findIndex(z => z >= h) * layer, env = model.env.thetaEnv(zs[l / layer]); let s = 0, n = 0
  for (let c = 0; c < layer; c++) { const i = l + c; if (Math.abs(model.w[i]) < .5 && model.cloud[i] + model.ice[i] < 1e-6) { s += model.theta[i] - env; n++ } }
  return n ? s / n : NaN
}
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % 300) continue
  const d = model.diagnostics(), r = model.rotation
  console.log(`${which} ${t / 60} min: w ${d.updraft.toFixed(1)}, UH ${r.uh.toFixed(0)}, core zeta ${(r.coreZeta * 1000).toFixed(1)}e-3 held ${r.persisted} s, rain ${d.rainTotal.toFixed(1)} mm, far air theta' 3/6/9 km ${[3000, 6000, 9000].map(h => far(h).toFixed(2)).join(' / ')} K`)
}
