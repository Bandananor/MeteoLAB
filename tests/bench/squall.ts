// @ts-nocheck
// Scouting the squall-line scenario: a line of thermals in shear concentrated in the lowest 3 km (Rotunno, Klemp and
// Weisman 1988), on the large domain with relaxed western and eastern edges. Every 10 model minutes: the strongest
// updraught, how continuous the line is (share of the rows along y with an updraught >= 5 m/s at ~3 km), where the
// line is (circular mean x of those updraughts, in the domain and over the ground, and its ground-relative speed), the
// cold pool (coldest theta' and the share of the domain >= 1 K colder at the ground), gusts, rain.
//   npx vite build --ssr tests/bench/squall.ts --outDir .bench/squall && node .bench/squall/squall.js <variant> [hours=2] [env]
import { AtmosphereModel, createGrid, DT, Environment, LARGE_GRID, parcelIndices, skewIndices } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const AIR = { surfaceTemp: 25, rhSurface: 70, rhLow: 65, rhMid: 50, rhUpper: 35, lapseLow: 8, lapseMid: 6.3, lapseUpper: 6.5, tropopause: 12, moistLayer: 1, capStrength: 0, solarMax: 0 }
// Shear in the lowest 3 km along x: easterly at the ground (into the line), westerly above; constant above 6 km.
const shear = (u0: number, u3: number, u10 = u3) => ({ wind0: Math.abs(u0), windDir0: u0 < 0 ? 90 : 270, wind05: Math.abs(u0 + (u3 - u0) / 6), windDir05: u0 + (u3 - u0) / 6 < 0 ? 90 : 270, wind1: Math.abs(u0 + (u3 - u0) / 3), windDir1: u0 + (u3 - u0) / 3 < 0 ? 90 : 270, wind3: Math.abs(u3), windDir3: 270, wind6: Math.abs(u3), windDir6: 270, wind10: Math.abs(u10), windDir10: 270 })
export const VARIANTS = [
  { ...AIR, ...shear(-8, 10) },
  { ...AIR, ...shear(-4, 8) },
  { ...AIR, ...shear(-10, 14) },
  { ...AIR, ...shear(-8, 10), surfaceTemp: 26.5 },
]
const [variant, hours = 2] = process.argv.slice(2).map(Number), envOnly = process.argv.includes('env')
const config = { ...SUMMER_DAY, bubble: 1.2, start: 'line', edges: 'relaxed-x', domain: 'large', frameMotion: [14, 0], ...VARIANTS[variant] }
const grid = createGrid(LARGE_GRID), env = new Environment(config, grid), idx = parcelIndices(env, grid.height), s = skewIndices(env, grid.height)
console.log(`variant ${variant}: SB CAPE ${idx.sb.cape.toFixed(0)} CIN ${idx.sb.cin.toFixed(0)}, ML CAPE ${idx.ml.cape.toFixed(0)}, PW ${s.pw.toFixed(0)} mm, shear 0-6 km ${s.shear06.toFixed(0)} m/s`)
if (!envOnly) {
  const model = new AtmosphereModel(config, grid), { nx, ny, dx, layer, zs } = grid, l3 = zs.findIndex(z => z >= 3000) * layer, l100 = zs.findIndex(z => z >= 100) * layer
  let longest = 0, lastFront = NaN, t0 = performance.now(), gustMax = 0
  for (let t = DT; t <= hours * 3600; t += DT) {
    model.step(DT); model.time += DT; longest = Math.max(longest, model.rotation.persisted)
    if (t % 600) continue
    const [fu, fv] = model.frame
    let rows = 0, wMax = 0, sx = 0, cx = 0, thMin = 0, gust = 0, pooled = 0
    for (let y = 0; y < ny; y++) {
      let rowW = 0, at = 0
      for (let x = 0; x < nx; x++) {
        const c = x + y * nx, w = model.w[l3 + c], dth = model.theta[c] - model.env.thetaEnv(zs[0])
        if (w > rowW) { rowW = w; at = x }
        thMin = Math.min(thMin, dth); if (dth <= -1) pooled++
        gust = Math.max(gust, Math.hypot(model.u[l100 + c] + fu, model.v[l100 + c] + fv))
      }
      if (rowW >= 5) { rows++; const a = 2 * Math.PI * at / nx; sx += Math.sin(a); cx += Math.cos(a) }
      wMax = Math.max(wMax, rowW)
    }
    gustMax = Math.max(gustMax, gust)
    // The line over the ground: its position in the domain plus how far the domain has moved.
    const inDomain = rows ? ((Math.atan2(sx, cx) / (2 * Math.PI) * nx + nx) % nx) * dx : NaN, front = inDomain + fu * t, speed = (front - lastFront) / 600; lastFront = front
    const d = model.diagnostics()
    console.log(`${(t / 60).toFixed(0)} min: w ${d.updraft.toFixed(1)} (3 km ${wMax.toFixed(1)}), line ${(100 * rows / ny).toFixed(0)} % of rows, line at ${(front / 1000).toFixed(1)} km (in domain ${(inDomain / 1000).toFixed(1)}) moving ${speed.toFixed(1)} m/s, theta' ${thMin.toFixed(1)} K pool ${(100 * pooled / layer).toFixed(0)} %, gust ${gust.toFixed(1)} m/s, rain ${d.rainTotal.toFixed(1)} mm, UH ${model.rotation.uh.toFixed(0)}, meso ${model.rotation.persisted} s, clipped ${model.clipped}, ${((performance.now() - t0) / 1000).toFixed(0)} s`)
  }
  console.log(`longest rotation ${longest} s, strongest gust ${gustMax.toFixed(1)} m/s`)
}
