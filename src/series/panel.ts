import { decimal, L } from '../i18n'
import type { SimConfig } from '../core'
import { help, instrumentPalette, instrumentScreen, press, section } from '../instrument'
import { MONO } from '../theme'
import { download } from '../share'
import { memberPeaks, type MemberPeaks } from '../ensemble/combine'
import type { MemberResult } from '../ensemble/member'
import { poolSize, runPool } from '../ensemble/pool'
import { MODEL_VERSION } from '../version'
import { checkKnobs, expandSeries, MAX_RUNS, MINUTES, parseSeries, type Series, type SeriesRun } from './series'
import { seriesCsv, seriesNetCDF } from './results'

/** What the chart shows of each run: its highest value over the run. */
const QUANTITIES = {
  updraft: { name: L('поток', 'updraught'), unit: L('м/с', 'm/s'), of: (p: MemberPeaks) => p.updraft },
  uh: { name: 'UH', unit: L('м²/с²', 'm²/s²'), of: (p: MemberPeaks) => p.uh },
  rainTotal: { name: L('осадки', 'rain'), unit: L('мм', 'mm'), of: (p: MemberPeaks) => p.rainTotal },
  hail: { name: L('град', 'hail'), unit: L('мм', 'mm'), of: (p: MemberPeaks) => p.hail },
  gust: { name: L('ветер', 'wind'), unit: L('м/с', 'm/s'), of: (p: MemberPeaks) => p.gust },
} as const
type Quantity = keyof typeof QUANTITIES
const QUANTITY_TITLES: Record<Quantity, string> = { updraft: L('Восходящий поток', 'Updraught'), uh: 'UH 2–5 км', rainTotal: L('Сумма осадков в точке', 'Rain total at a point'), hail: L('Град у земли', 'Hail at the ground'), gust: L('Ветер у земли', 'Surface wind') }
/** The second knob's values, by colour. */
const COLOURS = ['#6fb4ff', '#f0605a', '#a3e05a', '#ffb347', '#e879c6', '#59d4c8', '#c9a0ff', '#d0d0d0']

/**
 * Batch series (roadmap E3), a screen like the instruments': a series file (written here, opened or made from the
 * current settings), its runs off the main thread as the ensemble's members, the live run paused meanwhile; a chart of
 * one highlight against the first knob (coloured by the second), and the results as CSV and NetCDF.
 */
export class SeriesPanel {
  private readonly root: HTMLDivElement; private readonly canvas: HTMLCanvasElement; private readonly ctx: CanvasRenderingContext2D
  private readonly editor: HTMLTextAreaElement
  private series: Series | null = null; private source = ''
  private runs: SeriesRun[] = []; private results: (MemberResult | null)[] = []; private peaks: (MemberPeaks | null)[] = []
  /** The series the results are of (the editor may have changed since). */
  private ran: { series: Series; text: string } | null = null
  private running: { started: number; times: ReadonlyMap<number, number>; stop: () => void } | null = null
  private quantity: Quantity = 'updraft'
  open = false
  /** A series file of the settings going on. */
  template: () => string = () => ''
  /** The base settings of a series: the defaults with its scenario and settings laid over. */
  base: (series: Series) => SimConfig = () => { throw new Error('no settings') }
  scenarios: () => readonly string[] = () => []
  /** Called with true when the series starts (the live run pauses), false when it ends or is stopped. */
  onRunning: (running: boolean) => void = () => {}

