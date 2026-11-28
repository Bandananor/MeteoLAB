// @ts-nocheck
// Э3 step 1 check (16.11.2026): the transport tendency of every carried field on the GPU (src/gpu/transport.ts) against
// the TypeScript core (FluxTransport.tendency) on a storm, and their times. In a browser with WebGPU:
//   npx vite, then open /tests/bench/gpucheck.html[?scenario=<name>&minutes=20&spacing=<km>] — the result in window.__gpucheck
// (headless: tools/cdp.mjs; Chrome takes the integrated GPU unless started with --force_high_performance_gpu).
import { AtmosphereModel, applyState, createGrid, domainGrid, DT, readState, saveState, SCENARIOS } from '../../src/core'
import { gpuStep as stepWithGpu } from '../../src/gpu/step'
import { SUMMER_DAY } from '../../src/core/fixtures'
import { GpuTransport } from '../../src/gpu/transport'
import { GpuElliptic } from '../../src/gpu/elliptic'
import { GpuDynamics } from '../../src/gpu/dynamics'
import { NUDGE, startOf } from '../../src/core/model'
import { ZONE_DEPTH, zoneShape } from '../../src/core/zones'

const params = new URLSearchParams(location.search), name = params.get('scenario') ?? 'Классическая суперячейка', minutes = Number(params.get('minutes') ?? 20)
const out = document.getElementById('out'), log = (s: string) => { out.textContent += '\n' + s }
const result: any = { scenario: name, minutes, fields: [] }
;(window as any).__gpucheck = result
// Preserve zero-scale mismatches and non-finite values for the automated check.
const relativeError = (error: number, scale: number) => error === 0 ? 0 : error / scale
try {
  if (params.has('report') && !await navigator.gpu?.requestAdapter()) {
    result.unavailable = 'Chrome returned no WebGPU adapter'
  } else await runCheck()
} catch (e) { result.error = String(e?.stack ?? e); log(result.error) }
result.done = true
if (params.has('report')) await fetch('/__gpucheck', { method: 'POST', body: JSON.stringify(result) })

