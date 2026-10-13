// @ts-nocheck
// Scouting new scenarios (2.1 review): a named variant's environment, then every 5 model minutes the strongest
// updraught, cloud top, rain, cold pool, gust, hail, UH and how long a mesocyclone has held.
//   npx vite build --ssr tests/bench/scout.ts --outDir .bench/scout && node .bench/scout/scout.js <variant> [minutes=40] [env]
import { AtmosphereModel, createGrid, domainGrid, DT, Environment, liveSounding, parcelIndices, SCENARIOS, skewIndices, stormIndices } from '../../src/core'
import { SUMMER_DAY, SUPERCELL } from '../../src/core/fixtures'
import { existsSync, readFileSync } from 'node:fs'

// Variants: SCENARIOS by name, the fixtures, and .bench/variants.json ({ name: values or ["base", values] }) so a new
// variant needs no rebuild.
const VARIANTS = { supercell: SUPERCELL }
for (const s of SCENARIOS) VARIANTS[s.name] = s.values
const file = '.bench/variants.json'
if (existsSync(file)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) VARIANTS[k] = Array.isArray(v) ? { ...VARIANTS[v[0]], ...v[1] } : v
const args = process.argv.slice(2), name = args[0], minutes = Number(args[1] ?? 40), envOnly = args.includes('env')
const config = { ...SUMMER_DAY, ...(VARIANTS[name] ?? (v => Array.isArray(v) ? { ...VARIANTS[v[0]], ...v[1] } : v)(JSON.parse(name))) }, grid = createGrid(domainGrid(config.domain, config.top, config.domainSize))
const env = new Environment(config, grid), i = parcelIndices(env, grid.height), k = skewIndices(env, grid.height), st = stormIndices(env, i)
const f = (x, d = 0) => x === null || x === undefined ? '—' : x.toFixed(d)
console.log(`${name}: SB ${f(i.sb.cape)}/${f(i.sb.cin)} ML ${f(i.ml.cape)}/${f(i.ml.cin)} MU ${f(i.mu.cape)} LCL ${f(i.ml.lcl, 1)} LFC ${f(i.ml.lfc, 1)} EL ${f(i.ml.el, 1)} DCAPE ${f(i.dcape)} S06 ${f(st.shear06)} SRH1 ${f(st.srh01)} SRH3 ${f(st.srh03)} PW ${f(k.pw)} 0C ${f(k.freezing, 1)} LR75 ${f(k.lapse75, 1)} SCP ${f(st.scp, 1)} STP ${f(st.stp, 1)}`)
if (!envOnly) {
  const model = new AtmosphereModel(config, grid), t0 = performance.now()
  let longest = 0, maxW = 0, maxUH = 0, gust = 0, hail = 0
  for (let t = DT; t <= minutes * 60; t += DT) {
    model.step(DT); model.time += DT; longest = Math.max(longest, model.rotation.persisted); maxUH = Math.max(maxUH, model.rotation.uh)
    if (t % 60) continue
    const d = model.diagnostics(); maxW = Math.max(maxW, d.updraft); gust = Math.max(gust, d.gust); hail = Math.max(hail, d.hail)
    if (t % 300) continue
    // Where the strongest updraught at ~3 km is, km east and north of the city's centre (ground-fixed; with a city).
    let where = ''
    if (config.city) {
      const { nx, ny, dx, dy, layer, zs, width, depth } = model.grid, k = zs.findIndex(z => z >= 3000) * layer, [ox, oy] = model.frameOffset()
      let best = 0; for (let c = 1; c < layer; c++) if (model.w[k + c] > model.w[k + best]) best = c
      const wrap = (d, s) => d - s * Math.round(d / s)
      where = ` @city ${(wrap((best % nx + .5) * dx + ox - width / 2, width) / 1000).toFixed(0)},${(wrap((Math.floor(best / nx) + .5) * dy + oy - depth / 2, depth) / 1000).toFixed(0)} km`
    }
    // The live sounding (the air of the quiet columns): what the sun and the large-scale advection have made of it.
    const live = parcelIndices(liveSounding(model).env, model.grid.height).sb, clock = config.hour + t / 3600
    console.log(`${name} ${t / 60} min ${Math.floor(clock)}:${String(Math.round(clock % 1 * 60)).padStart(2, "0")} SB ${live.cape.toFixed(0)}/${live.cin.toFixed(0)}${where}: w ${d.updraft.toFixed(1)}, top ${d.cloudTop.toFixed(1)} km, rain ${d.rainTotal.toFixed(1)} mm (${d.rainRate.toFixed(0)} mm/h), cold ${d.coldMax.toFixed(1)} K, gust ${d.gust.toFixed(1)}, hail ${d.hail.toFixed(0)} mm, cores ${d.cores}, UH ${model.rotation.uh.toFixed(0)} (0-1 ${model.rotation.uh01.toFixed(0)}, 0-3 ${model.rotation.uh03.toFixed(0)}, core ζ ${(model.rotation.coreZeta * 1000).toFixed(1)}), meso ${longest} s, clipped ${model.clipped} [${((performance.now() - t0) / 1000).toFixed(0)} s]`)
  }
  console.log(`${name} SUMMARY: max w ${maxW.toFixed(1)}, max UH ${maxUH.toFixed(0)}, meso ${longest} s, gust ${gust.toFixed(1)}, hail ${hail.toFixed(0)} mm, rain ${Math.max(...model.precipitation).toFixed(1)} mm, clipped ${model.clipped}`)
}
