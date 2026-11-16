// @ts-nocheck
// The DMRL-C phenomena map by both criteria sets on a real run: every `every` model minutes the share of in-range pixels
// with each code under RD 52.04.320-91 and under GIMET-2010's example (phenomena.ts), and how many pixels differ.
//   npx vite-node tests/bench/phenomena.ts ["<scenario>"] [minutes=40] [every=10]
import { AtmosphereModel, createGrid, domainGrid, DT, PHENOMENA, PPI, RADARS, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const args = process.argv.slice(2).filter(a => !a.includes('=')), opt = (k, d) => Number(process.argv.find(a => a.startsWith(k + '='))?.slice(k.length + 1) ?? d)
const name = args[0] ?? 'Классическая суперячейка', minutes = opt('minutes', 40), every = opt('every', 10)
const s = SCENARIOS.find(x => x.name === name), config = { ...SUMMER_DAY, ...s.values }
const model = new AtmosphereModel(config, createGrid(domainGrid(config.domain, config.top, config.domainSize)))
const ppi = new PPI(model, 160, 120)
ppi.setProfile(RADARS.dmrl)
const label = c => `${c}:${(PHENOMENA.find(p => p.code === c)?.name ?? '?').slice(0, 18)}`
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (Math.round(t) % (every * 60)) continue
  ppi.composite()
  ppi.phenomena(0, [], 'rd'); const rd = Uint8Array.from(ppi.codes)
  ppi.phenomena(0, [], 'gimet'); const gm = Uint8Array.from(ppi.codes)
  const count = codes => { const m = new Map(); for (const c of codes) if (c !== 31 && c !== 0) m.set(c, (m.get(c) ?? 0) + 1); return [...m].sort((a, b) => a[0] - b[0]).map(([c, n]) => `${label(c)} ${n}`).join(', ') }
  let differ = 0, echo = 0
  for (let i = 0; i < rd.length; i++) { if (rd[i] !== 31 && (rd[i] || gm[i])) { echo++; if (rd[i] !== gm[i]) differ++ } }
  console.log(`${t / 60} min, H0 ${(ppi.levelH2 / 1000).toFixed(1)} km, -15 °C ${(ppi.levelT15 / 1000).toFixed(1)} km; ${differ} of ${echo} echo pixels differ`)
  console.log(`  RD:    ${count(rd)}`)
  console.log(`  GIMET: ${count(gm)}`)
}