async function runCheck() {
  const spacing = Number(params.get('spacing') ?? 0), base0 = { ...SUMMER_DAY, ...SCENARIOS.find(s => s.name === name).values }, config0 = spacing ? { ...base0, spacing } : base0
  // ?zones=1: a warm moist zone of 20 km at the domain's middle (checks the buoyancy against a zone's own air).
  const config = params.get('zones') ? { ...config0, zones: [{ points: [[10, 10], [30, 10], [30, 30], [10, 30]], temperature: 3, moisture: 2 }] } : config0
  const model = new AtmosphereModel(config, createGrid(domainGrid(config.domain, config.top, config.domainSize, config.spacing)))
  result.grid = `${model.grid.nx} x ${model.grid.ny} x ${model.grid.nz}`
  for (let t = 0; t < minutes * 60; t += DT) { model.step(DT); model.time += DT }
  log(`stepped to ${minutes} min`)
  const state = saveState(model, config)
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
    const row = { field: label, monotone: c.monotone, maxRel: relativeError(err, scale), rmsRel: Math.sqrt(relativeError(sq, sqs)) }
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
    const row = { field: label, changeMax: +scale.toExponential(2), maxRelOfChange: relativeError(err, scale) }
    result.step.fields.push(row); log('step ' + JSON.stringify(row))
  })
  // Step 3: the face projection and the pressure projection on the GPU (src/gpu/elliptic.ts).
  {
    const ell = await GpuElliptic.create(grid, model.env.rho), maxAbs = (a: ArrayLike<number>) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); return m }
    const diffRel = (a: ArrayLike<number>, b: ArrayLike<number>) => { let s = 0, e = 0; for (let i = 0; i < a.length; i++) { s = Math.max(s, Math.abs(a[i])); e = Math.max(e, Math.abs(a[i] - b[i])) } return relativeError(e, s) }
    // Faces: CPU after setVelocity (above) against the GPU's.
    ell.setVelocity(model.u, model.v, model.w)
    let faceMs = Infinity; for (let r = 0; r < 5; r++) faceMs = Math.min(faceMs, await ell.faceProjection())
    const f = await ell.faceFluxes()
    let cpuFaceMs = Infinity; for (let r = 0; r < 3; r++) { const t0 = performance.now(); flux.setVelocity(model.u, model.v, model.w); cpuFaceMs = Math.min(cpuFaceMs, performance.now() - t0) }
    const unprojected = (() => { const a = new Float64Array(n); const { mx: X, my: Y, mz: Z } = { mx: flux['mx'], my: flux['my'], mz: flux['mz'] }; return maxAbs(X) })()
    result.faces = { gpuMs: +faceMs.toFixed(2), cpuMs: +cpuFaceMs.toFixed(1), mx: +diffRel(flux['mx'], f.mx).toExponential(2), my: +diffRel(flux['my'], f.my).toExponential(2), mz: +diffRel(flux['mz'], f.mz).toExponential(2),
      divLeftGpu: +(maxAbs(f.div) / (maxAbs(f.mx) / grid.dx)).toExponential(2), divLeftCpu: +(maxAbs(flux['div']) / (unprojected / grid.dx)).toExponential(2) }
    log('faces ' + JSON.stringify(result.faces))
    // Pressure: the model's velocity with a divergent bump added to w (as a stage leaves it), projected on both.
    const solver = model['solver'], u0 = Float32Array.from(model.u), v0 = Float32Array.from(model.v), w0 = Float32Array.from(model.w)
    for (let z = 1; z < nz - 1; z++) for (let c = 0; c < grid.layer; c++) { const x = c % grid.nx, y = Math.floor(c / grid.nx); w0[c + z * grid.layer] += 3 * Math.exp(-(((x - grid.nx / 2) / 4) ** 2 + ((y - grid.ny / 2) / 4) ** 2 + ((z - 15) / 5) ** 2)) }
    const cells = grid.nx * grid.ny * (nz - 1), divIn = new Float64Array(cells); solver.divergence(u0, v0, w0, DT, divIn)
    const uc = Float32Array.from(u0), vc = Float32Array.from(v0), wc = Float32Array.from(w0), rhs = new Float64Array(cells), pc = new Float64Array(cells)
    let cpuPMs = Infinity
    for (let r = 0; r < 3; r++) { uc.set(u0); vc.set(v0); wc.set(w0); const t0 = performance.now(); solver.divergence(uc, vc, wc, DT, rhs); solver.solve(rhs, pc); solver.correct(pc, uc, vc, wc, DT); cpuPMs = Math.min(cpuPMs, performance.now() - t0) }
    let pMs = Infinity
    for (let r = 0; r < 5; r++) { ell.setVelocity(u0, v0, w0); pMs = Math.min(pMs, await ell.pressureProjection(DT)) }
    const [ug, vg, wg] = await ell.read([8, 9, 10]), divOut = new Float64Array(cells), divCpu = new Float64Array(cells)
    solver.divergence(ug, vg, wg, DT, divOut); solver.divergence(uc, vc, wc, DT, divCpu)
    const change = (a: Float32Array, b: Float32Array) => { const d = new Float32Array(a.length); for (let i = 0; i < a.length; i++) d[i] = a[i] - b[i]; return d }
    result.pressure = { gpuMs: +pMs.toFixed(2), cpuMs: +cpuPMs.toFixed(1), duRel: +diffRel(change(uc, u0), change(ug, u0)).toExponential(2), dvRel: +diffRel(change(vc, v0), change(vg, v0)).toExponential(2), dwRel: +diffRel(change(wc, w0), change(wg, w0)).toExponential(2),
      divLeftGpu: +(maxAbs(divOut) / maxAbs(divIn)).toExponential(2), divLeftCpu: +(maxAbs(divCpu) / maxAbs(divIn)).toExponential(2) }
    log('pressure ' + JSON.stringify(result.pressure))
    result.ellipticErrors = ell.errors.slice(0, 5)
  }
  // Step 4: the dynamics of a step (face projection, three RK3 stages of every carried field with buoyancy, nudging and
  // the pressure in the stages) on the GPU against the model's own phases (step() without the sedimentation before them).
  {
    const cfg = model['config'], fieldsNow = carried.map(c => Float32Array.from(c.field))
    const roleNames = ['u', 'v', 'w', 'theta', 'q', 'cloud', 'ice', 'rain', 'snow', 'graupel', 'hail']
    const fields = carried.map((c, k) => ({ q: fieldsNow[k], monotone: c.monotone, role: (roleNames.find(f => model[f] === c.field) ?? 'other') as any }))
    const zones = model.zoneGround !== null, nudging = startOf(cfg) === 'nudge', [ox, oy] = cfg.startOffset ?? [0, 0]
    const env = { thetaEnv: [] as number[], qEnv: [] as number[], shape: [] as number[], zoneTheta: zones ? model['zoneThetaNow'] : null, zoneVapour: zones ? model['zoneVapourNow'] : null,
      nudge: nudging ? { time: model.time, top: cfg.nudge ?? NUDGE.w, cx: grid.width / 2 + ox, cy: grid.depth / 2 + oy } : null }
    for (let z = 0; z < nz; z++) { const [t, q] = model.envNow(z); env.thetaEnv.push(t); env.qEnv.push(q); env.shape.push(zones && grid.zs[z] < ZONE_DEPTH ? zoneShape(grid.zs[z]) : 0) }
    const dyn = await GpuDynamics.create(grid, model.env)
    let dynMs = Infinity, after: Float32Array[] = []
    for (let r = 0; r < 4; r++) { const res = await dyn.step(fields, env, DT, true); dynMs = Math.min(dynMs, res.gpuMs); after = res.fields }
    // The CPU: the same phases as step() (model.ts), on the model's own fields.
    const run = (phase: string, tasks: number) => model.runner.run(phase, tasks, DT), layer = grid.layer
    const t0 = performance.now()
    run('faces', nz); run('faceDivergence', nz); run('faceForward', nz); run('faceModes', grid.ny); run('faceInverse', nz); run('faceCorrect', nz); run('faceDivergence', nz)
    const tasks = carried.length * model['slabs']()
    for (const stage of [0, 1, 2]) {
      run(`tendency${stage}`, tasks); run(`update${stage}`, tasks)
      if (stage < 2) { const top = (nz - 1) * layer; for (let b = 0; b < layer; b++) { model.w[b] = 0; model.w[b + top] = 0 } model['project'](DT, false) }
    }
    const cpuDynMs = performance.now() - t0
    result.dynamics = { gpuMs: +dynMs.toFixed(2), cpuMs: +cpuDynMs.toFixed(1), nudging, zones, fields: [] as any[] }
    carried.forEach((c, k) => {
      const label = names.find(f => model[f] === c.field) ?? `#${k}`
      let scale = 0, err = 0, big = 0
      for (let i = 0; i < n; i++) { const cpuNew = c.field[i]; scale = Math.max(scale, Math.abs(cpuNew - fieldsNow[k][i])); err = Math.max(err, Math.abs(after[k][i] - cpuNew)); big = Math.max(big, Math.abs(cpuNew)) }
      const row = { field: label, changeMax: +scale.toExponential(2), maxRelOfChange: relativeError(err, scale), maxAbs: +big.toExponential(2) }
      result.dynamics.fields.push(row); log('dynamics ' + JSON.stringify(row))
    })
    result.dynamicsErrors = dyn.errors.slice(0, 5)
  }
  // Step 6: whole steps with the GPU (src/gpu/step.ts, as the worker runs them) against model.step, from the same state:
  // after 1 step the difference per field relative to that step's change; after `steps` the drift (physics thresholds
  // turn float32 differences into local ones), the rain at the ground and the charge to the ground.
  {
    const make = () => { const m = new AtmosphereModel(config, createGrid(domainGrid(config.domain, config.top, config.domainSize, config.spacing))); applyState(m, readState(state)); return m }
    const cpu = make(), gpuModel = make(), start = make(), dyn = await GpuDynamics.create(grid, gpuModel.env)
    const steps = Number(params.get('steps') ?? 10), rows: any[] = [], fieldNames = ['u', 'v', 'w', 'theta', 'q', 'cloud', 'rain', 'ice', 'snow', 'graupel', 'hail', 'chargeIce', 'chargeGraupel', 'chargeRain', 'chargeAir']
    let cpuMs = 0, gpuMs = 0, wait = 0
    const compare = (when: number) => fieldNames.forEach(f => {
      let scale = 0, err = 0
      for (let i = 0; i < n; i++) { scale = Math.max(scale, Math.abs(cpu[f][i] - start[f][i])); err = Math.max(err, Math.abs(gpuModel[f][i] - cpu[f][i])) }
      rows.push({ steps: when, field: f, changeMax: +scale.toExponential(2), maxRelOfChange: relativeError(err, scale) })
    })
    for (let s = 1; s <= steps; s++) {
      let t0 = performance.now(); cpu.step(DT); cpu.time += DT; cpuMs += performance.now() - t0
      t0 = performance.now(); const r = await stepWithGpu(gpuModel, dyn, DT); gpuModel.time += DT; gpuMs += performance.now() - t0; wait += r.waitMs
      if (r.failed) { result.stepFailed = r.failed; break }
      if (s === 1) compare(1)
    }
    if (steps !== 1) compare(steps)
    const sum = (a: ArrayLike<number>) => { let t = 0; for (let i = 0; i < a.length; i++) t += a[i]; return t }
    const p0 = sum(start.precipitation), pc = sum(cpu.precipitation) - p0, pg = sum(gpuModel.precipitation) - p0
    let pScale = 0, pErr = 0; for (let c = 0; c < cpu.pressure.length; c++) { pScale = Math.max(pScale, Math.abs(cpu.pressure[c])); pErr = Math.max(pErr, Math.abs(cpu.pressure[c] - gpuModel.pressure[c])) }
    result.fullStep = { steps, cpuMsPerStep: +(cpuMs / steps).toFixed(1), gpuPathMsPerStep: +(gpuMs / steps).toFixed(1), gpuWaitMsPerStep: +(wait / steps).toFixed(1),
      rainCpu: +pc.toExponential(3), rainGpu: +pg.toExponential(3), chargeGroundCpu: +(cpu.chargeGround - start.chargeGround).toExponential(3), chargeGroundGpu: +(gpuModel.chargeGround - start.chargeGround).toExponential(3),
      pressureRel: relativeError(pErr, pScale), clipped: [cpu.clipped, gpuModel.clipped], rows, errors: dyn.errors.slice(0, 5) }
    log('fullStep ' + JSON.stringify(result.fullStep))
  }
  result.errors = gpu.errors.slice(0, 5)
  log(`CPU ${result.cpuMs} ms, GPU ${result.gpuMs} ms for ${carried.length} fields (${result.adapter})`)
}
