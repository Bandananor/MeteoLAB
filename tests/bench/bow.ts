// @ts-nocheck
// Bow echoes after Weisman (1993, JAS 50, 645-670; read from the paper 02.11.2026). His idealized bow echo: the WK82
// sounding with CAPE 2400 (Table 1 case 3: 14 g/kg, 2377; our parcel gives 1730 at 14 g/kg and 2230 SB / 2490 ML at 15,
// so 15 by default), a unidirectional shear of Us = 25 m/s over the lowest 2.5 km perpendicular to the line, constant
// above (the sensitivity runs: Us 5-40 m/s over 2.5 or 5 km; bows - category "B" - need >= 20), f = 0, a single
// ellipsoidal warm thermal of 10 km horizontal and 1.4 km vertical radius, 2 K at the centre (WK82: centred at 1.4 km),
// open lateral sides, 2 km x 750 m grid, 160 km along x by 160 km along y (half of it with a mirror axis), 240 min, the
// domain moving at 22.5 m/s. His numbers: the cell peaks at 30 m/s at ~30 min; the system's ground speed 18 m/s at
// 60 min, 22.5 at 120, 27 at 180, 29 at 240; by 180 min a quasi-steady bow - bookend vortices (cyclonic north,
// anticyclonic south), an elevated rear-inflow jet > 20 m/s at 2-3 km reaching the leading edge (15 m/s relative to the
// ambient 2.5 km flow at 120-180 min, reaching ~40 km behind), an erect updraught through 6 km, a cold pool ~3 km deep
// at the leading edge; "B": a 40-80 km arc, strong system-relative outflow only in a 5-10 km zone behind the gust front;
// "W" (weak shear): the cold pool overwhelms the shear, rear inflow descends to the ground; "S" (strong): isolated
// splitting supercells. Surface winds >= 30 m/s at 4 h for CAPE >= 2000 and >= 15 m/s over 2.5-5 km.
// Ours: the same, on the mesoscale mode (2 km, 168 x 162 km, our 50 stretched levels) with relaxed western and eastern
// edges (periodic along y); f = 0 unless `coriolis`. bubbles=N instead starts a north-south line of N of our thermals.
// Every 10 model minutes:
//   the gust front (the easternmost ground node >= 1 K colder in each row): its length along y, its ground speed, and the
//   bow - how far the middle third of it leads the ends (km; a finite line's spreading cold pool also leads in the
//   middle, so tell a bow by the rear inflow and the vortices, not by this alone);
//   the rear inflow: the strongest system-relative eastward wind (u over the ground minus the front's speed) 5-40 km
//   behind the front in the middle third, its height, and that wind 0-5 km behind the front at 2-3 km (does it reach it);
//   the line-end vortices: the strongest cyclonic and anticyclonic vertical vorticity at ~2.5 km within 30 km behind the
//   front, and where along the front they sit (0 = southern end, 1 = northern);
//   the strongest ground-relative wind at 100 m, the cold pool, the RKW balance (C / du).
//   npx vite build --ssr tests/bench/bow.ts --outDir .bench/bow && node .bench/bow/bow.js [us=25] [depth=2.5] [hours=4] [threads=3] [speed=22.5] [qv=15] [coriolis] [large] [bubbles=N spacing=12 strength=2]
// large: the large domain at 1.2 km (144 x 108 km) instead of the mesoscale one.
import { isMainThread, Worker, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { AtmosphereModel, coldPoolBalance, createGrid, domainGrid, DT, Environment, parcelIndices } from '../../src/core'
import { AttachedMemory, controlBuffer, serveTasks, SharedMemory, ThreadRunner } from '../../src/core/threads'
import { SUMMER_DAY } from '../../src/core/fixtures'

const gridOf = c => createGrid(domainGrid(c.domain, c.top, c.domainSize, c.spacing))

if (!isMainThread) {
  const { config, buffers, control } = workerData
  serveTasks(new AtmosphereModel(config, gridOf(config), undefined, { memory: new AttachedMemory(buffers), attach: true }), control)
} else {
  const args = process.argv.slice(2), option = (name, d) => Number(args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? d)
  const us = option('us', 25), depth = option('depth', 2.5) * 1000, hours = option('hours', 4), threads = option('threads', 3), speed = option('speed', 22.5)
  const bubbles = option('bubbles', 0), spacing = option('spacing', 12) * 1000, strength = option('strength', 2), large = args.includes('large')
  const config = {
    ...SUMMER_DAY, profile: 'weisman-klemp', weismanKlemp: { qvMax: option('qv', 15) / 1000, u6: us, depth }, solarMax: 0, latitude: args.includes('coriolis') ? 40 : 0,
    bubble: 0, start: 'thermals', edges: 'relaxed-x', frameMotion: [speed, 0],
    ...(large ? { domain: 'custom', domainSize: [144, 108] } : { domain: 'meso', domainSize: [168, 162] }),
  }
  const memory = new SharedMemory(), model = new AtmosphereModel(structuredClone(config), gridOf(config), undefined, { memory })
  const control = controlBuffer(), helpers = []
  for (let k = 0; k < threads - 1; k++) helpers.push(new Worker(fileURLToPath(import.meta.url), { workerData: { config: structuredClone(config), buffers: memory.buffers, control } }))
  if (threads > 1) { model.transportSlabs = 10; model.runner = new ThreadRunner(model, control, threads - 1) }
  const { nx, ny, dx, dy, layer, zs, width: W, depth: D } = model.grid
  // Weisman's thermal: 2 cos²(πβ/2) K, β = √((r / 10 km)² + ((z - 1.4 km) / 1.4 km)²) < 1, a third of the way in from the
  // west, vapour kept; or a line of `bubbles` of our thermals `spacing` apart along y.
  if (!bubbles) for (let z = 0; z < model.grid.nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const beta = Math.hypot((x * dx - W / 3) / 10_000, (y * dy - D / 2) / 10_000, (zs[z] - 1400) / 1400)
    if (beta < 1) model.theta[x + nx * (y + ny * z)] += strength * Math.cos(Math.PI * beta / 2) ** 2
  }
  for (let k = 0; k < bubbles; k++) model.injectBubble(W / 3, D / 2 + (k - (bubbles - 1) / 2) * spacing, strength * (.9 + .2 * model.rng()))
  model.added = { heat: 0, vapour: 0, count: 0 }
  const idx = parcelIndices(model.env, model.grid.height)
  console.log(`us ${us} m/s over ${depth / 1000} km, ${bubbles ? `${bubbles} thermals ${spacing / 1000} km apart` : 'one 10 x 1.4 km thermal'}, ${strength} K, f ${config.latitude ? 'on' : '0'}: ${nx} x ${ny} x ${model.grid.nz} at ${dx / 1000} km, SB CAPE ${idx.sb.cape.toFixed(0)}, ML CAPE ${idx.ml.cape.toFixed(0)}, ${threads} threads`)

  const level = h => zs.findIndex(z => z >= h) * layer, l100 = level(100), l25 = level(2500)
  const bands = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000].map(h => [h, level(h)])
  const wrap = (x, n) => (x % n + n) % n
  let lastFront = NaN, frontSpeed = NaN, gustMax = 0, gusty = 0, t0 = performance.now()
  for (let t = DT; t <= hours * 3600; t += DT) {
    model.step(DT); model.time += DT
    if (t % 600) continue
    const [fu, fv] = model.frame, th0 = model.env.thetaEnv(zs[0])
    // The gust front per row, unwrapped around the circular mean of the cold rows.
    const front = new Float64Array(ny).fill(NaN)
    let sx = 0, cx = 0
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (model.theta[x + y * nx] - th0 <= -1) { const a = 2 * Math.PI * x / nx; sx += Math.sin(a); cx += Math.cos(a) }
    const centre = wrap(Math.atan2(sx, cx) / (2 * Math.PI) * nx, nx)
    for (let y = 0; y < ny; y++) {
      let east = -Infinity
      for (let x = 0; x < nx; x++) if (model.theta[x + y * nx] - th0 <= -1) east = Math.max(east, wrap(x - centre + nx / 2, nx) - nx / 2)
      if (east > -Infinity) front[y] = (centre + east) * dx
    }
    const rows = [...front.keys()].filter(y => !isNaN(front[y]))
    let line = '', rear = '', vort = '', bow = NaN
    if (rows.length > 4) {
      const y0 = rows[0], y1 = rows[rows.length - 1], len = y1 - y0 + 1, at = f => y0 + Math.round(f * (len - 1))
      const mean = (a, b) => { const v = rows.filter(y => y >= a && y <= b).map(y => front[y]); return v.reduce((s, x) => s + x, 0) / v.length }
      const middle = [at(1 / 3), at(2 / 3)], fx = rows.reduce((s, y) => s + front[y], 0) / rows.length
      bow = mean(...middle) - (mean(y0, at(.15)) + mean(at(.85), y1)) / 2
      const ground = fx + fu * t
      frontSpeed = (ground - lastFront) / 600; lastFront = ground
      line = `front ${(len * dy / 1000).toFixed(0)} km long, ${frontSpeed.toFixed(1)} m/s, bow ${(bow / 1000).toFixed(1)} km`
      // System-relative wind: u over the ground minus the front's speed (rear inflow > 0 behind the front).
      const sys = i => model.u[i] + fu - (isNaN(frontSpeed) ? fu : frontSpeed)
      let best = -Infinity, bestH = 0, bestBehind = 0, lead = -Infinity
      for (let y = middle[0]; y <= middle[1]; y++) {
        if (isNaN(front[y])) continue
        const xf = Math.round(front[y] / dx)
        for (const [h, l] of bands) for (let b = 0; b * dx <= 40_000; b++) {
          const v = sys(l + wrap(xf - b, nx) + y * nx)
          if (b * dx >= 5000 && v > best) { best = v; bestH = h; bestBehind = b * dx }
          if (b * dx <= 5000 && (h === 2000 || h === 2500 || h === 3000)) lead = Math.max(lead, v)
        }
      }
      rear = `rear inflow ${best.toFixed(1)} m/s at ${(bestH / 1000).toFixed(1)} km ${(bestBehind / 1000).toFixed(0)} km behind, ${lead.toFixed(1)} at the front`
      // Vertical vorticity at 2.5 km within 30 km behind the front, over the line's rows and 10 km beyond its ends.
      let zMax = 0, zMin = 0, yMax = 0, yMin = 0
      for (let y = Math.max(0, y0 - 5); y <= Math.min(ny - 1, y1 + 5); y++) {
        const xf = Math.round((isNaN(front[y]) ? front[y < y0 ? y0 : y1] : front[y]) / dx)
        for (let b = -3; b * dx <= 30_000; b++) {
          const x = wrap(xf - b, nx), yn = wrap(y + 1, ny), ys = wrap(y - 1, ny), c = l25 + x + y * nx
          const zeta = (model.v[l25 + wrap(x + 1, nx) + y * nx] - model.v[l25 + wrap(x - 1, nx) + y * nx]) / (2 * dx) - (model.u[l25 + x + yn * nx] - model.u[l25 + x + ys * nx]) / (2 * dy)
          if (zeta > zMax) { zMax = zeta; yMax = y } if (zeta < zMin) { zMin = zeta; yMin = y }
        }
      }
      vort = `zeta 2.5 km +${(zMax * 1e3).toFixed(1)} at ${((yMax - y0) / (len - 1)).toFixed(2)}, ${(zMin * 1e3).toFixed(1)} at ${((yMin - y0) / (len - 1)).toFixed(2)} (1e-3/s)`
    }
    let gust = 0, thMin = 0
    for (let c = 0; c < layer; c++) { gust = Math.max(gust, Math.hypot(model.u[l100 + c] + fu, model.v[l100 + c] + fv)); thMin = Math.min(thMin, model.theta[c] - th0) }
    gustMax = Math.max(gustMax, gust); if (gust >= 25) gusty += 600
    const d = model.diagnostics(), b = coldPoolBalance(model)
    console.log(`${(t / 60).toFixed(0)} min: w ${d.updraft.toFixed(1)}, ${line || 'no gust front'}${rear ? `, ${rear}` : ''}${vort ? `, ${vort}` : ''}, gust ${gust.toFixed(1)}, theta' ${thMin.toFixed(1)} K, rain ${d.rainTotal.toFixed(1)} mm, C ${b ? `${b.c.toFixed(1)} / du ${b.deltaU.toFixed(1)} = ${b.ratio.toFixed(2)}` : '-'}, clipped ${model.clipped}, ${((performance.now() - t0) / 1000).toFixed(0)} s`)
  }
  console.log(`strongest gust ${gustMax.toFixed(1)} m/s, >= 25 m/s for ${gusty / 60} min`)
  process.exit(0)
}
