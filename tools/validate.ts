// The validation report (roadmap A1): runs every case of src/validation/cases.ts, one per core in worker_threads, and
// writes docs/validation.md (and .json beside it) — each quantity with the model's value, the reference, the bounds and
// the source, with the model's version, the date and the machine — and, apart, the known deviations from nature
// (src/validation/deviations.ts, roadmap A7) measured on the same model: their bounds are nature's, they are expected
// outside them and do not count towards the exit status.
//   npm run validate -- [only=straka,bryan-fritsch] [threads=N] [out=docs/validation.md] [deviations=0]
// All the cases take ~2 h of one core (~25 min on 8), the deviations ~40 min more. Exits 1 if a check is outside its bounds.
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { availableParallelism, cpus } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CASES, type CaseResult, type Check, passes } from '../src/validation/cases'
import { DEVIATIONS, QUALITATIVE } from '../src/validation/deviations'
import { MODEL_VERSION } from '../src/version'

interface Done { id: string; result?: CaseResult; error?: string; seconds: number }

if (!isMainThread) {
  const c = [...CASES, ...DEVIATIONS].find(x => x.id === workerData.id)!, started = Date.now()
  let done: Done
  try { done = { id: c.id, result: c.run(), seconds: (Date.now() - started) / 1000 } } catch (e) { done = { id: c.id, error: String((e as Error).stack ?? e), seconds: (Date.now() - started) / 1000 } }
  parentPort!.postMessage(done)
} else {
  const args = process.argv.slice(2), option = (name: string) => args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
  const only = option('only')?.split(','), out = option('out') ?? 'docs/validation.md'
  const all = option('deviations') === '0' ? CASES : [...CASES, ...DEVIATIONS], deviating = new Set(DEVIATIONS.map(d => d.id))
  const cases = only ? all.filter(c => only.includes(c.id)) : all
  if (!cases.length) { console.error(`no such cases: ${only}; there are ${all.map(c => c.id).join(', ')}`); process.exit(2) }
  const threads = Math.max(1, Math.min(cases.length, Number(option('threads') ?? availableParallelism())))
  // The longest first, so the last to start is a short one.
  const queue = [...cases].sort((a, b) => b.minutes - a.minutes), results: Done[] = [], started = Date.now()
  console.log(`MeteoLab ${MODEL_VERSION}: ${cases.length} cases, ${threads} at once`)
  const start = () => {
    const c = queue.shift()
    if (!c) return
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { id: c.id } })
    w.once('message', (d: Done) => {
      results.push(d)
      const bad = d.result?.checks.filter(x => !passes(x)).length
      console.log(`${d.error ? 'ERROR' : deviating.has(c.id) ? `deviation (${bad} of ${d.result!.checks.length} outside nature)` : bad ? `${bad} OUTSIDE` : 'ok'} · ${c.title} · ${Math.round(d.seconds / 60)} min`)
      void w.terminate(); start()
      if (results.length === cases.length) finish()
    })
    w.once('error', e => { results.push({ id: c.id, error: String(e), seconds: 0 }); start(); if (results.length === cases.length) finish() })
  }
  for (let k = 0; k < threads; k++) start()

  function finish() {
    const done = cases.map(c => ({ c, d: results.find(r => r.id === c.id)! })), ordered = done.filter(x => !deviating.has(x.c.id)), deviations = done.filter(x => deviating.has(x.c.id))
    const checks = ordered.flatMap(x => x.d.result?.checks ?? []), within = checks.filter(passes).length, errors = ordered.filter(x => x.d.error)
    const date = new Date().toISOString().slice(0, 10), minutes = Math.round((Date.now() - started) / 60000)
    const lines = [
      '# MeteoLab StormLab — validation report',
      '',
      `Model version **${MODEL_VERSION}**, ${date}. ${only ? `Partial run: ${cases.map(c => c.id).join(', ')}. ` : ''}Node ${process.version}, ${cpus()[0]?.model.trim() ?? 'unknown CPU'}, ${threads} at once, ${minutes} min.`,
      '',
      `**${within} of ${checks.length} checks within their bounds**${errors.length ? `, ${errors.length} case(s) failed to run` : ''}.`,
      '',
      'Each case runs the model and compares what it gives with the literature or with what the case is meant to show. The bounds hold the model’s current result with a margin, so a change of the physics that moves a result shows here; where the model is known to be off the reference, the bounds say so and the reference lies outside them (see the case’s note and the roadmap, A4 and A7). Made by `npm run validate`; the cases, their references and bounds are in `src/validation/cases.ts`, and the slow tests check the same bounds.',
      '',
    ]
    // Numbers with a true minus; the model's to two decimals, the bounds as written.
    const minus = (t: string) => t.replace(/^-/, '−'), num = (v: number) => minus(Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(2)), plain = (v: number) => minus(String(Number(v.toFixed(2))))
    const bound = ([lo, hi]: readonly [number, number]) => lo === hi ? `= ${plain(lo)}` : lo === -Infinity ? `≤ ${plain(hi)}` : hi === Infinity ? `≥ ${plain(lo)}` : `${plain(lo)} … ${plain(hi)}`
    for (const { c, d } of ordered) {
      lines.push(`## ${c.title}`, '', `Source: ${c.source}. Run time ${Math.round(d.seconds / 60)} min.`, '')
      if (d.error) { lines.push('**The case failed to run:**', '', '```', d.error, '```', ''); continue }
      lines.push('| Quantity | Model | Reference | Bounds | |', '|---|---:|---|---|:-:|')
      for (const k of d.result!.checks as Check[]) lines.push(`| ${k.quantity}${k.unit ? `, ${k.unit}` : ''} | ${num(k.value)} | ${k.reference} | ${bound(k.bounds)} | ${passes(k) ? '✓' : '✗'} |`)
      lines.push('')
      if (d.result!.note) lines.push(d.result!.note, '')
    }
    if (deviations.length || !only) {
      lines.push('## Known deviations from nature (roadmap A7)', '', 'Measured on the same model; the bounds here are the range observed in nature, so ✗ is expected until the roadmap item named fixes it (the slow test `src/core/deviations.test.ts` marks each one `it.fails`). They do not count in the total above. The cases are in `src/validation/deviations.ts`.', '')
      for (const { c, d } of deviations) {
        const dev = DEVIATIONS.find(x => x.id === c.id)!
        lines.push(`### ${c.title}`, '', `Nature: ${c.source}. Cause: ${dev.cause}. Fixed by: ${dev.plan}. Run time ${Math.round(d.seconds / 60)} min.`, '')
        if (d.error) { lines.push('**The case failed to run:**', '', '```', d.error, '```', ''); continue }
        lines.push('| Quantity | Model | Nature | |', '|---|---:|---|:-:|')
        for (const k of d.result!.checks as Check[]) lines.push(`| ${k.quantity}${k.unit ? `, ${k.unit}` : ''} | ${num(k.value)} | ${k.reference} | ${passes(k) ? '✓' : '✗'} |`)
        lines.push('')
        if (d.result!.note) lines.push(d.result!.note, '')
      }
      lines.push('Without a number to test yet:', '', ...QUALITATIVE.map(q => `- **${q.title}** — ${q.measured} (${q.plan}).`), '')
    }
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, lines.join('\n'))
    writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify({ version: MODEL_VERSION, date, node: process.version, cases: ordered.map(({ c, d }) => ({ id: c.id, title: c.title, source: c.source, seconds: d.seconds, error: d.error, ...d.result })), deviations: deviations.map(({ c, d }) => ({ id: c.id, title: c.title, source: c.source, seconds: d.seconds, error: d.error, ...d.result })) }, null, 2))
    console.log(`${within} of ${checks.length} checks within bounds → ${out}`)
    process.exit(within === checks.length && !errors.length ? 0 : 1)
  }
}
