// @ts-nocheck
// Э3 step 1 check (16.11.2026): the transport tendency of every carried field on the GPU (src/gpu/transport.ts) against
// the TypeScript core (FluxTransport.tendency) on a storm, and their times. In a browser with WebGPU:
//   npx vite, then open /tests/bench/gpucheck.html[?scenario=<name>&minutes=20] — the result in window.__gpucheck
// (headless: tools/cdp.mjs; Chrome takes the integrated GPU unless started with --force_high_performance_gpu).
import { AtmosphereModel, DT, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'
import { GpuTransport } from '../../src/gpu/transport'

const params = new URLSearchParams(location.search), name = params.get('scenario') ?? 'Классическая суперячейка', minutes = Number(params.get('minutes') ?? 20)
const out = document.getElementById('out'), log = (s: string) => { out.textContent += '\n' + s }
const result: any = { scenario: name, minutes, fields: [] }
;(window as any).__gpucheck = result
try {
  const config = { ...SUMMER_DAY, ...SCENARIOS.find(s => s.name === name).values }, model = new AtmosphereModel(config)
  for (let t = 0; t < minutes * 60; t += DT) { model.step(DT); model.time += DT }
  log(`stepped to ${minutes} min`)
  const flux = model['flux'], grid = model.grid, { n, nz } = grid
  flux.setVelocity(model.u, model.v, model.w)
  const carried = model['carried']()
  const gpu = await GpuTransport.create(grid, model.env.rho)
  result.adapter = gpu.adapter
  gpu.setFaces(flux['mx'], flux['my'], flux['mz'], flux['div'])
  // CPU tendencies (float64), timed.
  const cpu = carried.map(() => new Float64Array(n))
  let cpuMs = Infinity
  for (let rep = 0; rep < 3; rep++) { const t0 = performance.now(); carried.forEach((c, k) => flux.tendency(c.field, cpu[k], 0, nz, c.monotone)); cpuMs = Math.min(cpuMs, performance.now() - t0) }
  let gpuMs = Infinity, tend: Float32Array[] = []
  for (let rep = 0; rep < 5; rep++) { const r = await gpu.tendencies(carried.map(c => ({ q: c.field, monotone: c.monotone }))); gpuMs = Math.min(gpuMs, r.gpuMs); tend = r.tend }
  result.cpuMs = +cpuMs.toFixed(1); result.gpuMs = +gpuMs.toFixed(2); result.speedup = +(cpuMs / gpuMs).toFixed(1)
  const names = ['u', 'v', 'w', 'theta', 'q', 'cloud', 'rain', 'ice', 'iceNumber', 'snow', 'graupel', 'hail', 'cold', 'chargeIce', 'chargeGraupel', 'chargeRain', 'chargeAir']
  carried.forEach((c, k) => {
    const label = names.find(f => model[f] === c.field) ?? `#${k}`
    let scale = 0, err = 0, sq = 0, sqs = 0
    for (let i = 0; i < n; i++) { const a = cpu[k][i], b = tend[k][i]; scale = Math.max(scale, Math.abs(a)); err = Math.max(err, Math.abs(a - b)); sq += (a - b) ** 2; sqs += a * a }
    const row = { field: label, monotone: c.monotone, maxRel: scale ? +(err / scale).toExponential(2) : 0, rmsRel: sqs ? +Math.sqrt(sq / sqs).toExponential(2) : 0 }
    result.fields.push(row); log(JSON.stringify(row))
  })
  // Step 2: the three RK3 stages of the scalar fields (all but u, v, w) by DT, as the model does them (float64
  // tendencies, float32 fields), against the GPU's; theta on the GPU as its departure from the base profile, the
  // profile's own tendency added in float64 from the CPU.
  const scalars = carried.filter(c => c.field !== model.u && c.field !== model.v && c.field !== model.w)
  const RK = [1 / 3, 1 / 2, 1], ref = scalars.map(c => Float32Array.from(c.field))
  let cpuStep = 0
  {
    const t0 = performance.now(), tend = new Float64Array(n)
    scalars.forEach((c, k) => { const a = ref[k], start = Float32Array.from(a); for (const f of RK) { flux.tendency(a, tend, 0, nz, c.monotone); for (let i = 0; i < n; i++) a[i] = start[i] + f * DT * tend[i] } })
    cpuStep = performance.now() - t0
  }
  const layer = grid.layer, thetaEnv = new Float32Array(n), thetaPert = new Float32Array(n), envTend = new Float64Array(n)
  for (let i = 0; i < n; i++) { const z = Math.floor(i / layer); thetaEnv[i] = model.env.theta[z]; thetaPert[i] = model.theta[i] - model.env.theta[z] }
  flux.tendency(thetaEnv, envTend, 0, nz, false)
  const extra = Float32Array.from(envTend)
  const inputs = scalars.map(c => c.field === model.theta ? { q: thetaPert, monotone: c.monotone, extra } : { q: c.field, monotone: c.monotone })
  let gpuStep = Infinity, after: Float32Array[] = []
  for (let rep = 0; rep < 4; rep++) { const r = await gpu.rk3(inputs, DT); gpuStep = Math.min(gpuStep, r.gpuMs); after = r.fields }
  result.step = { cpuMs: +cpuStep.toFixed(1), gpuMs: +gpuStep.toFixed(2), fields: [] }
  scalars.forEach((c, k) => {
    const label = names.find(f => model[f] === c.field) ?? `#${k}`, theta = c.field === model.theta
    let scale = 0, err = 0
    for (let i = 0; i < n; i++) {
      const before = c.field[i], cpuNew = ref[k][i], gpuNew = theta ? after[k][i] + thetaEnv[i] : after[k][i]
      scale = Math.max(scale, Math.abs(cpuNew - before)); err = Math.max(err, Math.abs(gpuNew - cpuNew))
    }
    const row = { field: label, changeMax: +scale.toExponential(2), maxRelOfChange: scale ? +(err / scale).toExponential(2) : 0 }
    result.step.fields.push(row); log('step ' + JSON.stringify(row))
  })
  result.errors = gpu.errors.slice(0, 5)
  log(`CPU ${result.cpuMs} ms, GPU ${result.gpuMs} ms for ${carried.length} fields (${result.adapter})`)
} catch (e) { result.error = String(e?.stack ?? e); log(result.error) }
result.done = true
