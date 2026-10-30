// @ts-nocheck
// A storm from a real proximity sounding set against what was observed (roadmap A5): the sounding run as one storm in a
// horizontally uniform environment (no terrain, no boundaries, no sun: the day's own trigger is not modelled), and the
// quantities a radar and the reports give — the storm's type and life, its motion against Bunkers' (tracked by the
// cyclonic UH column, else the strongest updraught at ~5 km, the frame added back), the 18 dBZ echo top, the height of
// 50 dBZ, the column maximum reflectivity, VIL (Greene & Clark 1972, Z capped at VIL_MAX_DBZ), hail at the ground, the
// strongest ground wind and the flash rate. The model repeats a storm in the day's environment, not a forecast of the
// place and time.
//   npx vite build --ssr tests/bench/observed.ts --outDir .bench/observed && node .bench/observed/observed.js <sounding file> [minutes=120] [nudge] [standard] [out.json]
import { readFileSync, writeFileSync } from 'node:fs'
import { AtmosphereModel, DT, parcelIndices, parseSounding, reflectivity, stormIndices, stormMotion } from '../../src/core'
import { ECHO_TOP_DBZ, VIL_MAX_DBZ } from '../../src/core/ppi'
import { regimeOf } from '../../src/regime/grid'
import { DEFAULTS, fillLowWind } from '../../src/defaults'

const args = process.argv.slice(2), file = args[0], minutes = Number(args[1] ?? 120), out = args.find(a => a.endsWith('.json'))
const sounding = parseSounding(readFileSync(file, 'utf8'))
const config = { ...structuredClone(DEFAULTS), sounding: { ...sounding, name: file.split(/[\\/]/).pop() }, single: true, domain: args.includes('standard') ? 'standard' : 'large', ...(args.includes('nudge') ? { start: 'nudge' } : {}) }
fillLowWind(config)
const model = new AtmosphereModel(config), g = model.grid, e = model.env, { nx, ny, layer, dx, dy, zs } = g
const idx = parcelIndices(e, g.height), k = stormIndices(e, idx), sm = stormMotion(e)
const f = (v: number, d = 0) => Number.isFinite(v) ? v.toFixed(d) : '—'
const dir = (u: number, v: number) => `${f((270 - Math.atan2(v, u) * 180 / Math.PI + 360) % 360)}° ${f(Math.hypot(u, v), 1)} m/s`
console.log(`${config.sounding.name}: ML CAPE ${f(idx.ml.cape)} CIN ${f(idx.ml.cin)}, SB ${f(idx.sb.cape)}, MU ${f(idx.mu.cape)} J/kg; shear 0-6 ${f(k.shear06)} m/s, SRH 0-1 / 0-3 ${f(k.srh01)} / ${f(k.srh03)}, SCP ${f(k.scp, 1)}, STP ${f(k.stp, 1)}; Bunkers right ${dir(...sm.rightMover)}, left ${dir(...sm.leftMover)}, mean wind ${dir(...sm.meanWind)}; ${nx} x ${ny}, ${config.start === 'nudge' ? 'nudged' : 'thermal'} start, ${minutes} min`)

