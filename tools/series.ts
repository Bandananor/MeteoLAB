// A batch series in Node (roadmap E3), without the browser: the same series file as the «Пакетная серия» screen, the
// same runs (src/series/series.ts), one per core in worker_threads, and the same CSV and NetCDF next to the file.
//   npm run series -- path/to/series.json [threads=N] [out=path/name]
// Long series (hundreds of runs, hours of model time) go here: a server or a laptop left overnight.
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
import { SCENARIOS, type SimConfig } from '../src/core'
import { runMember, type MemberResult } from '../src/ensemble/member'
import { setRunLink } from '../src/export/stamp'
import { encodeSettings } from '../src/share'
import { expandSeries, parseSeries, seriesBase } from '../src/series/series'
import { seriesCsv, seriesNetCDF } from '../src/series/results'
import { MODEL_VERSION } from '../src/version'

/** Where a run's link opens: the published simulator. */
const SITE = 'https://bandananor.github.io/MeteoLAB/simulator/'

if (!isMainThread) {
  // A worker: runs what it is given, one at a time, and reports the model time every sample.
  parentPort!.on('message', ({ index, config, minutes }: { index: number; config: SimConfig; minutes: number }) => {
    const result = runMember(config, minutes, time => parentPort!.postMessage({ type: 'progress', index, time }))
    parentPort!.postMessage({ type: 'done', index, result })
  })
} else {
  const args = process.argv.slice(2), path = args.find(a => !a.includes('='))
  const option = (name: string) => args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
  if (!path) { console.error('usage: npm run series -- path/to/series.json [threads=N] [out=path/name]'); process.exit(2) }
  const text = readFileSync(path, 'utf8'), parsed = parseSeries(text, SCENARIOS.map(s => s.name))
  if ('error' in parsed) { console.error(`${path}: ${parsed.error}`); process.exit(1) }
  const series = parsed.series, base = seriesBase(series)
  let runs
  try { runs = expandSeries(series, base) } catch (e) { console.error(`${path}: ${(e as Error).message}`); process.exit(1) }
  // A run's link is read against its scenario, as the simulator's own links are.
  const linkBase = seriesBase({ ...series, settings: {} })
  setRunLink(c => c ? `${SITE}?cfg=${encodeSettings(c, linkBase, series.scenario)}&seed=${c.seed}` : '')
  const threads = Math.max(1, Math.min(runs.length, Number(option('threads') ?? availableParallelism() - 1)))
  const out = option('out') ?? path.replace(/\.json$/i, '')
  console.log(`MeteoLab ${MODEL_VERSION} · ${series.name || path}: ${runs.length} runs of ${series.minutes} min, ${threads} at once`)

  const results: (MemberResult | null)[] = runs.map(() => null), times = new Map<number, number>(), started = Date.now()
  let next = 0, done = 0, last = 0
  const report = (force = false) => {
    const now = Date.now()
    if (!force && now - last < 5000) return
    last = now
    const end = series.minutes * 60, part = (done * end + [...times.values()].reduce((a, b) => a + b, 0)) / (runs.length * end), spent = (now - started) / 1000
    const left = part > .01 ? spent * (1 - part) / part : NaN
    console.log(`${done}/${runs.length} done · ${(part * 100).toFixed(1)}% · ${Math.round(spent / 60)} min${Number.isFinite(left) ? ` · ~${Math.ceil(left / 60)} min left` : ''}`)
  }
  const write = () => {
    const knobs = series.vary.map(([k]) => k)
    writeFileSync(`${out}.csv`, seriesCsv(knobs, runs, results))
    const nc = seriesNetCDF(knobs, runs, results, { name: series.name, version: MODEL_VERSION, text })
    if (nc) writeFileSync(`${out}.nc`, nc)
    console.log(`${done} runs written: ${out}.csv${nc ? `, ${out}.nc` : ''}`)
  }
  // Ctrl+C keeps the finished runs.
  process.on('SIGINT', () => { console.log('\nstopped'); write(); process.exit(130) })
  const feed = (w: Worker) => {
    if (next >= runs.length) { void w.terminate(); return }
    const run = runs[next++]
    times.set(run.index, 0)
    w.postMessage({ index: run.index, config: run.config, minutes: series.minutes })
  }
  let alive = threads
  for (let k = 0; k < threads; k++) {
    const w = new Worker(fileURLToPath(import.meta.url))
    w.on('message', (m: { type: 'progress'; index: number; time: number } | { type: 'done'; index: number; result: MemberResult }) => {
      if (m.type === 'progress') { times.set(m.index, m.time); report(); return }
      times.delete(m.index); results[m.index] = m.result; done++
      feed(w)
    })
    w.on('error', e => { console.error(e); process.exitCode = 1 })
    w.on('exit', () => { if (--alive === 0) { report(true); write() } })
    feed(w)
  }
}
