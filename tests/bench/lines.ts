// @ts-nocheck
// A squall line by the numbers, set up as Weisman & Rotunno (2004) and Bryan, Knievel & Parker (2006): the WK82 sounding,
// shear us m/s over 0-depth km, f = 0, one line thermal all along y, open in x, periodic in y (their 600 x 80-160 km at
// 1 km; here 288 x 72). Notes: .claude/literature/squall-line-initiation.md. Every `every` minutes, from the y-mean of the
// fields, as they measure it: the gust front (the y-mean ground theta' of -1 K), its ground speed; C from WR04 eq. 11,
// C^2 = -Bmin H (Bmin the lowest level's strongest negative y-mean buoyancy within 20 km behind the front, H where B
// vanishes above it) and from the integral, eq. 10; C / dU over 0-2.5 and 0-5 km; the updraught's tilt, x(6 km) - x(1.5 km)
// of the y-mean w's maximum (negative: upshear, rearward); w max; the rows with w >= 5 m/s at 3 km.
//   npx vite build --ssr tests/bench/lines.ts --outDir .bench/lines && node .bench/lines/lines.js [us=15] [depth=2.5] [dx=1] [hours=4] [every=30] [threads=4] [speed=12.5] [size=288x72] [qv=14]
import { isMainThread, Worker, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { AtmosphereModel, createGrid, domainGrid, DT } from '../../src/core'
import { AttachedMemory, controlBuffer, serveTasks, SharedMemory, ThreadRunner } from '../../src/core/threads'
import { SUMMER_DAY } from '../../src/core/fixtures'

const G = 9.81, gridOf = c => createGrid(domainGrid(c.domain, c.top, c.domainSize, c.spacing))
const option = (name, d) => process.argv.slice(2).find(a => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? d

if (!isMainThread) {
  const { config, buffers, control } = workerData
  serveTasks(new AtmosphereModel(config, gridOf(config), undefined, { memory: new AttachedMemory(buffers), attach: true }), control)
} else {
  const us = Number(option('us', 15)), depth = Number(option('depth', 2.5)), dx = Number(option('dx', 1)), hours = Number(option('hours', 4)), every = Number(option('every', 30)), threads = Number(option('threads', 4)), speed = Number(option('speed', 12.5)), qv = Number(option('qv', 14))
  const config = { ...SUMMER_DAY, profile: 'weisman-klemp', weismanKlemp: { qvMax: qv / 1000, u6: us, depth: depth * 1000 }, solarMax: 0, latitude: 0, bubble: 0, start: 'line-thermal', edges: 'relaxed-x', frameMotion: [speed, 0], domain: 'meso', domainSize: option('size', '288x72').split('x').map(Number), spacing: dx }
  const memory = new SharedMemory(), grid = gridOf(config), model = new AtmosphereModel(structuredClone(config), grid, undefined, { memory }), control = controlBuffer()
  for (let k = 0; k < threads - 1; k++) new Worker(fileURLToPath(import.meta.url), { workerData: { config: structuredClone(config), buffers: memory.buffers, control } })
  if (threads > 1) { model.transportSlabs = 10; model.runner = new ThreadRunner(model, control, threads - 1) }
  const { nx, ny, nz, zs, hz, layer } = grid, km = grid.dx / 1000, e = model.env, level = z => zs.findIndex(h => h >= z)
  const [u0] = e.windUV(0), [u25] = e.windUV(2500), [u5] = e.windUV(5000), dU25 = Math.abs(u25 - u0), dU5 = Math.abs(u5 - u0)
  console.log(`us ${us} over ${depth} km, dx ${km} km, ${nx} x ${ny} x ${nz}; dU 0-2.5 ${dU25.toFixed(1)}, 0-5 ${dU5.toFixed(1)} m/s; frame ${speed} m/s`)
  let last = null, t0 = performance.now(), rainSum = 0
  const b = new Float64Array(nx * nz), th = new Float64Array(nx), meanW = new Float64Array(nx * nz)
  for (let t = DT; t <= hours * 3600; t += DT) {
    model.step(DT); model.time += DT
    if (t % (every * 60)) continue
    b.fill(0); th.fill(0); meanW.fill(0)
    for (let z = 0; z < nz; z++) {
      const thv0 = e.theta[z] * (1 + .61 * e.q[z])
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const i = x + nx * (y + ny * z)
        b[x + nx * z] += G * (model.theta[i] * (1 + .61 * model.q[i]) / thv0 - 1 - model.cloud[i] - model.rain[i] - model.ice[i] - model.snow[i] - model.graupel[i] - model.hail[i]) / ny
        meanW[x + nx * z] += model.w[i] / ny
        if (z === 0) th[x] += (model.theta[i] - e.theta[0]) / ny
      }
    }
    // The front: east from the coldest column through columns of <= -1 K (gaps of 3 km allowed).
    let cold = 0
    for (let x = 0; x < nx; x++) if (th[x] < th[cold]) cold = x
    let front = null
    if (th[cold] <= -1) {
      let gap = 0
      front = cold
      for (let d = 1; d < nx; d++) { const x = (cold + d) % nx; if (th[x] <= -1) { front = cold + d; gap = 0 } else if (++gap * km > 3) break }
    }
    const at = x => ((x % nx) + nx) % nx
    let line = `${t / 60} min:`
    if (front !== null) {
      let bmin = 0, bx = front, c2 = 0, H = 0, hInt = 0
      for (let d = 0; d * km <= 20; d++) { const x = at(front - d); if (b[x] < bmin) { bmin = b[x]; bx = x } }
      for (let z = 0; z < nz; z++) { const v = b[bx + nx * z]; if (v >= 0) break; c2 -= 2 * v * hz[z]; H = zs[z] + hz[z] / 2 }
      const cLinear = Math.sqrt(Math.max(0, -bmin * H)), cInt = Math.sqrt(c2), pos = front * grid.dx
      const moved = last ? ((pos - last.pos + nx * grid.dx / 2) % (nx * grid.dx) + nx * grid.dx) % (nx * grid.dx) - nx * grid.dx / 2 : 0, up = last ? moved / ((t - last.t)) + speed : NaN
      last = { pos, t }
      // The updraught's tilt near the front: within 60 km behind it to 20 ahead.
      const peak = h => { const z = level(h); let best = -1, ax = 0; for (let d = -20; d * km <= 60; d++) { const x = at(front - d), v = meanW[x + nx * z]; if (v > best) { best = v; ax = d } } return [best, ax * km] }
      const [w15, x15] = peak(1500), [w6, x6] = peak(6000)
      line += ` front ${(pos / 1000).toFixed(0)} km, speed ${up.toFixed(1)}, th' ${th[cold].toFixed(1)}, C ${cLinear.toFixed(1)} (integral ${cInt.toFixed(1)}), H ${(H / 1000).toFixed(1)} km, C/dU ${(cLinear / dU25).toFixed(2)} (0-5 km ${(cLinear / dU5).toFixed(2)}), tilt ${(x15 - x6).toFixed(0)} km (behind front ${x15.toFixed(0)} at 1.5 km, ${x6.toFixed(0)} at 6 km; y-mean w ${w15.toFixed(1)}, ${w6.toFixed(1)})`
    } else line += ' no cold pool'
    let wMax = 0, rows = 0, gust = 0
    const l3 = level(3000), l100 = level(100), [fu, fv] = model.frame
    for (let y = 0; y < ny; y++) { let r = 0; for (let x = 0; x < nx; x++) { const c = x + nx * y; r = Math.max(r, model.w[c + l3 * layer]); gust = Math.max(gust, Math.hypot(model.u[c + l100 * layer] + fu, model.v[c + l100 * layer] + fv)) } if (r >= 5) rows++; wMax = Math.max(wMax, r) }
    for (let i = 0; i < model.w.length; i++) if (model.w[i] > wMax) wMax = model.w[i]
    console.log(`${line}, w max ${wMax.toFixed(0)}, rows ${(100 * rows / ny).toFixed(0)} %, gust ${gust.toFixed(0)}, ${((performance.now() - t0) / 60000).toFixed(0)} min of wall time`)
  }
  process.exit(0)
}
