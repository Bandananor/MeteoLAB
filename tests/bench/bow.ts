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
//   the gust front: in each row the eastern edge of the cold pool (ground nodes >= FRONT_COLD K colder) followed east
//   from the row's coldest node across gaps of at most FRONT_GAP nodes, so that the outflow of new cells ahead and the
//   weak cold of the old pool wrapped round the domain do not count; a row more than FRONT_SPIKE m off the median of
//   FRONT_WINDOW m of rows around it is dropped (between the cold cores a row's coldest node lies far back in the wake),
//   then a running median over FRONT_SMOOTH rows; its
//   length along y, its ground speed (the median over the middle third of the rows' displacements over 30 min, taken
//   modulo the domain's width - 10 min steps were quantised by dx / 600 s = 3.3 m/s), and the bow - how far the middle third
//   leads the ends (km; a finite line's spreading cold pool also leads in the middle, so tell a bow by the rear inflow
//   and the vortices, not by this alone);
//   the rear inflow: the strongest system-relative eastward wind (u over the ground minus the front's speed) 5-40 km
//   behind the front in the middle third, its height, and that wind 0-5 km behind the front at 2-3 km (does it reach it);
//   the line-end vortices: the strongest cyclonic and anticyclonic vertical vorticity at ~2.5 km within 30 km behind the
//   front, and where along the front they sit (0 = southern end, 1 = northern);
//   the strongest ground-relative wind at 100 m, the cold pool, the RKW balance at the leading edge: C from the column's
//   buoyancy as in rkw.ts, averaged over the middle third 0-10 km behind the front (the domain mean of coldPoolBalance
//   takes in the shallow old pool far behind), and its depth; du is the 0-2.5 km wind difference.
//   out=DIR: every 30 min DIR/bow-MMM.bin - a JSON header line and Float32 fields nx x ny: the column's strongest
//   reflectivity, the ground θ', and u (system-relative), v and w at 2.5 km (plot with experiments/bow/maps.py).
//   npx vite build --ssr tests/bench/bow.ts --outDir .bench/bow && node .bench/bow/bow.js [us=25] [depth=2.5] [hours=4] [threads=3] [speed=22.5] [qv=15] [coriolis] [large] [bubbles=N spacing=12 strength=2] [out=DIR] [dx=KM]
// large: the large domain at 1.2 km (144 x 108 km) instead of the mesoscale one. dx=KM: the horizontal spacing (SimConfig.spacing,
// the domain kept; Weisman's check: 1 km changes nothing essential).
import { isMainThread, Worker, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { AtmosphereModel, createGrid, domainGrid, DT, G, parcelIndices, reflectivity, SCENARIOS } from '../../src/core'
import { AttachedMemory, controlBuffer, serveTasks, SharedMemory, ThreadRunner } from '../../src/core/threads'
import { SUMMER_DAY } from '../../src/core/fixtures'

const gridOf = c => createGrid(domainGrid(c.domain, c.top, c.domainSize, c.spacing))
/** The largest gap (nodes) in a row's cold pool the front is followed across; the rows of the front's running median. */
const FRONT_GAP = 2, FRONT_SMOOTH = 5, FRONT_COLD = 3, FRONT_SPAN = 3, FRONT_WINDOW = 30_000, FRONT_SPIKE = 15_000

if (!isMainThread) {
  const { config, buffers, control } = workerData
  serveTasks(new AtmosphereModel(config, gridOf(config), undefined, { memory: new AttachedMemory(buffers), attach: true }), control)
} else {
  const args = process.argv.slice(2), option = (name, d) => Number(args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? d)
  const us = option('us', 25), depth = option('depth', 2.5) * 1000, hours = option('hours', 4), threads = option('threads', 3), speed = option('speed', 22.5)
  const bubbles = option('bubbles', 0), spacing = option('spacing', 12) * 1000, strength = option('strength', 2), large = args.includes('large')
  // The simulator's scenario, with the options over it.
  const config = {
    ...SUMMER_DAY, ...SCENARIOS.find(s => s.name === 'Bow echo').values, weismanKlemp: { qvMax: option('qv', 15) / 1000, u6: us, depth }, latitude: args.includes('coriolis') ? 40 : 0,
    ...(option('dx', 0) ? { spacing: option('dx', 0) } : {}), frameMotion: [speed, 0], ...(bubbles ? { start: 'thermals' } : {}),
    ...(large ? { domain: 'custom', domainSize: [144, 108] } : {}),
  }
  const memory = new SharedMemory(), model = new AtmosphereModel(structuredClone(config), gridOf(config), undefined, { memory })
  const control = controlBuffer(), helpers = []
  for (let k = 0; k < threads - 1; k++) helpers.push(new Worker(fileURLToPath(import.meta.url), { workerData: { config: structuredClone(config), buffers: memory.buffers, control } }))
  if (threads > 1) { model.transportSlabs = 10; model.runner = new ThreadRunner(model, control, threads - 1) }
  const { nx, ny, nz, dx, dy, layer, zs, hz, width: W, depth: D } = model.grid
  const out = args.find(a => a.startsWith('out='))?.slice(4)
  if (out) mkdirSync(out, { recursive: true })
  // A line of `bubbles` of our thermals `spacing` apart along y instead of Weisman's one (start 'ellipsoid').
  for (let k = 0; k < bubbles; k++) model.injectBubble(W / 3, D / 2 + (k - (bubbles - 1) / 2) * spacing, strength * (.9 + .2 * model.rng()))
  model.added = { heat: 0, vapour: 0, count: 0 }
  const idx = parcelIndices(model.env, model.grid.height)
  console.log(`us ${us} m/s over ${depth / 1000} km, ${bubbles ? `${bubbles} thermals ${spacing / 1000} km apart` : 'one 10 x 1.4 km thermal'}, ${strength} K, f ${config.latitude ? 'on' : '0'}: ${nx} x ${ny} x ${model.grid.nz} at ${dx / 1000} km, SB CAPE ${idx.sb.cape.toFixed(0)}, ML CAPE ${idx.ml.cape.toFixed(0)}, ${threads} threads`)

  const level = h => zs.findIndex(z => z >= h) * layer, l100 = level(100), l25 = level(2500)
  const bands = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000].map(h => [h, level(h)])
  const wrap = (x, n) => (x % n + n) % n
  const e = model.env, [u0, v0] = e.windUV(0), [u1, v1] = e.windUV(2500), du = Math.hypot(u1 - u0, v1 - v0)
  // Cold-pool speed and depth of a column (rkw.ts coldPoolBalance): C² = 2 ∫ -B dz up to where B turns positive.
  const column = c => {
    let integral = 0, top = 0
    for (let k = 0, i = c; k < nz; k++, i += layer) {
      const b = G * (model.theta[i] * (1 + .61 * model.q[i]) / (e.theta[k] * (1 + .61 * e.q[k])) - 1 - model.cloud[i] - model.rain[i] - model.ice[i] - model.snow[i] - model.graupel[i] - model.hail[i])
      if (b >= 0) break
      integral -= b * hz[k]; top = zs[k] + hz[k] / 2
    }
    return [Math.sqrt(2 * integral), top]
  }
  const median = a => { const s = a.filter(v => !isNaN(v)).sort((p, q) => p - q); return s.length ? s[s.length >> 1] : NaN }
  const history = []; let frontSpeed = NaN, gustMax = 0, gusty = 0, t0 = performance.now()
  for (let t = DT; t <= hours * 3600; t += DT) {
    model.step(DT); model.time += DT
    if (t % 600) continue
    const [fu, fv] = model.frame, th0 = model.env.thetaEnv(zs[0])
    // The gust front per row, unwrapped around the circular mean of the cold rows.
    const front = new Float64Array(ny).fill(NaN)
    let sx = 0, cx = 0
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (model.theta[x + y * nx] - th0 <= -1) { const a = 2 * Math.PI * x / nx; sx += Math.sin(a); cx += Math.cos(a) }
    const centre = wrap(Math.atan2(sx, cx) / (2 * Math.PI) * nx, nx)
    const raw = new Float64Array(ny).fill(NaN)
    for (let y = 0; y < ny; y++) {
      // Cold nodes of the row, unwrapped about the centre (-nx/2 .. nx/2); start at the one nearest the centre.
      const cold = []
      for (let x = 0; x < nx; x++) if (model.theta[x + y * nx] - th0 <= -FRONT_COLD) cold.push(wrap(x - centre + nx / 2, nx) - nx / 2)
      if (!cold.length) continue
      cold.sort((p, q) => p - q)
      const th = x => model.theta[wrap(Math.round(centre + x), nx) + y * nx]
      let k = cold.reduce((best, x, j) => th(x) < th(cold[best]) ? j : best, 0)
      while (k + 1 < cold.length && cold[k + 1] - cold[k] <= FRONT_GAP + 1) k++
      raw[y] = (centre + cold[k]) * dx
    }
    const rowsAround = (a, y, half) => { const near = []; for (let j = -half; j <= half; j++) if (y + j >= 0 && y + j < ny) near.push(a[y + j]); return near }
    const kept = Float64Array.from(raw, (v, y) => isNaN(v) || Math.abs(v - median(rowsAround(raw, y, Math.round(FRONT_WINDOW / dy / 2)))) > FRONT_SPIKE ? NaN : v)
    for (let y = 0; y < ny; y++) if (!isNaN(kept[y])) front[y] = median(rowsAround(kept, y, FRONT_SMOOTH >> 1))
    const rows = [...front.keys()].filter(y => !isNaN(front[y]))
    let line = '', rear = '', vort = '', edge = 'C -', bow = NaN
    if (rows.length > 4) {
      const y0 = rows[0], y1 = rows[rows.length - 1], len = y1 - y0 + 1, at = f => y0 + Math.round(f * (len - 1))
      const mean = (a, b) => { const v = rows.filter(y => y >= a && y <= b).map(y => front[y]); return v.reduce((s, x) => s + x, 0) / v.length }
      const middle = [at(1 / 3), at(2 / 3)], fx = rows.reduce((s, y) => s + front[y], 0) / rows.length
      bow = mean(...middle) - (mean(y0, at(.15)) + mean(at(.85), y1)) / 2
      const ground = Float64Array.from(front, f => f + fu * t), moved = []
      const then = history.length >= FRONT_SPAN ? history[history.length - FRONT_SPAN] : history[0], span = 600 * Math.min(FRONT_SPAN, history.length)
      if (then) for (let y = middle[0]; y <= middle[1]; y++) { const d = ground[y] - then[y]; moved.push((d - W * Math.round((d - fu * span) / W)) / span) }
      frontSpeed = median(moved); history.push(ground)
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
      // The cold pool at the leading edge: the middle third, 0-10 km behind the front.
      let cSum = 0, hSum = 0, cn = 0
      for (let y = middle[0]; y <= middle[1]; y++) for (let b = 0; b * dx <= 10_000; b++) {
        const c = wrap(Math.round(front[y] / dx) - b, nx) + y * nx
        if (model.theta[c] - th0 > -1) continue
        const [s, h] = column(c); cSum += s; hSum += h; cn++
      }
      edge = cn ? `C ${(cSum / cn).toFixed(1)} (${(hSum / cn / 1000).toFixed(1)} km deep) / du ${du.toFixed(1)} = ${(cSum / cn / du).toFixed(2)}` : 'C -'
      vort = `zeta 2.5 km +${(zMax * 1e3).toFixed(1)} at ${((yMax - y0) / (len - 1)).toFixed(2)}, ${(zMin * 1e3).toFixed(1)} at ${((yMin - y0) / (len - 1)).toFixed(2)} (1e-3/s)`
    }
    let gust = 0, thMin = 0
    for (let c = 0; c < layer; c++) { gust = Math.max(gust, Math.hypot(model.u[l100 + c] + fu, model.v[l100 + c] + fv)); thMin = Math.min(thMin, model.theta[c] - th0) }
    gustMax = Math.max(gustMax, gust); if (gust >= 25) gusty += 600
    const d = model.diagnostics()
    console.log(`${(t / 60).toFixed(0)} min: w ${d.updraft.toFixed(1)}, ${line || 'no gust front'}${rear ? `, ${rear}` : ''}${vort ? `, ${vort}` : ''}, gust ${gust.toFixed(1)}, theta' ${thMin.toFixed(1)} K, rain ${d.rainTotal.toFixed(1)} mm, ${edge}, clipped ${model.clipped}, ${((performance.now() - t0) / 1000).toFixed(0)} s`)
    if (out && t % 1800 === 0) {
      const dbz = new Float32Array(layer).fill(-30), th = new Float32Array(layer), su = new Float32Array(layer), sv = new Float32Array(layer), sw = new Float32Array(layer)
      const shift = fu - (isNaN(frontSpeed) ? fu : frontSpeed)
      for (let z = 0, i = 0; z < nz; z++) {
        const rho = e.rho[z], exner = e.exner[z]
        for (let c = 0; c < layer; c++, i++) if (model.rain[i] > 0 || model.snow[i] > 0 || model.graupel[i] > 0 || model.hail[i] > 0)
          dbz[c] = Math.max(dbz[c], reflectivity(rho, model.rain[i], model.snow[i], model.graupel[i], model.theta[i] * exner - 273.15, model.hail[i]))
      }
      for (let c = 0; c < layer; c++) { th[c] = model.theta[c] - th0; su[c] = model.u[l25 + c] + shift; sv[c] = model.v[l25 + c] + fv; sw[c] = model.w[l25 + c] }
      const header = JSON.stringify({ t: t / 60, nx, ny, dx, dy, us, depth, frontSpeed, front: Array.from(front, f => isNaN(f) ? null : f) }) + '\n'
      writeFileSync(`${out}/bow-${String(t / 60).padStart(3, '0')}.bin`, Buffer.concat([Buffer.from(header), ...[dbz, th, su, sv, sw].map(a => Buffer.from(a.buffer))]))
    }
  }
  console.log(`strongest gust ${gustMax.toFixed(1)} m/s, >= 25 m/s for ${gusty / 60} min`)
  process.exit(0)
}
