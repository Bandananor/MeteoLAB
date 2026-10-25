// A precise run ahead of time (roadmap C2): one run on a fine grid (the setting "spacing", km: 0.5 or 0.25) in Node,
// with the step spread over threads, an estimate of the time and the memory before it starts, the storm's course as
// CSV, light frames (frames.mlframes, src/core/frames.ts) every so many model seconds to play the run back, and saved
// states (.meteolab) every few minutes: the simulator opens them (Run → Open a .meteolab file) with all its instruments,
// and the run continues from the last one after a pause (Ctrl+C, or a file named "pause" put in the output folder — for
// a run in the background).
//   npm run precise -- run.json [threads=N] [out=dir] [every=5] [frames=30] [estimate] [resume] [live]
//   npm run precise -- compare <run folder or course.csv> <another> …
// run.json is a series file of one run: {"meteolab_series": 1, "scenario": …, "settings": {"spacing": 0.5, …},
// "vary": {}, "seeds": 1, "first_seed": …, "minutes": 60}. estimate: only the estimate. resume: from the newest state
// in the output folder. every: minutes between saved states; frames: model seconds between frames (0: none).
// live: the same run on the simulator's own grid (the file's spacing dropped; out defaults to <run>-live), to set the
// precise run against what the live mode gives. compare: the courses of such runs side by side — each quantity's peak
// and when, the storm's milestones — as a Markdown table.
import { isMainThread, Worker, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AtmosphereModel, applyState, createGrid, domainGrid, DT, encodeFrame, frameIndex, framesHeader, readFramesHeader, readState, saveState, SCENARIOS, type SimConfig } from '../src/core'
import { AttachedMemory, controlBuffer, serveTasks, SharedMemory, ThreadRunner } from '../src/core/threads'
import { setRunLink, stampColumns } from '../src/export/stamp'
import { encodeSettings, toCsv } from '../src/share'
import { expandSeries, parseSeries, seriesBase } from '../src/series/series'
import { MODEL_VERSION } from '../src/version'

/** Where the run's link opens: the published simulator. */
const SITE = 'https://bandananor.github.io/MeteoLAB/simulator/'
/** Model seconds between rows of the course. */
const ROW_EVERY = 30
/** Steps the estimate times (after one to warm up). */
const PROBE_STEPS = 4

const gridOf = (c: SimConfig) => domainGrid(c.domain, c.top, c.domainSize, c.spacing)

