// @ts-nocheck
// A ready situation's course by the minute, with and without what drives its story (the slow situations test checks
// only a few numbers): every 10 model minutes the strongest updraught and the mean of the minute maxima over those 10
// min, the highest cloud top, the heaviest rain at the ground and the domain's cold pool.
//   npx vite build --ssr tests/bench/trough.ts --outDir .bench/trough && node .bench/trough/trough.js ["Высотная ложбина"] [180] [plain] [amount=-4 bottom=3 …]
// «plain» runs it without the advection (largeScale) or the front.
import { AtmosphereModel, DT, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const args = process.argv.slice(2), name = args.find(a => !/^\d+$/.test(a) && a !== 'plain' && !a.includes('=')) ?? 'Высотная ложбина'
const minutes = Number(args.find(a => /^\d+$/.test(a)) ?? 180), plain = args.includes('plain'), s = SCENARIOS.find(x => x.name === name)
const opt = (k: string) => args.find(a => a.startsWith(`${k}=`))?.slice(k.length + 1)
let values = plain ? { ...s.values, largeScale: undefined, frontLine: undefined } : s.values
// amount=, bottom=, top=, start=, hours= change the first advection (calibration).
if (!plain && values.largeScale) values = { ...values, largeScale: [{ ...values.largeScale[0], ...Object.fromEntries(['amount', 'bottom', 'top', 'start', 'hours'].filter(opt).map(k => [k, Number(opt(k))])) }, ...values.largeScale.slice(1)] }
const model = new AtmosphereModel({ ...SUMMER_DAY, ...values }), started = Date.now()
let wMax = 0, wSum = 0, n = 0, top = 0, rain = 0, lateSum = 0, lateN = 0
const clock = (t: number) => { const h = (values.hour ?? 13.5) + t / 3600; return `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}` }
console.log(`${name}${plain ? ' (plain)' : ''} ${JSON.stringify(values.largeScale ?? null)}: time  w max  w mean of minute maxima  top km  rain mm/h  cold pool K`)
for (let t = DT; t <= minutes * 60; t += DT) {
  model.step(DT); model.time += DT
  if (t % 60) continue
  const d = model.diagnostics()
  wMax = Math.max(wMax, d.updraft); wSum += d.updraft; n++; top = Math.max(top, d.cloudTop); rain = Math.max(rain, d.rainRate)
  if (t >= 150 * 60) { lateSum += d.updraft; lateN++ }
  if (t % 600) continue
  console.log(`${clock(t)}  ${wMax.toFixed(1)}  ${(wSum / n).toFixed(1)}  ${top.toFixed(1)}  ${rain.toFixed(0)}  ${d.outflow.toFixed(1)}`)
  wMax = 0; wSum = 0; n = 0; top = 0; rain = 0
}
console.log(`late (from 150 min) mean of minute maxima ${lateN ? (lateSum / lateN).toFixed(2) : '—'} m/s, clipped ${model.clipped}, ${Math.round((Date.now() - started) / 60000)} min`)
