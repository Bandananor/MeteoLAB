// @ts-nocheck
// A scenario on a finer horizontal grid (SimConfig.spacing, roadmap C2 / A2): the cost per step and the memory, and
// whether the run stays sane (clipped, the eddy viscosity's stability cap, NaN):
//   npx vite build --ssr tests/bench/fine.ts --outDir .bench/fine && node .bench/fine/fine.js <scenario index> <spacing km|-> <dt> [minutes=20]
import { AtmosphereModel, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const [index, spacingArg, dtArg, minutesArg] = process.argv.slice(2), s = SCENARIOS[Number(index)]
const spacing = spacingArg === '-' ? undefined : Number(spacingArg), dt = Number(dtArg), minutes = Number(minutesArg ?? 20)
const mem0 = process.memoryUsage(), built = performance.now()
const model = new AtmosphereModel({ ...SUMMER_DAY, ...s.values, spacing })
const g = model.grid, mem1 = process.memoryUsage(), mb = (b: number) => (b / 2 ** 20).toFixed(0)
console.log(`${s.name}: ${g.nx} x ${g.ny} x ${g.nz} = ${(g.n / 1e6).toFixed(2)} M nodes, dx ${g.dx.toFixed(0)} dy ${g.dy.toFixed(0)} m, dt ${dt} s; built in ${((performance.now() - built) / 1000).toFixed(1)} s, memory +${mb(mem1.rss - mem0.rss)} MB rss (${mb(mem1.arrayBuffers)} MB arrays)`)
let maxW = 0, maxUH = 0, longest = 0, capped = 0, counted = 0, next = 0, steps = 0
const t0 = performance.now()
for (let t = 0; t < minutes * 60; t += dt) {
  model.step(dt); model.time += dt; steps++
  maxUH = Math.max(maxUH, model.rotation.uh); longest = Math.max(longest, model.rotation.persisted)
  if (t >= next) {
    next += 60; maxW = Math.max(maxW, model.diagnostics().updraft)
    const km = model.turbulence.km
    for (let z = 0; z < g.nz; z++) { const cap = .05 * Math.min(g.dx, g.dy, z > 0 ? g.dzs[z - 1] : Infinity, z < g.nz - 1 ? g.dzs[z] : Infinity) ** 2 / dt; for (let i = z * g.layer; i < (z + 1) * g.layer; i++) if (km[i] > 1) { counted++; if (km[i] >= cap * .999) capped++ } }
    if (!Number.isFinite(maxW)) { console.log('blow-up at', t); break }
    console.log(`  ${(t / 60).toFixed(0)} min: w ${model.diagnostics().updraft.toFixed(1)} m/s, ${((performance.now() - t0) / steps).toFixed(0)} ms/step`)
  }
}
const ms = (performance.now() - t0) / steps
console.log(`${s.name} spacing ${spacing ?? 'default'} dt ${dt}: max w ${maxW.toFixed(1)} m/s, max UH ${maxUH.toFixed(0)}, mesocyclone ${longest} s, clipped ${model.clipped}, K capped ${(100 * capped / Math.max(1, counted)).toFixed(2)} %, ${ms.toFixed(0)} ms/step = ${(ms / dt / 1000).toFixed(2)} s of compute per model second, peak rss ${mb(process.memoryUsage().rss)} MB`)