if (!isMainThread) {
  // A helper: a view of the main thread's model over the shared memory, doing the step's tasks it is handed.
  const { config, buffers, control } = workerData as { config: SimConfig; buffers: Record<string, SharedArrayBuffer>; control: SharedArrayBuffer }
  serveTasks(new AtmosphereModel(config, createGrid(gridOf(config)), undefined, { memory: new AttachedMemory(buffers), attach: true }), control)
} else if (process.argv[2] === 'compare') {
  compare(process.argv.slice(3))
} else {
  const args = process.argv.slice(2), path = args.find(a => !a.includes('=') && !['estimate', 'resume', 'live'].includes(a))
  const option = (name: string) => args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
  if (!path) { console.error('usage: npm run precise -- run.json [threads=N] [out=dir] [every=5] [frames=30] [estimate] [resume]'); process.exit(2) }
  const text = readFileSync(path, 'utf8'), parsed = parseSeries(text, SCENARIOS.map(s => s.name))
  if ('error' in parsed) { console.error(`${path}: ${parsed.error}`); process.exit(1) }
  const series = parsed.series, runs = expandSeries(series, seriesBase(series))
  if (runs.length !== 1) { console.error(`${path}: a precise run is one run ("vary": {}, "seeds": 1), this file makes ${runs.length}`); process.exit(1) }
  const config = runs[0].config, live = args.includes('live'), minutes = series.minutes, every = Number(option('every') ?? 5) * 60
  if (live) delete config.spacing
  const out = option('out') ?? path.replace(/\.json$/i, '') + (live ? '-live' : ''), threads = Math.max(1, Number(option('threads') ?? Math.min(6, availableParallelism() - 1)))
  const linkBase = seriesBase({ ...series, settings: {} })
  setRunLink(c => c ? `${SITE}?cfg=${encodeSettings(c, linkBase, series.scenario)}&seed=${c.seed}` : '')

  // The model on shared memory, its helpers, and what it costs.
  const rss0 = process.memoryUsage().rss, memory = new SharedMemory(), model = new AtmosphereModel(structuredClone(config), createGrid(gridOf(config)), undefined, { memory })
  const control = controlBuffer(), helpers: Worker[] = []
  for (let k = 0; k < threads - 1; k++) helpers.push(new Worker(fileURLToPath(import.meta.url), { workerData: { config: structuredClone(config), buffers: memory.buffers, control } }))
  const runner = new ThreadRunner(model, control, threads - 1)
  if (threads > 1) { model.transportSlabs = 10; model.runner = runner }
  const g = model.grid, mb = (b: number) => Math.round(b / 2 ** 20)
  const arrays = Object.values(memory.buffers).reduce((s, b) => s + b.byteLength, 0)
  const stateBytes = saveState(model, config).byteLength
  console.log(`MeteoLab ${MODEL_VERSION} · ${series.name || path}: ${g.nx} × ${g.ny} × ${g.nz} = ${(g.n / 1e6).toFixed(2)} M nodes, ${(g.dx / 1000).toFixed(2)} × ${(g.dy / 1000).toFixed(2)} km, ${minutes} min, ${threads} threads`)
  console.log(`memory: ${mb(arrays)} MB of fields (${mb(process.memoryUsage().rss - rss0)} MB more in all); a saved state ${mb(stateBytes)} MB, ${Math.ceil(minutes * 60 / every)} of them ${mb(stateBytes * Math.ceil(minutes * 60 / every))} MB`)

  const stop = async (code: number) => { runner.stop(); for (const h of helpers) await h.terminate(); process.exit(code) }
  // The estimate: a few steps timed on a copy of the start (the run itself then starts from the start again).
  {
    const start = saveState(model, config)
    model.step(DT)
    const t0 = performance.now()
    for (let k = 0; k < PROBE_STEPS; k++) model.step(DT)
    const ms = (performance.now() - t0) / PROBE_STEPS, total = ms * minutes * 60 / DT / 1000
    console.log(`estimate: ${ms.toFixed(0)} ms a step, ${(ms / DT / 1000).toFixed(2)} s of compute per model second, ~${total < 5400 ? `${Math.ceil(total / 60)} min` : `${(total / 3600).toFixed(1)} h`} for ${minutes} min (from the quiet start: the progress lines show the pace as the storm grows)`)
    if (args.includes('estimate')) await stop(0)
    applyState(model, readState(start))
  }

  mkdirSync(out, { recursive: true })
  const stateName = (t: number) => join(out, `state-${(t / 60).toFixed(1).padStart(6, '0')}min.meteolab`), course = join(out, 'course.csv')
  const framesEvery = Number(option('frames') ?? 30), framesFile = join(out, 'frames.mlframes')
  if (args.includes('resume')) {
    const saved = readdirSync(out).filter(f => /^state-[\d.]+min\.meteolab$/.test(f)).sort().pop()
    if (!saved) { console.error(`${out}: no saved state to resume from`); await stop(1) }
    const buffer = readFileSync(join(out, saved!)), state = readState(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
    applyState(model, state)
    console.log(`resumed from ${saved} (minute ${Math.round(model.time / 60)})`)
    // What was written after the state (a run stopped without its pause state) goes: the course's rows and the frames.
    if (existsSync(course)) { const [head, ...rows] = readFileSync(course, 'utf8').trimEnd().split('\n'), at = head.split(',').indexOf('time_min'); writeFileSync(course, [head, ...rows.filter(r => Number(r.split(',')[at]) <= model.time / 60 + 1e-6)].join('\n') + '\n') }
    if (existsSync(framesFile)) {
      const fd = openSync(framesFile, 'r'), size = statSync(framesFile).size
      const read = async (o: number, n: number) => { const b = new Uint8Array(n); readSync(fd, b, 0, n, o); return b }
      const { start } = readFramesHeader(await read(0, Math.min(size, 65536))), kept = (await frameIndex(read, size, start)).filter(f => f.time <= model.time + .5)
      closeSync(fd); truncateSync(framesFile, kept.length ? kept[kept.length - 1].offset + kept[kept.length - 1].length : start)
    }
  }
  if (framesEvery > 0 && (!existsSync(framesFile) || !args.includes('resume'))) { writeFileSync(framesFile, framesHeader(config, g, framesEvery)); appendFileSync(framesFile, await encodeFrame(model)) }

  type Row = { t: number; d: ReturnType<AtmosphereModel['diagnostics']>; uh: number; zeta: number; meso: number }
  const columns: [string, (r: Row) => number | string][] = [
    ...stampColumns<Row>(() => config.seed), ['time_min', r => r.t / 60], ['spacing_km', () => g.dx / 1000],
    ['updraft_ms', r => r.d.updraft], ['downdraft_ms', r => r.d.downdraft], ['uh_2_5km_m2s2', r => r.uh], ['core_zeta_s1', r => r.zeta], ['mesocyclone_s', r => r.meso],
    ['rain_rate_mmh', r => r.d.rainRate], ['rain_total_mm', r => r.d.rainTotal], ['cloud_top_km', r => r.d.cloudTop], ['gust_ms', r => r.d.gust], ['hail_cm', r => r.d.hail], ['cold_pool_K', r => r.d.outflow], ['clipped', r => r.d.clipped],
  ]
  const row = (): Row => ({ t: model.time, d: model.diagnostics(), uh: model.rotation.uh, zeta: model.rotation.coreZeta, meso: model.rotation.persisted })
  if (!existsSync(course) || !args.includes('resume')) writeFileSync(course, toCsv([row()], columns))

  // Ctrl+C or a file "pause" in the output folder: the state now is saved and the run can resume from it.
  let paused = false
  process.on('SIGINT', () => { paused = true })
  const pauseFile = join(out, 'pause')
  const started = performance.now(), from = model.time, end = minutes * 60
  let last = started
  while (model.time < end - 1e-6) {
    model.step(DT); model.time += DT
    const t = Math.round(model.time)
    if (t % ROW_EVERY === 0) appendFileSync(course, toCsv([row()], columns).split('\n')[1] + '\n')
    if (framesEvery > 0 && t % framesEvery === 0) appendFileSync(framesFile, await encodeFrame(model))
    if (t % every === 0 || t >= end) writeFileSync(stateName(model.time), new Uint8Array(saveState(model, config)))
    const now = performance.now()
    if (now - last > 10_000) {
      last = now
      if (existsSync(pauseFile)) { rmSync(pauseFile); paused = true }
      const rate = (now - started) / 1000 / (model.time - from), left = rate * (end - model.time)
      console.log(`minute ${(model.time / 60).toFixed(1)} of ${minutes} · ${(rate * DT * 1000).toFixed(0)} ms a step · ~${Math.ceil(left / 60)} min left · w ${model.diagnostics().updraft.toFixed(1)} m/s`)
    }
    // Let the signal in between steps.
    await new Promise(r => setImmediate(r))
    if (paused) {
      writeFileSync(stateName(model.time), new Uint8Array(saveState(model, config)))
      console.log(`\npaused at minute ${(model.time / 60).toFixed(1)}: ${stateName(model.time)}; go on with the same command and "resume"`)
      await stop(130)
    }
  }
  console.log(`done: ${minutes} min in ${((performance.now() - started) / 60000).toFixed(1)} min; ${course}${framesEvery > 0 ? `, ${framesFile} (${Math.round(statSync(framesFile).size / 2 ** 20)} MB)` : ''}, states in ${out}`)
  await stop(0)
}

/** The courses of precise and live runs side by side (npm run precise -- compare a b …). */
function compare(paths: string[]) {
  if (paths.length < 2) { console.error('usage: npm run precise -- compare <run folder or course.csv> <another> …'); process.exit(2) }
  const runs = paths.map(p => {
    const file = p.endsWith('.csv') ? p : join(p, 'course.csv'), [head, ...lines] = readFileSync(file, 'utf8').trimEnd().split('\n')
    const names = head.split(','), rows = lines.map(l => l.split(','))
    const col = (name: string) => { const k = names.indexOf(name); return rows.map(r => Number(r[k])) }
    return { name: p, col }
  })
  const fmt = (v: number, d = 1) => Number.isFinite(v) ? v.toFixed(d) : '—'
  const peak = (name: string, d = 1, sign = 1) => (r: typeof runs[0]) => {
    const v = r.col(name).map(x => sign * x), t = r.col('time_min'), k = v.indexOf(Math.max(...v))
    return `${fmt(sign * v[k], d)} (${fmt(t[k], 1)} min)`
  }
  const first = (name: string, at: number) => (r: typeof runs[0]) => { const v = r.col(name), t = r.col('time_min'), k = v.findIndex(x => x >= at); return k < 0 ? '—' : `${fmt(t[k], 1)} min` }
  const last = (name: string, d = 1) => (r: typeof runs[0]) => fmt(r.col(name).at(-1)!, d)
  const lines: [string, (r: typeof runs[0]) => string][] = [
    ['spacing, km', r => fmt(r.col('spacing_km')[0], 2)],
    ['updraught peak, m/s', peak('updraft_ms')], ['downdraught peak, m/s', peak('downdraft_ms')],
    ['UH 2–5 km peak, m²/s²', peak('uh_2_5km_m2s2', 0)], ['core vorticity peak, 1/s', peak('core_zeta_s1', 4)],
    ['rain rate peak, mm/h', peak('rain_rate_mmh', 0)], ['rain total at the end, mm', last('rain_total_mm')],
    ['cloud top peak, km', peak('cloud_top_km')], ['gust peak, m/s', peak('gust_ms')], ['hail peak, cm', peak('hail_cm')],
    ['cold pool peak, K', peak('cold_pool_K')],
    ['updraught ≥ 10 m/s from', first('updraft_ms', 10)], ['first rain ≥ 1 mm/h', first('rain_rate_mmh', 1)],
    ['mesocyclone (10 min of core rotation)', first('mesocyclone_s', 600)], ['clipped nodes, sum', r => fmt(r.col('clipped').reduce((a, b) => a + b, 0), 0)],
  ]
  console.log(`| | ${runs.map(r => r.name).join(' | ')} |\n|---|${runs.map(() => '---').join('|')}|`)
  for (const [label, f] of lines) console.log(`| ${label} | ${runs.map(f).join(' | ')} |`)
}
