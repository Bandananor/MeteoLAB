// @ts-nocheck
// Where storms grow relative to a moving front (a tester 19.10.2026: «storms behind the cold front, not on it»): every
// 2 model minutes the columns with an updraught over 5 m/s at 1.5-10 km, by their distance from the front's surface line
// (km, positive ahead), the strongest one's distance, and the depth of the cold air there.
//   npx vite build --ssr tests/bench/frontcells.ts --outDir .bench/frontcells && node .bench/frontcells/frontcells.js "<scenario>" [minutes=60] [json of values to override]
import { AtmosphereModel, DT, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'
import { coldDepth, frontDistance } from '../../src/core/fronts'

const [name, minutesArg, extra] = process.argv.slice(2), minutes = Number(minutesArg ?? 60), s = SCENARIOS.find(x => x.name === name)
const config = { ...SUMMER_DAY, ...s.values, ...(extra ? JSON.parse(extra) : {}) }, model = new AtmosphereModel(config)
const { nx, ny, nz, layer, dx, dy, zs, width, depth } = model.grid, f = config.frontLine
const k0 = zs.findIndex(z => z >= 1500), k1 = zs.findIndex(z => z >= 10000)
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % 120) continue
  const [ox, oy] = model.frameOffset(), bins = new Map()
  let best = 0, bestS = NaN, bestC = -1
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let w = 0; for (let z = k0; z <= k1; z++) w = Math.max(w, model.w[x + y * nx + z * layer])
    if (w < 5) continue
    const d = frontDistance(f, x * dx + ox, y * dy + oy, model.time, width, depth), b = Math.round(d / 4) * 4
    bins.set(b, (bins.get(b) ?? 0) + 1)
    if (w > best) { best = w; bestS = d; bestC = x + y * nx }
  }
  // Where the strongest updraught is rooted: w at ~0.5 and ~1.5 km in its column, and the air's deficit (θ below the environment) at the ground.
  const at = (km: number) => bestC < 0 ? NaN : model.w[bestC + zs.findIndex(z => z >= km * 1000) * layer], deficit = bestC < 0 ? NaN : model.env.theta[1] - model.theta[bestC + layer]
  const list = [...bins].sort((a, b) => a[0] - b[0]).map(([b, n]) => `${b >= 0 ? '+' : ''}${b}:${n}`).join(' ')
  console.log(`${t / 60} min: w max ${best.toFixed(0)} m/s at ${isNaN(bestS) ? '—' : bestS.toFixed(1)} km (cold air ${isNaN(bestS) ? '—' : coldDepth(f, bestS).toFixed(1)} km; w at 0.5 / 1.5 km ${at(.5).toFixed(1)} / ${at(1.5).toFixed(1)}, θ deficit at the ground ${deficit.toFixed(1)} K) | columns by km from the front: ${list}`)
}
