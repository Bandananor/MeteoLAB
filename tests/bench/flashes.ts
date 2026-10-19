// @ts-nocheck
// Where the storm's flashes happen (2.7, the charge in the anvil): every 5 model minutes the flashes since the last
// report (IC / -CG / +CG, the height of their start, their horizontal extent and top) and the charge in the anvil, away
// from the updraught: the mean net charge by level (nC/m³) and the strongest field there as a share of the initiation
// field.
//   npx vite build --ssr tests/bench/flashes.ts --outDir .bench/flashes && node .bench/flashes/flashes.js "<scenario>" [minutes=60]
import { AtmosphereModel, createGrid, domainGrid, DT, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'
import { chargingRate } from '../../src/core/charge'

const [name, minutesArg] = process.argv.slice(2), minutes = Number(minutesArg ?? 60)
const scenario = SCENARIOS.find(s => s.name === name)
if (!scenario) { console.log(`no scenario "${name}": ${SCENARIOS.map(s => s.name).join(', ')}`); process.exit(1) }
const config = { ...SUMMER_DAY, ...scenario.values }, grid = createGrid(domainGrid(config.domain, config.top, config.domainSize))
const model = new AtmosphereModel(config, grid), { nx, ny, nz, layer, dx, dy, zs } = grid
const level = (km: number) => zs.findIndex(z => z >= km * 1000)
let seen = 0
const t0 = performance.now()
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % 300) continue
  const total = model.flashCount.ic + model.flashCount.cg, fresh = model.flashes.slice(Math.max(0, model.flashes.length - (total - seen))); seen = total
  const stats = { IC: [], '-CG': [], '+CG': [] }
  for (const f of fresh) {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, top = 0
    for (const i of f.nodes) { const c = i % layer, x = c % nx, y = Math.floor(c / nx), z = Math.floor(i / layer); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); top = Math.max(top, zs[z]) }
    const key = f.kind === 'IC' ? 'IC' : f.charge > 0 ? '+CG' : '-CG'
    stats[key].push({ start: zs[Math.floor(f.start / layer)] / 1000, extent: Math.hypot((x1 - x0) * dx, (y1 - y0) * dy) / 1000, top: top / 1000, charge: Math.abs(f.charge) })
  }
  // Each CG: its start height, the channel potential before the contact (MV), where its leader left the charged cloud (the
  // lowest charged cloudy node of the path to the ground, km) and the share of its nodes grown after the contact.
  for (const f of fresh) if (f.kind === 'CG') {
    const path = []; for (let c = f.nodes.indexOf(f.ground); c >= 0; c = f.parent[c]) path.push(f.nodes[c])
    let exit = 0; for (const i of path) { const z = Math.floor(i / layer); if (Math.abs(model.lightning.rho[i]) >= 1e-10 && model.cloud[i] + model.ice[i] + model.snow[i] > 1e-5) { exit = zs[z] / 1000; break } }
    const after = f.nodes.length - 1 - f.nodes.indexOf(f.ground)
    console.log(`     CG ${f.charge > 0 ? '+' : '-'} ${Math.abs(f.charge).toFixed(0)} C start ${(zs[Math.floor(f.start / layer)] / 1000).toFixed(1)} km V ${(f.potential / 1e6).toFixed(0)} MV leaves charge at ${exit.toFixed(1)} km, ${f.nodes.length} nodes, ${(after / f.nodes.length * 100).toFixed(0)}% after`)
  }
  const describe = (list) => list.length ? `${list.length} (start ${(list.reduce((a, s) => a + s.start, 0) / list.length).toFixed(1)} km, extent ${(list.reduce((a, s) => a + s.extent, 0) / list.length).toFixed(1)}/${Math.max(...list.map(s => s.extent)).toFixed(1)} km, top ${Math.max(...list.map(s => s.top)).toFixed(1)} km, ${(list.reduce((a, s) => a + s.charge, 0) / list.length).toFixed(1)} C)` : '0'
  // The anvil: columns with cloud ice above 9 km but no updraught over 2 m/s at 4-10 km (away from the core).
  const anvil = []
  const k9 = level(9), k4 = level(4), k10 = level(10)
  for (let c = 0; c < layer; c++) {
    let ice = 0, up = 0
    for (let z = k9; z < nz; z++) ice += model.ice[c + z * layer] + model.snow[c + z * layer]
    for (let z = k4; z <= k10; z++) up = Math.max(up, model.w[c + z * layer])
    if (ice > 1e-4 && up < 2) anvil.push(c)
  }
  const rhoAir = model.env.rho, lt = model.lightning, profile = []
  for (const km of [7, 8, 9, 10, 11, 12, 13, 14]) {
    const z = level(km)
    if (z < 0) continue
    let sum = 0, pos = 0, neg = 0
    for (const c of anvil) { const i = c + z * layer, q = (model.chargeIce[i] + model.chargeGraupel[i] + model.chargeRain[i] + model.chargeAir[i]) * rhoAir[z] * 1e9; sum += q; if (q > 0) pos += q; else neg += q }
    profile.push(`${km}:${anvil.length ? (sum / anvil.length).toFixed(2) : '—'}`)
  }
  // The strongest field over the anvil columns and over all, as a share of the initiation field (from the last solve).
  let anvilRatio = 0, allRatio = 0
  if (lt) {
    const phi = lt.phi, { xp, xm, yp, ym } = grid, anvilSet = new Set(anvil)
    for (let z = 1; z < nz - 1; z++) {
      const dz = zs[z + 1] - zs[z - 1], e0 = 2.84e5 * rhoAir[z] / 1.225
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const i = x + y * nx + z * layer, row = y * nx + z * layer
        const ex = (phi[xp[x] + row] - phi[xm[x] + row]) / (2 * dx), ey = (phi[x + yp[y] + z * layer] - phi[x + ym[y] + z * layer]) / (2 * dy), ez = (phi[i + layer] - phi[i - layer]) / dz
        const r = Math.sqrt(ex * ex + ey * ey + ez * ez) / e0
        allRatio = Math.max(allRatio, r); if (anvilSet.has(x + y * nx)) anvilRatio = Math.max(anvilRatio, r)
      }
    }
  }
  // The core: columns with an updraught over 8 m/s at 4-10 km; by level the temperature, the net charge, and the charge
  // on the graupel-hail and on the ice-snow (nC/m3).
  const core = []
  for (let c = 0; c < layer; c++) { let up = 0; for (let z = k4; z <= k10; z++) up = Math.max(up, model.w[c + z * layer]); if (up > 8) core.push(c) }
  const coreProfile = []
  for (const km of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const z = level(km); if (z < 0 || !core.length) continue
    let net = 0, gr = 0, ic = 0, tc = 0
    for (const c of core) { const i = c + z * layer, r = rhoAir[z] * 1e9; net += (model.chargeIce[i] + model.chargeGraupel[i] + model.chargeRain[i] + model.chargeAir[i]) * r; gr += model.chargeGraupel[i] * r; ic += model.chargeIce[i] * r; tc += model.theta[i] * model.env.exner[z] - 273.15 }
    const n = core.length
    coreProfile.push(`${km}(${(tc / n).toFixed(0)}C):${(net / n).toFixed(2)}/g${(gr / n).toFixed(2)}/i${(ic / n).toFixed(2)}`)
  }
  // The core's charging by level: cloud water and graupel-hail (g/m3), the non-inductive rate gained by the graupel
  // (pC/m3/s, mean) and the share of nodes where it charges positively.
  const charging = []
  for (const km of [3, 4, 5, 6, 7, 8, 9]) {
    const z = level(km); if (z < 0 || !core.length) continue
    let lwc = 0, gr = 0, rate = 0, pos = 0, n = 0
    for (const c of core) {
      const i = c + z * layer, tc = model.theta[i] * model.env.exner[z] - 273.15, r = chargingRate(tc, rhoAir[z], model.cloud[i], model.ice[i], model.snow[i], model.graupel[i], model.hail[i], 1, false, false, model.iceNumber[i] * rhoAir[z])
      lwc += model.cloud[i] * rhoAir[z] * 1e3; gr += (model.graupel[i] + model.hail[i]) * rhoAir[z] * 1e3; rate += r; if (r > 0) pos++; if (r !== 0) n++
    }
    const k = core.length
    charging.push(`${km}:w${(lwc / k).toFixed(1)}/g${(gr / k).toFixed(1)}/${(rate / k * 1e12).toFixed(0)}/${n ? (pos / n * 100).toFixed(0) : '-'}%`)
  }
  // The rain shafts: columns with rain over 0.5 g/m3 at 1 km; their mean rain and graupel charge there (nC/m3).
  { const z = level(1); let n = 0, cr = 0, cg = 0; for (let c = 0; c < layer; c++) { const i = c + z * layer; if (model.rain[i] * rhoAir[z] > 5e-4) { n++; cr += model.chargeRain[i] * rhoAir[z] * 1e9; cg += model.chargeGraupel[i] * rhoAir[z] * 1e9 } }
    console.log(`   charging in the core (lwc/graupel g/m3, pC/m3/s, % positive): ${charging.join(' ')} | rain shafts ${n} cols at 1 km: rain ${n ? (cr / n).toFixed(2) : '-'} graupel ${n ? (cg / n).toFixed(2) : '-'} nC/m3`) }
  // The whole storm's net charge by level: the mean over the nodes holding any charge.
  const storm = []
  for (const km of [2, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const z = level(km); if (z < 0) continue
    let net = 0, n = 0
    for (let c = 0; c < layer; c++) { const i = c + z * layer, q = (model.chargeIce[i] + model.chargeGraupel[i] + model.chargeRain[i] + model.chargeAir[i]) * rhoAir[z] * 1e9; if (Math.abs(q) > .01) { net += q; n++ } }
    storm.push(`${km}:${n ? (net / n).toFixed(2) : '—'}`)
  }
  // The storm's total charge in the air (C) and what the precipitation and the CG flashes have taken to the ground.
  let net = 0
  for (let z = 0; z < nz; z++) { const v = dx * dy * grid.hz[z] * rhoAir[z]; for (let c = 0; c < layer; c++) { const i = c + z * layer; net += (model.chargeIce[i] + model.chargeGraupel[i] + model.chargeRain[i] + model.chargeAir[i]) * v } }
  // chargeGround holds the precipitation's charge and the CG flashes' together; the precipitation alone is the sum.
  console.log(`   total in the air ${net.toFixed(1)} C, precipitation to the ground ${(model.chargeGround + (lt?.fromGround ?? 0) - (lt?.conducted ?? 0)).toFixed(1)} C, from the ground by CG ${(lt?.fromGround ?? 0).toFixed(1)} C, conducted out ${(lt?.conducted ?? 0).toFixed(1)} C`)
  // The potential in the core by level (mean, MV).
  if (lt && core.length) { const pp = []; for (const km of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14]) { const z = level(km); if (z < 0) continue; let s = 0; for (const c of core) s += lt.phi[c + z * layer]; pp.push(`${km}:${(s / core.length / 1e6).toFixed(0)}`) } console.log(`   core potential MV: ${pp.join(' ')}`) }
  console.log(`   core ${core.length} cols: ${coreProfile.join(' ')}`)
  console.log(`   charged air by level (mean nC/m3): ${storm.join(' ')}`)
  console.log(`${t / 60} min: IC ${describe(stats.IC)}; -CG ${describe(stats['-CG'])}; +CG ${describe(stats['+CG'])} | anvil ${anvil.length} cols, net nC/m3 ${profile.join(' ')}, E/Einit anvil ${anvilRatio.toFixed(2)} all ${allRatio.toFixed(2)} [${((performance.now() - t0) / 1000).toFixed(0)} s]`)
}
