// @ts-nocheck
// A squall line by the numbers after Weisman & Rotunno (2004): src/validation/squall.ts (the set-up and what is
// measured), printed every `every` minutes. The long validation cases (cases.ts LONG_CASES) run the same.
//   npx vite build --ssr tests/bench/lines.ts --outDir .bench/lines && node .bench/lines/lines.js [us=15] [depth=2.5] [dx=1] [hours=4] [every=30] [threads=4] [speed=12.5] [size=288x72] [qv=14]
import { isMainThread, Worker, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { AtmosphereModel } from '../../src/core'
import { AttachedMemory, controlBuffer, serveTasks, ThreadRunner } from '../../src/core/threads'
import { squallGrid, squallLine } from '../../src/validation/squall'

const option = (name, d) => process.argv.slice(2).find(a => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? d

if (!isMainThread) {
  const { config, buffers, control } = workerData
  serveTasks(new AtmosphereModel(config, squallGrid(config), undefined, { memory: new AttachedMemory(buffers), attach: true }), control)
} else {
  const threads = Number(option('threads', 4)), t0 = performance.now()
  const options = { us: Number(option('us', 15)), depth: Number(option('depth', 2.5)), dx: Number(option('dx', 1)), hours: Number(option('hours', 4)), every: Number(option('every', 30)), speed: Number(option('speed', 12.5)), size: option('size', '288x72').split('x').map(Number), qv: Number(option('qv', 14)) }
  const spawn = (model, config, memory) => {
    if (threads < 2) return () => {}
    const control = controlBuffer(), helpers = []
    for (let k = 0; k < threads - 1; k++) helpers.push(new Worker(fileURLToPath(import.meta.url), { workerData: { config: structuredClone(config), buffers: memory.buffers, control } }))
    const runner = new ThreadRunner(model, control, threads - 1)
    model.transportSlabs = 10; model.runner = runner
    const g = model.grid, [u5] = model.env.windUV(5000)
    console.log(`us ${options.us} over ${options.depth} km, dx ${g.dx / 1000} km, ${g.nx} x ${g.ny} x ${g.nz}; dU 0-5 ${u5.toFixed(1)} m/s; frame ${options.speed} m/s`)
    return () => { runner.stop(); for (const h of helpers) void h.terminate() }
  }
  squallLine(options, spawn, s => {
    const f = s.front
    const line = f ? `front ${f.km.toFixed(0)} km, speed ${f.speed.toFixed(1)}, th' ${f.thetaMin.toFixed(1)}, C ${f.c.toFixed(1)} (integral ${f.cIntegral.toFixed(1)}), H ${f.h.toFixed(1)} km, C/dU ${f.cdU25.toFixed(2)} (0-5 km ${f.cdU5.toFixed(2)}), tilt ${f.tilt.toFixed(0)} km (behind front ${f.behind15.toFixed(0)} at 1.5 km, ${f.behind6.toFixed(0)} at 6 km; y-mean w ${f.w15.toFixed(1)}, ${f.w6.toFixed(1)})` : 'no cold pool'
    console.log(`${s.minutes} min: ${line}, w max ${s.wMax.toFixed(0)}, rows ${(100 * s.rows).toFixed(0)} %, gust ${s.gust.toFixed(0)}, ${((performance.now() - t0) / 60000).toFixed(0)} min of wall time`)
  })
  process.exit(0)
}