const at5 = zs.reduce((b, z, i) => Math.abs(z - 5000) < Math.abs(zs[b] - 5000) ? i : b, 0)
const samples = [], track = [], dbz = new Float32Array(g.n)
let flashes = 0, peak = { dbz: 0, top: 0, h50: 0, vil: 0, hail: 0, gust: 0, flashRate: 0, w: 0, uh: 0 }
for (let step = 1; step * DT <= minutes * 60 + 1e-6; step++) {
  model.step(DT); model.time += DT
  if (Math.round(model.time) % 60) continue
  const d = model.diagnostics(), t = model.time / 60
  for (let z = 0, i = 0; z < g.nz; z++) for (let c = 0; c < layer; c++, i++)
    dbz[i] = model.rain[i] + model.snow[i] + model.graupel[i] + model.hail[i] > 1e-7 ? reflectivity(e.rho[z], model.rain[i], model.snow[i], model.graupel[i], model.theta[i] * e.exner[z] - 273.15, model.hail[i]) : -30
  let maxDbz = 0, top = 0, h50 = 0, vil = 0
  for (let c = 0; c < layer; c++) {
    let colVil = 0
    for (let z = 0; z < g.nz; z++) {
      const v = dbz[c + z * layer]
      if (v > maxDbz) maxDbz = v
      if (v >= ECHO_TOP_DBZ) top = Math.max(top, zs[z])
      if (v >= 50) h50 = Math.max(h50, zs[z])
      if (v > 0) colVil += 3.44e-6 * (10 ** (Math.min(v, VIL_MAX_DBZ) / 10)) ** (4 / 7) * g.hz[z]
    }
    vil = Math.max(vil, colVil)
  }
  const total = model.flashCount.ic + model.flashCount.cg, rate = total - flashes; flashes = total
  // Where the storm is: the cyclonic UH column when there is rotation, else the strongest updraught at ~5 km.
  let x = model.rotation.x, y = model.rotation.y
  if (!(model.rotation.uh > 200)) { let best = -1; for (let c = 0; c < layer; c++) if (model.w[c + at5 * layer] > best) { best = model.w[c + at5 * layer]; x = c % nx; y = Math.floor(c / nx) } }
  track.push({ t, x: x * dx + model.frame[0] * model.time, y: y * dy + model.frame[1] * model.time, w: d.updraft })
  samples.push({ t: model.time, updraft: d.updraft, uh: model.rotation.uh, rain: d.rainRate, gust: d.gust, hail: d.hail, flashes: rate, rotationHeld: model.rotation.persisted, cores: d.cores, outflow: d.outflow })
  peak = { dbz: Math.max(peak.dbz, maxDbz), top: Math.max(peak.top, top), h50: Math.max(peak.h50, h50), vil: Math.max(peak.vil, vil), hail: Math.max(peak.hail, d.hail), gust: Math.max(peak.gust, d.gust), flashRate: Math.max(peak.flashRate, rate), w: Math.max(peak.w, d.updraft), uh: Math.max(peak.uh, model.rotation.uh) }
  if (t % 10 === 0) console.log(`  ${t} min: w ${f(d.updraft)} m/s, UH ${f(model.rotation.uh)}, ${f(maxDbz)} dBZ, top ${f(top / 1000, 1)} km, 50 dBZ to ${f(h50 / 1000, 1)} km, VIL ${f(vil)} kg/m2, hail ${f(d.hail)} mm, gust ${f(d.gust)} m/s, ${rate} flashes/min, cells ${d.cores}`)
}
// The storm's life: from the first minute of an updraught >= 10 m/s with rain >= 1 mm/h to the last; its motion: a line
// fitted to the track over the mature part (the second half of its life), ground-relative.
const live = samples.filter(s => s.updraft >= 10)
const life = live.length ? (live.at(-1).t - (samples.find(s => s.updraft >= 10 && s.rain >= 1)?.t ?? live[0].t)) / 60 : 0
const mature = track.filter(p => p.t >= minutes / 2 && p.w >= 10)
let motion = [NaN, NaN]
if (mature.length > 3) {
  const fit = (key: 'x' | 'y') => { const n = mature.length, mt = mature.reduce((s, p) => s + p.t, 0) / n, mv = mature.reduce((s, p) => s + p[key], 0) / n; return mature.reduce((s, p) => s + (p.t - mt) * (p[key] - mv), 0) / mature.reduce((s, p) => s + (p.t - mt) ** 2, 0) / 60 }
  motion = [fit('x'), fit('y')]
}
const r = { samples, rainTotal: new Float32Array(1), hailSize: new Float32Array(1), gustMax: new Float32Array(1), uhMax: new Float32Array(1), seed: 1, nx, ny, width: 1, depth: 1 }
const summary = { regime: regimeOf(r), life, motion, bunkersRight: sm.rightMover, ...peak, mesocyclone: samples.find(s => s.rotationHeld >= 600)?.t / 60 }
console.log(`storm: ${summary.regime}, life ${f(life)} min (of ${minutes}), motion ${dir(...motion)} (Bunkers right ${dir(...sm.rightMover)}); w max ${f(peak.w)} m/s, UH max ${f(peak.uh)}, mesocyclone ${summary.mesocyclone ? `from ${f(summary.mesocyclone)} min` : 'none'}; max ${f(peak.dbz)} dBZ, echo top ${f(peak.top / 1000, 1)} km, 50 dBZ to ${f(peak.h50 / 1000, 1)} km, VIL ${f(peak.vil)} kg/m2, hail ${f(peak.hail)} mm, gust ${f(peak.gust)} m/s, flashes ${peak.flashRate}/min`)
if (out) writeFileSync(out, JSON.stringify({ file, indices: { ml: idx.ml, sb: idx.sb, mu: idx.mu, ...k }, summary, track, samples }))
