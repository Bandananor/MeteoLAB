// A batch series in Node (roadmap E3), without the browser: the same series file as the «Пакетная серия» screen, the
// same runs (src/series/series.ts), one per core in worker_threads, and the same CSV and NetCDF next to the file.
//   npm run series -- path/to/series.json [threads=N] [out=path/name] [resume | fresh]
// Long series (hundreds of runs, hours of model time) go here: a server or a laptop left overnight. Each finished run
// goes at once to <out>.runs.jsonl (src/series/checkpoint.ts): after Ctrl+C, a crash or the laptop switched off, the
// same command with `resume` runs only what is left; `fresh` starts the series again.
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { SCENARIOS, type SimConfig } from '../src/core'
import { runMember, type MemberResult } from '../src/ensemble/member'
import { setRunLink } from '../src/export/stamp'
import { encodeSettings } from '../src/share'
import { expandSeries, parseSeries, seriesBase } from '../src/series/series'
import { seriesCsv, seriesNetCDF } from '../src/series/results'
import { checkpointHeader, checkpointLine, readCheckpoint } from '../src/series/checkpoint'
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
  const args = process.argv.slice(2), flags = new Set(['resume', 'fresh']), path = args.find(a => !a.includes('=') && !flags.has(a))
  const option = (name: string) => args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
  if (!path) { console.error('usage: npm run series -- path/to/series.json [threads=N] [out=path/name] [resume | fresh]'); process.exit(2) }
  const text = readFileSync(path, 'utf8'), parsed = parseSeries(text, SCENARIOS.map(s => s.name))
  if ('error' in parsed) { console.error(`${path}: ${parsed.error}`); process.exit(1) }
  const series = parsed.series, base = seriesBase(series)
  let runs
  try { runs = expandSeries(series, base) } catch (e) { console.error(`${path}: ${(e as Error).message}`); process.exit(1) }
  // A run's link is read against its scenario, as the simulator's own links are.
  const linkBase = seriesBase({ ...series, settings: {} })
  setRunLink(c => c ? `${SITE}?cfg=${encodeSettings(c, linkBase, series.scenario)}&seed=${c.seed}` : '')
  const out = option('out') ?? path.replace(/\.json$/i, ''), kept = `${out}.runs.jsonl`
  const results: (MemberResult | null)[] = runs.map(() => null), times = new Map<number, number>(), started = Date.now()
  // The runs a stopped series kept: taken with `resume`, dropped with `fresh`; with neither the choice is the user's.
  if (existsSync(kept) && !args.includes('fresh')) {
    if (!args.includes('resume')) { console.error(`${kept} holds the runs of a stopped series: add resume to go on from them, or fresh to start again`); process.exit(1) }
    const read = readCheckpoint(readFileSync(kept, 'utf8'), text, runs.length)
    if ('error' in read) { console.error(`${kept}: ${read.error}`); process.exit(1) }
    for (const [index, r] of read.results) results[index] = r
    if (read.header.version !== MODEL_VERSION) console.warn(`warning: the kept runs were made by ${read.header.version}, this is ${MODEL_VERSION}`)
    console.log(`resuming: ${read.results.size} of ${runs.length} runs kept in ${kept}`)
  } else writeFileSync(kept, checkpointHeader(text, runs.length, MODEL_VERSION) + '\n')
  const todo = runs.filter(run => !results[run.index])
  const threads = Math.max(1, Math.min(todo.length, Number(option('threads') ?? availableParallelism() - 1)))
  console.log(`MeteoLab ${MODEL_VERSION} · ${series.name || path}: ${runs.length} runs of ${series.minutes} min (${todo.length} to run), ${threads} at once`)

  let next = 0, done = runs.length - todo.length, last = 0
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
    if (next >= todo.length) { void w.terminate(); return }
    const run = todo[next++]
    times.set(run.index, 0)
    w.postMessage({ index: run.index, config: run.config, minutes: series.minutes })
  }
  let alive = threads
  if (!todo.length) { write(); process.exit(0) }
  for (let k = 0; k < threads; k++) {
    const w = new Worker(fileURLToPath(import.meta.url))
    w.on('message', (m: { type: 'progress'; index: number; time: number } | { type: 'done'; index: number; result: MemberResult }) => {
      if (m.type === 'progress') { times.set(m.index, m.time); report(); return }
      times.delete(m.index); results[m.index] = m.result; done++
      appendFileSync(kept, checkpointLine(m.index, m.result) + '\n')
      feed(w)
    })
    w.on('error', e => { console.error(e); process.exitCode = 1 })
    w.on('exit', () => { if (--alive === 0) { report(true); write() } })
    feed(w)
  }
}
