// @ts-nocheck
// The organisation classifier (src/core/organization.ts) on a real run: every `every` model minutes what EchoTracker sees.
//   npx vite build --ssr tests/bench/organize.ts --outDir .bench/organize && node .bench/organize/organize.js [scenario=name] [minutes=240] [every=30] [threads=6] [dx=KM]
//   or on the dumps of tests/bench/bow.ts: node .bench/organize/organize.js dumps=DIR (their dBZ is the column's strongest)
import { isMainThread, Worker, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync } from 'node:fs'
import { AtmosphereModel, classifyEcho, createGrid, domainGrid, DT, EchoTracker, lowEcho, SCENARIOS } from '../../src/core'
import { AttachedMemory, controlBuffer, serveTasks, SharedMemory, ThreadRunner } from '../../src/core/threads'
import { SUMMER_DAY } from '../../src/core/fixtures'

const gridOf = c => createGrid(domainGrid(c.domain, c.top, c.domainSize, c.spacing))
const line = o => `${o.kind}${o.held === false ? '?' : ''} ${o.length.toFixed(0)} km, ${o.aspect.toFixed(1)}:1, s/c ${o.sagitta.toFixed(2)}, ${o.peak.toFixed(0)} dBZ, cores ${o.cores}${o.stratiform ? `, ${o.stratiform}` : ''}${o.minutes !== undefined ? `, ${o.minutes.toFixed(0)} min` : ''}${o.dynamics ? `, C ${o.dynamics.c.toFixed(0)} / ${o.dynamics.shear.toFixed(0)} = ${o.dynamics.balance.toFixed(2)}, ${o.dynamics.depth.toFixed(1)} km, rear ${o.dynamics.rear.toFixed(0)} (front ${o.dynamics.atFront.toFixed(0)})${o.dynamics.bookends ? ', bookends' : ''}` : ''}`
const option = (name, d) => process.argv.slice(2).find(a => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? d

if (!isMainThread) {
  const { config, buffers, control } = workerData
  serveTasks(new AtmosphereModel(config, gridOf(config), undefined, { memory: new AttachedMemory(buffers), attach: true }), control)
} else if (option('dumps', '')) {
  const dir = option('dumps', '')
  for (const f of readdirSync(dir).filter(f => f.endsWith('.bin')).sort()) {
    const raw = readFileSync(`${dir}/${f}`), cut = raw.indexOf(10), h = JSON.parse(raw.subarray(0, cut).toString()), dbz = new Float32Array(raw.buffer.slice(raw.byteOffset + cut + 1, raw.byteOffset + cut + 1 + 4 * h.nx * h.ny))
    console.log(`${h.t} min: ${classifyEcho(dbz, h.nx, h.ny, h.dx / 1000, h.dy / 1000, [1, 0]).slice(0, 4).map(line).join(' | ')}`)
  }
  process.exit(0)
} else {
  const s = SCENARIOS.find(x => x.name === option('scenario', 'Bow echo')), dx = Number(option('dx', 0)), threads = Number(option('threads', 6)), minutes = Number(option('minutes', 240)), every = Number(option('every', 30))
  const config = { ...SUMMER_DAY, ...s.values, ...(dx ? { spacing: dx } : {}) }, memory = new SharedMemory(), model = new AtmosphereModel(structuredClone(config), gridOf(config), undefined, { memory })
  const control = controlBuffer(), helpers = []
  for (let k = 0; k < threads - 1; k++) helpers.push(new Worker(fileURLToPath(import.meta.url), { workerData: { config: structuredClone(config), buffers: memory.buffers, control } }))
  if (threads > 1) { model.transportSlabs = 10; model.runner = new ThreadRunner(model, control, threads - 1) }
  const tracker = new EchoTracker()
  for (let t = DT; t <= minutes * 60; t += DT) {
    model.step(DT); model.time += DT
    if (t % 300) continue
    const o = tracker.update(model)
    if (t % (every * 60) === 0) { const e = lowEcho(model); let top = -99, a = 0, b = 0; for (const d of e) { if (d > top) top = d; if (d >= 40) a++; if (d >= 20) b++ } console.log(`${t / 60} min (low max ${top.toFixed(0)} dBZ, ${a} nodes >= 40, ${b} >= 20, w max ${Math.max(...model.w).toFixed(0)}): ${o.slice(0, 4).map(line).join(' | ') || 'no echo'}`) }
  }
  process.exit(0)
}
