// @ts-nocheck
// A squall line by the numbers after Weisman & Rotunno (2004): src/validation/squall.ts (the set-up and what is
// measured), printed every `every` minutes. The long validation cases (cases.ts LONG_CASES) run the same.
//   npx vite build --ssr tests/bench/lines.ts --outDir .bench/lines && node .bench/lines/lines.js [us=15] [depth=2.5] [dx=1] [hours=4] [every=30] [threads=4] [speed=12.5] [size=288x72] [qv=14]
// Add jsonl=1 for paired runs with STORMLAB_RAIN2M and STORMLAB_ICE2M set to 0 or 1 before launching Node.
// Add rainProfile=1 for interval evaporation by model level and snapshot replay of the rain evaporation operators.
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

if (!isMainThread) {
  const { config, buffers, control } = workerData
  serveTasks(new AtmosphereModel(config, squallGrid(config), undefined, { memory: new AttachedMemory(buffers), attach: true }), control)
} else {
  const threads = Number(option('threads', 4)), t0 = performance.now()
  const profile = option('rainProfile', '0') === '1', jsonl = profile || option('jsonl', '0') === '1'
  const options = { us: Number(option('us', 15)), depth: Number(option('depth', 2.5)), dx: Number(option('dx', 1)), hours: Number(option('hours', 4)), every: Number(option('every', 30)), speed: Number(option('speed', 12.5)), size: option('size', '288x72').split('x').map(Number), qv: Number(option('qv', 14)) }
  if (jsonl && (!Number.isInteger(options.every) || options.every < 1)) throw new Error('jsonl=1 requires a positive whole number of minutes between samples')
  let evaporatedByLevel
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
    if (threads < 2) return () => {}
    const control = controlBuffer(), helpers = []
    for (let k = 0; k < threads - 1; k++) helpers.push(new Worker(fileURLToPath(import.meta.url), { workerData: { config: structuredClone(config), buffers: memory.buffers, control } }))
    const runner = new ThreadRunner(model, control, threads - 1)
    model.transportSlabs = 10; model.runner = runner
    if (!jsonl) console.log(`us ${options.us} over ${options.depth} km, dx ${g.dx / 1000} km, ${g.nx} x ${g.ny} x ${g.nz}; dU 0-5 ${u5.toFixed(1)} m/s; frame ${options.speed} m/s`)
    return () => { runner.stop(); for (const h of helpers) void h.terminate() }
  }
  let previousEvaporation = 0, previousMinutes = 0
  squallLine(options, spawn, (s, model) => {
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
        ...(profile ? { rainProfile: rainProfile(model, evaporatedByLevel, seconds) } : {}) }))
      return
    }
    const f = s.front
    const line = f ? `front ${f.km.toFixed(0)} km, speed ${f.speed.toFixed(1)}, th' ${f.thetaMin.toFixed(1)}, C ${f.c.toFixed(1)} (integral ${f.cIntegral.toFixed(1)}), H ${f.h.toFixed(1)} km, C/dU ${f.cdU25.toFixed(2)} (0-5 km ${f.cdU5.toFixed(2)}), tilt ${f.tilt.toFixed(0)} km (behind front ${f.behind15.toFixed(0)} at 1.5 km, ${f.behind6.toFixed(0)} at 6 km; y-mean w ${f.w15.toFixed(1)}, ${f.w6.toFixed(1)})` : 'no cold pool'
    console.log(`${s.minutes} min: ${line}, w max ${s.wMax.toFixed(0)}, rows ${(100 * s.rows).toFixed(0)} %, gust ${s.gust.toFixed(0)}, ${((performance.now() - t0) / 60000).toFixed(0)} min of wall time`)
  })
  process.exit(0)
}