  constructor(host: HTMLElement) {
    this.root = instrumentScreen(host, 'series-app', L('METEOLAB · ПАКЕТНАЯ СЕРИЯ', 'METEOLAB · BATCH SERIES'),
      `<span>${L('ОПЫТЫ', 'RUNS')} <b id="serCount">—</b></span><span>${L('СЕРИЯ', 'SERIES')} <b id="serName">—</b></span><span id="serLeft"></span>`,
      section(L('Файл серии', 'Series file'), `<textarea class="series-editor" id="serText" spellcheck="false" rows="16" aria-label="${L('Файл серии (JSON)', 'Series file (JSON)')}"></textarea>
          <p class="psec__hint" id="serCheck"></p>
          <button class="btn btn--block" id="serTemplate" title="${L('Записать в поле файл серии из настроек, которые идут сейчас: сценарий, изменённые настройки, зерно; перебор — образец, его можно поменять', 'Put a series file of the settings going on into the field: the scenario, the changed settings, the seed; the knobs are a sample to change')}">${L('Из текущих настроек', 'From the current settings')}</button>
          <div class="side__row"><button class="btn" id="serOpenFile">${L('Открыть…', 'Open…')}</button><button class="btn" id="serSave">${L('Сохранить', 'Save')}</button></div>
          <input type="file" id="serFile" accept=".json,application/json" hidden>`)
      + section(L('Расчёт', 'Computation'), `<button class="btn btn--block btn--primary" id="serStart">${L('Запустить', 'Run')}</button><progress id="serBar" max="1" value="0" hidden></progress><p class="psec__hint" id="serHint"></p>`)
      + section(L('Итог', 'Results'), `<span class="t-caption">${L('На графике — наибольшее за опыт', 'The chart shows the highest over a run')}</span><div class="seg seg--block seg--instrument" data-seg="quantity">${Object.entries(QUANTITIES).map(([k, q]) => `<button data-value="${k}">${q.name}</button>`).join('')}</div>
          <div class="side__row"><button class="btn" id="serCsv" title="${L('Строка на опыт: версия, зерно, ссылка, значения ручек, CAPE, сдвиг, SRH, режим, пики', 'A row per run: the version, seed, link, the knobs’ values, CAPE, shear, SRH, the regime, the peaks')}">CSV</button><button class="btn" id="serNc" title="${L('Все опыты одним файлом: ход каждого по минутам и следы на земле (осадки, град, ветер, UH), файл серии в атрибутах', 'Every run in one file: each one’s course by the minute and swaths on the ground (rain, hail, wind, UH), the series file in the attributes')}">NetCDF</button></div>`)
      + help(L(`Пакетная серия — много опытов по одному файлу: базовые настройки (сценарий и настройки поверх него), перебор ручек и зёрна. Опыты — все сочетания значений (первая ручка меняется медленнее всех) на каждое зерно; считаются без 3D-вида, по одному на ядро, живой расчёт на это время на паузе. Ручки — любая числовая настройка под своим именем (surfaceTemp, wind6, rhLow, capStrength…) и четыре из простых настроек: heat_K — воздух у земли теплее на столько K, moisture_factor — пар ниже 1,5 км во столько раз, shear_0_6km_ms — сдвиг 0–6 км в м/с (форма годографа сохраняется), turn_0_3km_deg — поворот ветра от земли до 3 км; они действуют после настроек в этом порядке. «seeds» — число зёрен (от first_seed) или их список: тот же файл даёт те же опыты. До ${MAX_RUNS} опытов по ${MINUTES.min}–${MINUTES.max} мин. Итог: CSV — строка на опыт с его ссылкой (открыв её, получите этот опыт на 3D-виде), NetCDF — все опыты сразу, с файлом серии в атрибутах.`, `A batch series is many runs from one file: the base settings (a scenario and settings over it), knobs to vary and seeds. The runs are every combination of the values (the first knob slowest) for each seed; they go without the 3D view, one per core, with the live run paused meanwhile. A knob is any numeric setting by its name (surfaceTemp, wind6, rhLow, capStrength…) or one of four from the simple settings: heat_K — the air near the ground warmer by so many K, moisture_factor — the vapour below 1.5 km times this, shear_0_6km_ms — the 0–6 km shear in m/s (the hodograph’s shape kept), turn_0_3km_deg — the wind’s turning from the ground to 3 km; they act after the settings, in this order. “seeds” is a count of seeds (from first_seed) or their list: the same file gives the same runs. Up to ${MAX_RUNS} runs of ${MINUTES.min}–${MINUTES.max} min. Results: CSV — a row per run with its link (open it to get that run in the 3D view), NetCDF — every run at once, with the series file in its attributes.`)))
    this.canvas = this.root.querySelector('canvas')!; this.ctx = this.canvas.getContext('2d')!
    this.editor = this.root.querySelector<HTMLTextAreaElement>('#serText')!
    this.root.querySelector('.ibar__close')!.addEventListener('click', () => this.toggle(false))
    this.editor.addEventListener('input', () => this.check())
    this.root.querySelector('#serTemplate')!.addEventListener('click', () => { this.editor.value = this.template(); this.check() })
    const file = this.root.querySelector<HTMLInputElement>('#serFile')!
    this.root.querySelector('#serOpenFile')!.addEventListener('click', () => file.click())
    file.addEventListener('change', async () => { const f = file.files?.[0]; if (f) { this.editor.value = await f.text(); this.check() } file.value = '' })
    this.root.querySelector('#serSave')!.addEventListener('click', () => download(`${this.fileName()}.json`, this.editor.value, 'application/json'))
    this.root.querySelector('#serStart')!.addEventListener('click', () => this.running ? this.stop() : this.start())
    this.root.querySelector('[data-seg="quantity"]')!.addEventListener('click', e => {
      const v = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.value
      if (v) { this.quantity = v as Quantity; this.draw() }
    })
    this.root.querySelector('#serCsv')!.addEventListener('click', () => {
      if (this.ran) download(`${this.fileName()}.csv`, seriesCsv(this.ran.series.vary.map(([k]) => k), this.runs, this.results))
    })
    this.root.querySelector('#serNc')!.addEventListener('click', () => {
      const nc = this.ran && seriesNetCDF(this.ran.series.vary.map(([k]) => k), this.runs, this.results, { name: this.ran.series.name, version: MODEL_VERSION, text: this.ran.text })
      if (nc) download(`${this.fileName()}.nc`, nc, 'application/x-netcdf')
    })
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.open && document.activeElement !== this.editor) this.toggle(false) })
    addEventListener('resize', () => this.open && this.draw())
  }

  toggle(open = !this.open) {
    this.open = open; this.root.hidden = !open
    if (open && !this.editor.value) { this.editor.value = this.template(); this.check() }
    if (open) this.draw()
  }

  /** Latin letters only: netCDF-C on Windows does not open a path with Cyrillic in it. */
  private fileName() {
    const s = this.ran?.series ?? this.series, name = (s?.name ?? '').replace(/[^A-Za-z0-9-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
    return `meteolab-seriya-${name || s?.seeds[0] || 'new'}`
  }

  /** Reads the editor: the series and what it will cost, or what is wrong. */
  private check() {
    const r = parseSeries(this.editor.value, this.scenarios())
    this.series = 'series' in r ? r.series : null; this.source = this.editor.value
    let runs = 0, error = 'error' in r ? r.error : ''
    if (this.series) try { runs = this.series.vary.reduce((n, [, v]) => n * v.length, this.series.seeds.length); checkKnobs(this.series, this.base(this.series)) } catch (e) { error = (e as Error).message; this.series = null }
    const check = this.root.querySelector<HTMLElement>('#serCheck')!
    check.classList.toggle('is-error', !!error)
    if (error) check.textContent = `${L('Ошибка в файле', 'Error in the file')}: ${error}`
    else if (this.series) {
      // ~2.5 min of a core per model hour on the standard domain.
      const parallel = poolSize(runs), wall = runs * this.series.minutes / 60 * 2.5 / Math.min(parallel, runs)
      check.textContent = L(`${runs} опытов по ${this.series.minutes} мин, по ${parallel} сразу: ~${wall < 90 ? `${Math.max(1, Math.round(wall))} мин` : `${decimal(wall / 60, 1)} ч`} (на стандартной области ~2–3 мин на модельный час на ядро).`, `${runs} runs of ${this.series.minutes} min, ${parallel} at once: ~${wall < 90 ? `${Math.max(1, Math.round(wall))} min` : `${decimal(wall / 60, 1)} h`} (on the standard domain ~2–3 min per model hour on a core).`)
    }
    this.draw()
  }

  private start() {
    if (!this.series) return
    const series = this.series
    try { this.runs = expandSeries(series, this.base(series)) } catch (e) { this.show('serHint', (e as Error).message); return }
    this.ran = { series, text: this.source }
    this.results = this.runs.map(() => null); this.peaks = this.runs.map(() => null)
    const running = { started: performance.now(), times: new Map<number, number>() as ReadonlyMap<number, number>, stop: () => {} }
    this.running = running
    running.stop = runPool(this.runs.map(r => r.config), series.minutes, {
      progress: times => { running.times = times; this.progress() },
      done: (k, result) => { this.results[k] = result; this.peaks[k] = memberPeaks(result); this.draw() },
      error: message => { this.stop(); this.show('serHint', `${L('Ошибка расчёта', 'Computation error')}: ${message}`) },
      finish: () => { this.running = null; this.onRunning(false); this.draw() },
    })
    this.onRunning(true); this.draw()
  }

  /** Stops the runs still going; the finished ones stay. */
  stop() {
    if (this.running) { this.running.stop(); this.running = null; this.onRunning(false) }
    this.draw()
  }

  private show(id: string, v: string) { (this.root.querySelector(`#${id}`) as HTMLElement).innerHTML = v }
  private get done() { return this.results.filter(Boolean).length }

  private progress() {
    const r = this.running
    if (!r || !this.ran) return
    const end = this.ran.series.minutes * 60, done = (this.done * end + [...r.times.values()].reduce((s, t) => s + t, 0)) / (this.runs.length * end)
    const bar = this.root.querySelector<HTMLProgressElement>('#serBar')!
    bar.hidden = false; bar.value = done
    const elapsed = (performance.now() - r.started) / 1000, left = done > .02 ? elapsed * (1 - done) / done : NaN
    this.show('serLeft', Number.isFinite(left) ? L(`ОСТАЛОСЬ ~<b>${Math.ceil(left / 60)} МИН</b>`, `LEFT ~<b>${Math.ceil(left / 60)} MIN</b>`) : '')
    this.show('serCount', `${this.done} / ${this.runs.length}`)
    this.paint()
  }

  private draw() {
    const running = !!this.running, n = this.done
    press(this.root.querySelectorAll<HTMLElement>('[data-seg="quantity"] button'), b => b.dataset.value === this.quantity)
    const start = this.root.querySelector<HTMLButtonElement>('#serStart')!
    start.textContent = running ? L('Остановить', 'Stop') : n ? L('Запустить заново', 'Run again') : L('Запустить', 'Run')
    start.disabled = !running && !this.series
    for (const id of ['#serTemplate', '#serOpenFile']) this.root.querySelector<HTMLButtonElement>(id)!.disabled = running
    this.editor.readOnly = running
    this.root.querySelector<HTMLProgressElement>('#serBar')!.hidden = !running
    this.show('serCount', running ? `${n} / ${this.runs.length}` : n ? String(n) : '—')
    this.root.querySelector('#serName')!.textContent = this.ran?.series.name || this.series?.name || '—'
    if (!running) this.show('serLeft', '')
    this.show('serHint', running ? L(`Опытов сразу: ${Math.min(poolSize(this.runs.length), this.runs.length - n)}; живой расчёт на паузе. Остановка сохраняет законченные.`, `Runs at once: ${Math.min(poolSize(this.runs.length), this.runs.length - n)}; the live run is paused. Stopping keeps the finished ones.`)
      : n ? L(`Готово опытов: ${n} из ${this.runs.length}.`, `Runs done: ${n} of ${this.runs.length}.`) : L('Серия считается в фоне, по одному опыту на ядро.', 'The series runs in the background, one run per core.'))
    for (const id of ['#serCsv', '#serNc']) this.root.querySelector<HTMLButtonElement>(id)!.disabled = !n
    this.paint()
  }

  /** One highlight of every finished run against the first knob, coloured by the second; the seeds' mean joined. */
  private paint() {
    const c = this.canvas, host = c.parentElement!, dpr = Math.min(devicePixelRatio, 2), w = host.clientWidth, h = host.clientHeight, ctx = this.ctx
    if (!this.open || !w) return
    c.style.width = `${w}px`; c.style.height = `${h}px`
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const pal = instrumentPalette(this.root)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, w, h); ctx.font = `12px ${MONO}`
    const series = this.ran?.series ?? this.series, q = QUANTITIES[this.quantity]
    if (!series) { ctx.fillStyle = pal.label; ctx.fillText(L('Нет серии: исправьте файл справа', 'No series: fix the file on the right'), 24, 32); return }
    const [first, second] = series.vary, xs = first ? first[1] : series.seeds.map((_, k) => k), groups = second ? second[1] : [null]
    const left = 64, right = 24, top = 44, bottom = 64, pw = w - left - right, ph = h - top - bottom
    const points = this.runs.flatMap(run => { const p = this.peaks[run.index]; return p && this.ran ? [{ run, v: q.of(p) }] : [] })
    const xOf = (run: SeriesRun) => first ? first[1].indexOf(run.params[first[0]]) : series.seeds.indexOf(run.seed)
    const vMax = Math.max(1, ...points.map(p => p.v)) * 1.1, pad = 24, X = (k: number) => left + pad + (pw - 2 * pad) * (xs.length > 1 ? k / (xs.length - 1) : .5), Y = (v: number) => top + ph * (1 - v / vMax)
    ctx.fillStyle = pal.text
    ctx.fillText(`${QUANTITY_TITLES[this.quantity]}, ${q.unit} — ${L('наибольшее за опыт', 'highest over the run')}${series.name ? ` · ${series.name}` : ''}`, left, 22)
    // The value axis.
    ctx.strokeStyle = pal.grid; ctx.lineWidth = 1; ctx.fillStyle = pal.label
    const step = niceStep(vMax / 5)
    for (let v = 0; v <= vMax; v += step) { const y = Y(v); ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(w - right, y); ctx.stroke(); ctx.fillText(decimal(v, step < 1 ? 1 : 0), 8, y + 4) }
    // The knob's axis.
    xs.forEach((x, k) => { const label = first ? String(x) : `#${k + 1}`; ctx.fillText(label, X(k) - ctx.measureText(label).width / 2, top + ph + 18) })
    ctx.fillStyle = pal.text; ctx.fillText(first ? `${first[0]} →` : L('зерно →', 'seed →'), left, top + ph + 38)
    // Each group's runs, and the mean over its seeds joined across the knob's values.
    // The legend: the second knob's name, then a swatch per value.
    let lx = left
    if (second) { ctx.fillStyle = pal.label; ctx.fillText(`${second[0]}:`, lx, h - 9); lx += ctx.measureText(`${second[0]}:`).width + 12 }
    groups.forEach((g, gi) => {
      const colour = COLOURS[gi % COLOURS.length], mine = points.filter(p => !second || p.run.params[second[0]] === g)
      ctx.strokeStyle = colour; ctx.lineWidth = 1.5; ctx.beginPath(); let started = false
      xs.forEach((_, k) => {
        const at = mine.filter(p => xOf(p.run) === k)
        if (!at.length || !first) return
        const mean = at.reduce((s, p) => s + p.v, 0) / at.length
        if (started) ctx.lineTo(X(k), Y(mean)); else { ctx.moveTo(X(k), Y(mean)); started = true }
      })
      ctx.stroke()
      ctx.fillStyle = colour
      for (const p of mine) { ctx.beginPath(); ctx.arc(X(xOf(p.run)) + (groups.length > 1 ? (gi - (groups.length - 1) / 2) * 4 : 0), Y(p.v), 3.5, 0, 2 * Math.PI); ctx.fill() }
      if (second) { ctx.fillRect(lx, h - 18, 10, 10); ctx.fillStyle = pal.label; ctx.fillText(String(g), lx + 14, h - 9); lx += 14 + ctx.measureText(String(g)).width + 16 }
    })
    if (!points.length) { ctx.fillStyle = pal.label; ctx.fillText(this.running ? L('Считается… точки появятся по мере опытов', 'Running… the points come as the runs finish') : L('Запустите серию: здесь будет по точке на опыт', 'Run the series: a point per run will be here'), left + 12, top + 20) }
  }
}

/** A round step (1, 2 or 5 times a power of ten) near `raw`. */
function niceStep(raw: number) { const p = 10 ** Math.floor(Math.log10(raw)), k = raw / p; return (k < 1.5 ? 1 : k < 3.5 ? 2 : k < 7.5 ? 5 : 10) * p }
