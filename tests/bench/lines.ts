// @ts-nocheck
// A squall line by the numbers after Weisman & Rotunno (2004): src/validation/squall.ts (the set-up and what is
// measured), printed every `every` minutes. The long validation cases (cases.ts LONG_CASES) run the same.
//   npx vite build --ssr tests/bench/lines.ts --outDir .bench/lines && node .bench/lines/lines.js [us=15] [depth=2.5] [dx=1] [hours=4] [every=30] [threads=4] [speed=12.5] [size=288x72] [qv=14]
// Add jsonl=1 for paired runs with STORMLAB_RAIN2M and STORMLAB_ICE2M set to 0 or 1 before launching Node.
// Add rainProfile=1 for interval evaporation by model level and snapshot replay of the rain evaporation operators.
// Add rainBudget=1 for a per-level budget of the rain mass through every model step.
// Add warmState=<file prefix> to save numbered end-of-step snapshots for rain-accretion.ts at each sample.
import { writeFileSync } from 'node:fs'
import { serialize } from 'node:v8'
import { isMainThread, Worker, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { AtmosphereModel, DT } from '../../src/core'
import { interceptOf, qsatP, rainProcesses } from '../../src/core/microphysics'
import { exponentialMeanMass, rain2mProcesses, RHO_W } from '../../src/core/rain2m'
import { AttachedMemory, controlBuffer, serveTasks, ThreadRunner } from '../../src/core/threads'
import { squallGrid, squallLine } from '../../src/validation/squall'

const option = (name, d) => process.argv.slice(2).find(a => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? d

function rainProfile(model, evaporated, seconds) {
  const { nz, layer, dx, dy, hz, zs } = model.grid, { exner, p, rho } = model.env
  const q = new Float32Array(1), cloud = new Float32Array(1), rain = new Float32Array(1), number = new Float32Array(1)
  const twoMoment = model.rain2m()
  return Array.from({ length: nz }, (_, z) => {
    const airMass = dx * dy * hz[z] * rho[z]
    let rainKg = 0, dryRainKg = 0, deficitSum = 0, replay1M = 0, replay2M = 0, replay2MWithMP = 0
    for (let i = z * layer; i < (z + 1) * layer; i++) {
      const qr = model.rain[i]
      if (qr <= 0) continue
      const mass = qr * airMass, vapour = model.q[i], temperature = model.theta[i] * exner[z]
      const deficit = 1 - vapour / qsatP(temperature - 273.15, p[z])
      rainKg += mass
      if (deficit <= 0) continue
      dryRainKg += mass
      deficitSum += mass * deficit

      // Cloud is zero in the replay so neither operator adds rain by autoconversion or accretion.
      q[0] = vapour; rain[0] = qr
      replay1M += airMass * rainProcesses(q, cloud, rain, 0, temperature, p[z], rho[z], DT, model.rainIntercept) / DT
      if (twoMoment) {
        q[0] = vapour; rain[0] = qr; number[0] = model.rainNumber[i]
        replay2M += airMass * rain2mProcesses(q, cloud, rain, number, 0, temperature, p[z], rho[z], DT, model.rainBreakup) / DT
        q[0] = vapour; rain[0] = qr
        number[0] = qr / exponentialMeanMass(qr, interceptOf(model.rainIntercept, qr, rho[z]), RHO_W, rho[z])
        replay2MWithMP += airMass * rain2mProcesses(q, cloud, rain, number, 0, temperature, p[z], rho[z], DT, model.rainBreakup) / DT
      }
    }
    const row = { zM: zs[z], rainKg, dryRainKg, rainWeightedDeficit: dryRainKg ? deficitSum / dryRainKg : null,
      evaporationKgPerS: evaporated[z] / seconds, replay1MKgPerS: replay1M,
      replay2MKgPerS: twoMoment ? replay2M : null, replay2MWithMPKgPerS: twoMoment ? replay2MWithMP : null }
    evaporated[z] = 0
    return row
  })
}

function trackRainBudget(model) {
  const { nz, layer, dx, dy, hz, zs } = model.grid, { exner, p, rho } = model.env
  const mass = Float64Array.from(hz, (height, z) => height * rho[z] * dx * dy)
  const q = new Float32Array(1), cloud = new Float32Array(1), rain = new Float32Array(1), number = new Float32Array(1)
  const levels = Array.from({ length: nz }, () => ({ sediment: 0, transport: 0, auto: 0, accretion: 0, evaporation: 0, other: 0, mixing: 0 }))
  const twoMoment = model.rain2m()
  const produce = (i, z, dt, qr, nr) => {
    const qc = model.cloud[i], tk = model.theta[i] * exner[z]
    q[0] = model.q[i]; cloud[0] = qc; rain[0] = qr; number[0] = nr
    if (twoMoment) rain2mProcesses(q, cloud, rain, number, 0, tk, p[z], rho[z], dt, model.rainBreakup, false)
    else rainProcesses(q, cloud, rain, 0, tk, p[z], rho[z], dt, model.rainIntercept, false)
    return (qc - cloud[0]) * mass[z]
  }
  const sumRain = z => {
    let sum = 0
    for (let i = z * layer; i < (z + 1) * layer; i++) sum += model.rain[i]
    return sum * mass[z]
  }
  const afterMix = Float64Array.from(zs, (_, z) => sumRain(z)), initial = afterMix.slice()
  const afterFall = new Float64Array(nz), beforePhysics = new Float64Array(nz), afterPhysics = new Float64Array(nz)

  const begin = model.beginStep.bind(model)
  model.beginStep = (dt, sediment) => {
    begin(dt, sediment)
    for (let z = 0; z < nz; z++) {
      afterFall[z] = sumRain(z)
      levels[z].sediment += afterFall[z] - afterMix[z]
    }
  }

  const run = model.runner.run.bind(model.runner)
  model.runner.run = (phase, tasks, dt) => {
    if (phase !== 'physics') { run(phase, tasks, dt); return }
    // The positivity fix has run. Replay just the native warm-rain production on these inputs.
    for (let z = 0; z < nz; z++) {
      beforePhysics[z] = sumRain(z)
      const budget = levels[z]
      budget.transport += beforePhysics[z] - afterFall[z]
      if (!model.rainFormation) continue
      for (let i = z * layer; i < (z + 1) * layer; i++) {
        if (model.cloud[i] <= 0) continue
        // The mass autoconversion in both operators is independent of qr and Nr. Without rain, accretion is zero.
        const auto = produce(i, z, dt, 0, 0)
        budget.auto += auto
        budget.accretion += model.rain[i] > 0 ? produce(i, z, dt, model.rain[i], model.rainNumber[i]) - auto : 0
      }
    }
    run(phase, tasks, dt)
    for (let z = 0; z < nz; z++) {
      const budget = levels[z], evaporated = model['levelWater'][4 * z + 2]
      afterPhysics[z] = sumRain(z)
      budget.evaporation += evaporated
      // Retain the unsplit remainder, which includes ice processes, relaxed edges and floating-point roundoff.
      budget.other += afterPhysics[z] - beforePhysics[z] + evaporated
    }
  }

  const finish = model.finishStep.bind(model)
  model.finishStep = (dt) => {
    finish(dt)
    for (let z = 0; z < nz; z++) {
      afterMix[z] = sumRain(z)
      levels[z].mixing += afterMix[z] - afterPhysics[z]
    }
  }

  return seconds => {
    let downward = 0
    const rows = new Array(nz)
    for (let z = nz - 1; z >= 0; z--) {
      const { sediment, transport, auto, accretion, evaporation, other, mixing } = levels[z]
      // Infer the downward flux through the lower face from the mass change above it, including roundoff.
      downward -= sediment
      const change = afterMix[z] - initial[z]
      rows[z] = { zM: zs[z], rainKg: afterMix[z], changeKgPerS: change / seconds,
        sedimentKgPerS: sediment / seconds, sedimentDownKgPerS: downward / seconds, transportKgPerS: transport / seconds,
        autoKgPerS: auto / seconds, accretionKgPerS: accretion / seconds, evaporationKgPerS: evaporation / seconds,
        otherPhysicsKgPerS: (other - auto - accretion) / seconds, mixingKgPerS: mixing / seconds,
        closureKgPerS: (change - sediment - transport - other - mixing + evaporation) / seconds }
      initial[z] = afterMix[z]
      levels[z] = { sediment: 0, transport: 0, auto: 0, accretion: 0, evaporation: 0, other: 0, mixing: 0 }
    }
    return rows
  }
}

if (!isMainThread) {
  const { config, buffers, control } = workerData
  serveTasks(new AtmosphereModel(config, squallGrid(config), undefined, { memory: new AttachedMemory(buffers), attach: true }), control)
} else {
  const threads = Number(option('threads', 4)), t0 = performance.now()
  const profile = option('rainProfile', '0') === '1', budget = option('rainBudget', '0') === '1'
  const warmState = option('warmState', '')
  const jsonl = profile || budget || option('jsonl', '0') === '1'
  const options = { us: Number(option('us', 15)), depth: Number(option('depth', 2.5)), dx: Number(option('dx', 1)), hours: Number(option('hours', 4)), every: Number(option('every', 30)), speed: Number(option('speed', 12.5)), size: option('size', '288x72').split('x').map(Number), qv: Number(option('qv', 14)) }
  if ((jsonl || warmState) && (!Number.isInteger(options.every) || options.every < 1)) throw new Error('JSON lines and warm-state snapshots require a positive whole number of minutes between samples')
  let evaporatedByLevel, readRainBudget
  const spawn = (model, config, memory) => {
    const g = model.grid, [u5] = model.env.windUV(5000)
    if (profile) {
      // Read the per-level water budget immediately after every physics phase, before the next step overwrites it.
      evaporatedByLevel = new Float64Array(g.nz)
      const physics = model.physicsStep.bind(model)
      model.physicsStep = (dt) => {
        physics(dt)
        for (let z = 0; z < g.nz; z++) evaporatedByLevel[z] += model['levelWater'][4 * z + 2]
      }
    }
    if (jsonl) console.log(JSON.stringify({ options, threads, seed: config.seed, grid: [g.nx, g.ny, g.nz], domainKm: [g.width / 1000, g.depth / 1000], rainMoments: model.rainMoments, iceMoments: model.iceMoments }))
    if (threads < 2) {
      if (budget) readRainBudget = trackRainBudget(model)
      return () => {}
    }
    const control = controlBuffer(), helpers = []
    for (let k = 0; k < threads - 1; k++) helpers.push(new Worker(fileURLToPath(import.meta.url), { workerData: { config: structuredClone(config), buffers: memory.buffers, control } }))
    const runner = new ThreadRunner(model, control, threads - 1)
    model.transportSlabs = 10; model.runner = runner
    if (budget) readRainBudget = trackRainBudget(model)
    if (!jsonl) console.log(`us ${options.us} over ${options.depth} km, dx ${g.dx / 1000} km, ${g.nx} x ${g.ny} x ${g.nz}; dU 0-5 ${u5.toFixed(1)} m/s; frame ${options.speed} m/s`)
    return () => { runner.stop(); for (const h of helpers) void h.terminate() }
  }
  let previousEvaporation = 0, previousMinutes = 0
  squallLine(options, spawn, (s, model) => {
    if (warmState) {
      const { nx, ny, nz, dx, dy, hz } = model.grid, { exner, p, rho } = model.env
      writeFileSync(`${warmState}-${s.minutes}.bin`, serialize({ options, minutes: s.minutes,
        grid: { nx, ny, nz, dx, dy, hz }, env: { exner, p, rho }, moments: [model.rainMoments, model.iceMoments],
        theta: model.theta.slice(), q: model.q.slice(), cloud: model.cloud.slice(),
        rain: model.rain.slice(), number: model.rainNumber.slice() }))
    }
    if (jsonl) {
      const { nx, ny, dx, layer, zs } = model.grid, sx = dx / 1000
      const evaporation = model.water.rainEvaporated
      const seconds = 60 * (s.minutes - previousMinutes)
      const rainEvapKgPerS = (evaporation - previousEvaporation) / seconds
      previousEvaporation = evaporation; previousMinutes = s.minutes

      // Use the minimum of the along-line mean ground theta-v departure.
      const thetaV0 = model.env.theta[0] * (1 + .61 * model.env.q[0])
      let thetaVMin = 0
      for (let x = 0; x < nx; x++) {
        let sum = 0
        for (let y = 0; y < ny; y++) {
          const i = x + y * nx
          sum += model.theta[i] * (1 + .61 * model.q[i]) - thetaV0
        }
        thetaVMin = Math.min(thetaVMin, sum / ny)
      }
      let frontRows = null
      if (s.front) {
        // Count rows with a 3 km updraught in the band from 20 km behind to 10 km ahead of the gust front.
        const z3 = zs.findIndex(z => z >= 3000) * layer, front = Math.round(s.front.km / sx)
        let active = 0
        for (let y = 0; y < ny; y++) {
          for (let offset = -Math.floor(20 / sx); offset <= Math.floor(10 / sx); offset++) {
            const x = ((front + offset) % nx + nx) % nx
            if (model.w[z3 + x + y * nx] >= 5) { active++; break }
          }
        }
        frontRows = active / ny
      }
      console.log(JSON.stringify({ ...s, thetaVMin, rainEvapKgPerS, frontRows,
        ...(profile ? { rainProfile: rainProfile(model, evaporatedByLevel, seconds) } : {}),
        ...(budget ? { rainBudget: readRainBudget(seconds) } : {}) }))
      return
    }
    const f = s.front
    const line = f ? `front ${f.km.toFixed(0)} km, speed ${f.speed.toFixed(1)}, th' ${f.thetaMin.toFixed(1)}, C ${f.c.toFixed(1)} (integral ${f.cIntegral.toFixed(1)}), H ${f.h.toFixed(1)} km, C/dU ${f.cdU25.toFixed(2)} (0-5 km ${f.cdU5.toFixed(2)}), tilt ${f.tilt.toFixed(0)} km (behind front ${f.behind15.toFixed(0)} at 1.5 km, ${f.behind6.toFixed(0)} at 6 km; y-mean w ${f.w15.toFixed(1)}, ${f.w6.toFixed(1)})` : 'no cold pool'
    console.log(`${s.minutes} min: ${line}, w max ${s.wMax.toFixed(0)}, rows ${(100 * s.rows).toFixed(0)} %, gust ${s.gust.toFixed(0)}, ${((performance.now() - t0) / 60000).toFixed(0)} min of wall time`)
  })
  process.exit(0)
}
