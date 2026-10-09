// @ts-nocheck
// Scouting the quasi-stationary MCS scenario (a maintained front, relaxed side boundaries): an environment variant, its CAPE and precipitable water, then every
// 10 model minutes the largest rain total, the area with >= 10 / 50 mm, the rain centroid's motion and the strongest w.
//   npx vite build --ssr tests/bench/mcs.ts --outDir .bench/mcs && node .bench/mcs/mcs.js <variant> [hours=3] [env]
import { AtmosphereModel, createGrid, DT, Environment, LARGE_GRID, parcelIndices } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const MOIST = { surfaceTemp: 23.5, rhSurface: 85, rhLow: 85, rhMid: 75, rhUpper: 50, moistLayer: 1, lapseLow: 6.5, lapseMid: 6.2, lapseUpper: 6.5, tropopause: 13, capStrength: 0, solarMax: 0 }
// Low-level jet from the west-southwest at 1 km, nearly along the pool's southern edge, and the same wind above: the
// cells drift along the line while new ones keep forming at its western end (Corfidi: upshear vector ~0).
const JET = { wind0: 5, windDir0: 220, wind05: 12, windDir05: 240, wind1: 15, windDir1: 250, wind3: 12, windDir3: 260, wind6: 14, windDir6: 265, wind10: 16, windDir10: 270 }
export const VARIANTS = [
  { ...MOIST, ...JET, front: 2 },
  { ...MOIST, ...JET, front: 3 },
  { ...MOIST, ...JET, front: 4 },
  { ...MOIST, ...JET, front: 3, windDir0: 200, windDir05: 220, windDir1: 230 },
]
const [variant, hours = 3] = process.argv.slice(2).map(Number), envOnly = process.argv.includes('env')
const config = { ...SUMMER_DAY, bubble: 1, bubbleRadius: 2.5, followStorm: false, edges: 'relaxed', domain: 'large', ...VARIANTS[variant] }
const grid = createGrid(LARGE_GRID), env = new Environment(config, grid), idx = parcelIndices(env, grid.height)
let pw = 0; for (let z = 0; z < grid.nz; z++) pw += env.rho[z] * env.q[z] * grid.hz[z]
console.log(`variant ${variant}: SB CAPE ${idx.sb.cape.toFixed(0)} CIN ${idx.sb.cin.toFixed(0)}, ML CAPE ${idx.ml.cape.toFixed(0)}, LCL ${idx.sb.lcl.toFixed(0)} m, PW ${pw.toFixed(1)} mm`)
if (!envOnly) {
  const model = new AtmosphereModel(config, grid), { nx, ny, dx, dy, layer } = grid, before = new Float32Array(layer)
  let longest = 0, last: [number, number] | null = null, t0 = performance.now()
  for (let t = DT; t <= hours * 3600; t += DT) {
    model.step(DT); model.time += DT; longest = Math.max(longest, model.rotation.persisted)
    if (t % 600) continue
    // Centroid (circular, the domain is periodic) of the rain that fell in the last 10 minutes, km.
    let sx = 0, cx = 0, sy = 0, cy = 0, total = 0, a10 = 0, a50 = 0, max = 0
    for (let i = 0; i < layer; i++) {
      const p = model.precipitation[i], d = p - before[i]; before[i] = p; max = Math.max(max, p); if (p >= 10) a10++; if (p >= 50) a50++
      if (d <= 0) continue
      const ax = 2 * Math.PI * (i % nx) / nx, ay = 2 * Math.PI * Math.floor(i / nx) / ny
      sx += d * Math.sin(ax); cx += d * Math.cos(ax); sy += d * Math.sin(ay); cy += d * Math.cos(ay); total += d
    }
    const pos: [number, number] = [(Math.atan2(sx, cx) / 2 / Math.PI * nx * dx / 1000 + 96) % 96, (Math.atan2(sy, cy) / 2 / Math.PI * ny * dy / 1000 + 72) % 72]
    let speed = NaN
    if (last && total > 0) { let ddx = pos[0] - last[0], ddy = pos[1] - last[1]; ddx -= 96 * Math.round(ddx / 96); ddy -= 72 * Math.round(ddy / 72); speed = Math.hypot(ddx, ddy) * 1000 / 600 }
    if (total > 0) last = pos
    const d = model.diagnostics()
    console.log(`${(t / 60).toFixed(0)} min: max rain ${max.toFixed(1)} mm, >=10 mm ${(a10 * dx * dy / 1e6).toFixed(0)} km2, >=50 mm ${(a50 * dx * dy / 1e6).toFixed(0)} km2, centroid ${pos.map(v => v.toFixed(1)).join(', ')} km, moves ${speed.toFixed(1)} m/s, w ${d.updraft.toFixed(1)}, UH ${model.rotation.uh.toFixed(0)}, meso ${model.rotation.persisted} s, clipped ${model.clipped}, ${((performance.now() - t0) / 1000).toFixed(0)} s`)
  }
  // Largest total in each 4.8 km band from west to east (the side zones are the outer 12 km), and the longest rotation.
  const bands = Array.from({ length: nx / 4 }, (_, b) => { let m = 0; for (let y = 0; y < ny; y++) for (let x = 4 * b; x < 4 * b + 4; x++) m = Math.max(m, model.precipitation[x + y * nx]); return m.toFixed(0) })
  console.log(`west-east maxima (mm, 4.8 km bands): ${bands.join(" ")}; longest rotation ${longest} s`)
}
