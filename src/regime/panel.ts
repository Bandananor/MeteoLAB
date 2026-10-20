import { decimal, L } from '../i18n'
import type { SimConfig } from '../core'
import { help, instrumentPalette, instrumentScreen, press, readings, section } from '../instrument'
import { MONO } from '../theme'
import { download, toCsv } from '../share'
import { memberPeaks, type MemberPeaks } from '../ensemble/combine'
import type { MemberResult } from '../ensemble/member'
import { poolSize, runPool } from '../ensemble/pool'
import { environmentOf, GRIDS, type GridSize, type Regime, regimeCells, type RegimeCell, regimeOf } from './grid'

/** The runs' lengths, min: longer than an ordinary cell's life (CELL_LIFE), so its decay is seen. */
const LENGTHS = [45, 60, 90]
const REGIMES: Record<Regime, { name: string; colour: string }> = {
  none: { name: L('нет грозы', 'no storm'), colour: '#59646b' },
  ordinary: { name: L('одиночная', 'ordinary'), colour: '#6fb4ff' },
  multicell: { name: L('многоячейковая', 'multicell'), colour: '#a3e05a' },
  supercell: { name: L('суперячейка', 'supercell'), colour: '#f0605a' },
}

/**
 * The regime map (2.9), a screen like the instruments': the run going on, its seed and all, on a grid of boundary-layer
 * moisture (rows, so the CAPE) by 0-6 km shear (columns), every cell run off the main thread as the ensemble's members
 * (src/ensemble/pool.ts); the live run pauses meanwhile. Each cell is coloured by the kind of storm it grew and shows its
 * updraught's course, as the Weisman-Klemp (1982) diagram; a cell can be taken into the live run.
 */
export class RegimePanel {
  private readonly root: HTMLDivElement; private readonly canvas: HTMLCanvasElement; private readonly ctx: CanvasRenderingContext2D
  private size: GridSize = 'full'; private minutes = 60
  private cells: RegimeCell[] = []; private results: (MemberResult | null)[] = []; private peaks: (MemberPeaks | null)[] = []
  private running: { started: number; times: ReadonlyMap<number, number>; stop: () => void } | null = null
  /** The settings the map was made from: their own shear and CAPE mark where they stand on it. */
  private base: { name: string; shear: number } | null = null
  private chosen: number | null = null
  /** The cells' boxes on the canvas, for clicks. */
  private boxes: { index: number; x: number; y: number; w: number; h: number }[] = []
  open = false
  /** The settings and the name of the run going on. */
  current: () => { config: SimConfig; name: string } = () => { throw new Error('no settings') }
  /** Called with true when the map starts (the live run pauses), false when it ends or is stopped. */
  onRunning: (running: boolean) => void = () => {}
  /** Takes a cell's settings into the live run. */
  onApply: (config: SimConfig) => void = () => {}

  constructor(host: HTMLElement) {
    const seg = (name: string, options: [string | number, string][]) => `<div class="seg seg--block seg--instrument" data-seg="${name}">${options.map(([v, t]) => `<button data-value="${v}">${t}</button>`).join('')}</div>`
    const dims = (k: GridSize) => `${GRIDS[k].moisture.length} × ${GRIDS[k].shear.length}`
    this.root = instrumentScreen(host, 'regime-app', L('METEOLAB · КАРТА РЕЖИМОВ', 'METEOLAB · REGIME MAP'),
      `<span>${L('ОПЫТЫ', 'RUNS')} <b id="regCount">—</b></span><span>${L('ОПЫТ', 'RUN')} <b id="regName">—</b></span><span id="regLeft"></span>`,
      section(L('Карта режимов', 'Regime map'), `<span class="t-caption">${L('Сетка: влажность × сдвиг', 'Grid: moisture × shear')}</span>${seg('size', [['small', dims('small')], ['full', dims('full')]])}
          <span class="t-caption">${L('Длительность, мин', 'Length, min')}</span>${seg('minutes', LENGTHS.map(n => [n, String(n)]))}
          <button class="btn btn--block btn--primary" id="regStart">${L('Запустить', 'Run')}</button>
          <progress id="regBar" max="1" value="0" hidden></progress>
          <p class="psec__hint" id="regHint"></p>`)
      + section(L('Клетка', 'Cell'), `<dl class="kv" id="regCell"></dl><button class="btn btn--block" id="regApply" title="${L('Перезапустить живой опыт с влажностью и сдвигом этой клетки', 'Restart the live run with this cell’s moisture and shear')}">${L('Взять в опыт', 'Take into the run')}</button><button class="btn btn--block" id="regCsv" title="${L('Каждая клетка в CSV: влажность, CAPE, сдвиг, режим, пики', 'Every cell as CSV: moisture, CAPE, shear, regime, peaks')}">${L('Выгрузить CSV', 'Export CSV')}</button>`)
      + help(L(`Карта режимов — тот же опыт на сетке условий, как диаграмма Weisman и Klemp (1982): по вертикали влажность нижних 1,5 км (а с ней CAPE), по горизонтали сдвиг ветра 0–6 км. Всё остальное, и зерно тоже, — как в идущем опыте, поэтому клетки различаются только средой. Влажность умножается на 0,8–1,1 (ползунки влажности, точка росы зондирования или предел пара WK — у Weisman и Klemp 11–16 г/кг); годограф растягивается или сжимается около ветра у земли до нужного сдвига, его форма сохраняется (к штилю добавляется прямой западный сдвиг). Режим клетки по ходу опыта: нет грозы — поток меньше 10 м/с или нет дождя; суперячейка — мезоциклон держится 10 мин; многоячейковая — мезоциклона нет, но в последней трети опыта и после 40-й минуты (столько живёт одиночная ячейка) поток ещё не слабее половины сильнейшего и 10 м/с (на фронте порывов встают новые ячейки); одиночная — поднялась, выпала дождём и распалась. В клетке — ход потока за опыт: у Weisman и Klemp именно второй максимум потока отделял долгоживущие грозы от одиночных. Кружок — где стоят сами настройки (их сдвиг). Клетку можно выбрать щелчком и взять в живой опыт. Опыты считаются без 3D-вида, по одному на ядро, несколько сразу; живой расчёт на это время на паузе.`, `The regime map is the same run on a grid of conditions, like the Weisman and Klemp (1982) diagram: up, the humidity of the lowest 1.5 km (and with it the CAPE); across, the 0–6 km wind shear. Everything else, the seed too, is as in the run going on, so the cells differ only by the environment. The moisture is multiplied by 0.8–1.1 (the humidity sliders, a sounding’s dew point or the WK vapour cap — 11–16 g/kg for Weisman and Klemp); the hodograph is stretched or shrunk about the ground wind to the shear asked, its shape kept (a calm one takes a straight westerly shear). A cell’s regime from the run’s course: no storm — the updraught under 10 m/s or no rain; a supercell — a mesocyclone held 10 min; multicell — no mesocyclone, but in the run’s last third and after the 40th minute (an ordinary cell’s life) the updraught still at least half the strongest and 10 m/s (new cells rise on the gust front); ordinary — it rose, rained out and decayed. Each cell shows the updraught’s course: for Weisman and Klemp it was the second updraught maximum that set the long-lived storms apart from ordinary cells. The ring is where the settings themselves stand (their shear). Click a cell to choose it and take it into the live run. The runs go without the 3D view, one per core, several at once; the live run is paused meanwhile.`)))
    this.canvas = this.root.querySelector('canvas')!; this.ctx = this.canvas.getContext('2d')!
    this.root.querySelector('.ibar__close')!.addEventListener('click', () => this.toggle(false))
    this.root.querySelectorAll<HTMLElement>('[data-seg]').forEach(s => s.addEventListener('click', e => {
      const v = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.value
      if (v === undefined || this.running) return
      if (s.dataset.seg === 'size') this.size = v as GridSize
      if (s.dataset.seg === 'minutes') this.minutes = Number(v)
      this.draw()
    }))
    this.root.querySelector('#regStart')!.addEventListener('click', () => this.running ? this.stop() : this.start())
    this.root.querySelector('#regApply')!.addEventListener('click', () => { if (this.chosen !== null && !this.running) { this.onApply(structuredClone(this.cells[this.chosen].config)); this.toggle(false) } })
    this.root.querySelector('#regCsv')!.addEventListener('click', () => {
      const rows = this.cells.map((c, k) => ({ c, p: this.peaks[k], r: this.results[k] })).filter(x => x.p && x.r)
      if (!rows.length) return
      download(`meteolab-rezhimy-${rows.length}.csv`, toCsv(rows, [['moisture_factor', x => GRIDS[this.size].moisture[x.c.row]], ['ml_cape_jkg', x => x.c.cape], ['shear_0_6km_ms', x => x.c.shear], ['regime', x => regimeOf(x.r!, x.p!)],
        ['max_updraft_ms', x => x.p!.updraft], ['max_uh_2_5km_m2s2', x => x.p!.uh], ['max_rain_rate_mmh', x => x.p!.rain], ['max_rain_total_mm', x => x.p!.rainTotal], ['max_surface_wind_ms', x => x.p!.gust], ['max_hail_mm', x => x.p!.hail], ['mesocyclone_from_s', x => x.p!.mesocyclone ?? '']]))
    })
    this.canvas.addEventListener('click', e => {
      const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top
      const hit = this.boxes.find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)
      if (hit) { this.chosen = hit.index; this.draw() }
    })
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.open) this.toggle(false) })
    addEventListener('resize', () => this.open && this.draw())
  }

  toggle(open = !this.open) { this.open = open; this.root.hidden = !open; if (open) this.draw() }

  private start() {
    const { config, name } = this.current()
    this.cells = regimeCells(config, this.size); this.results = this.cells.map(() => null); this.peaks = this.cells.map(() => null)
    this.base = { name, shear: environmentOf(config).shear }
    const g = GRIDS[this.size]
    // Chosen at first: the cell nearest the settings themselves (their moisture, the nearest shear).
    this.chosen = this.cells.findIndex(c => g.moisture[c.row] === 1 && c.column === nearest(g.shear, this.base!.shear))
    const running = { started: performance.now(), times: new Map<number, number>() as ReadonlyMap<number, number>, stop: () => {} }
    this.running = running
    running.stop = runPool(this.cells.map(c => c.config), this.minutes, {
      progress: times => { running.times = times; this.progress() },
      done: (k, result) => { this.results[k] = result; this.peaks[k] = memberPeaks(result); this.draw() },
      error: message => { this.stop(); this.text('regHint', `${L('Ошибка расчёта', 'Computation error')}: ${message}`) },
      finish: () => { this.running = null; this.onRunning(false); this.draw() },
    })
    this.onRunning(true); this.draw()
  }

  /** Stops the runs still going; the finished cells stay. */
  stop() {
    if (this.running) { this.running.stop(); this.running = null; this.onRunning(false) }
    this.draw()
  }

  private text(id: string, v: string) { (this.root.querySelector(`#${id}`) as HTMLElement).innerHTML = v }
  private get done() { return this.results.filter(Boolean).length }

  private progress() {
    const r = this.running
    if (!r) return
    const end = this.minutes * 60, done = (this.done * end + [...r.times.values()].reduce((s, t) => s + t, 0)) / (this.cells.length * end)
    const bar = this.root.querySelector<HTMLProgressElement>('#regBar')!
    bar.hidden = false; bar.value = done
    const elapsed = (performance.now() - r.started) / 1000, left = done > .02 ? elapsed * (1 - done) / done : NaN
    this.text('regLeft', Number.isFinite(left) ? L(`ОСТАЛОСЬ ~<b>${Math.ceil(left / 60)} МИН</b>`, `LEFT ~<b>${Math.ceil(left / 60)} MIN</b>`) : '')
    this.text('regCount', `${this.done} / ${this.cells.length}`)
    this.paint()
  }

  private draw() {
    const running = !!this.running, n = this.done, g = GRIDS[this.size]
    press(this.root.querySelectorAll<HTMLElement>('[data-seg="size"] button'), b => b.dataset.value === this.size)
    press(this.root.querySelectorAll<HTMLElement>('[data-seg="minutes"] button'), b => Number(b.dataset.value) === this.minutes)
    this.root.querySelectorAll<HTMLButtonElement>('[data-seg] button').forEach(b => { b.disabled = running })
    this.root.querySelector('#regStart')!.textContent = running ? L('Остановить', 'Stop') : n ? L('Запустить заново', 'Run again') : L('Запустить', 'Run')
    this.root.querySelector<HTMLProgressElement>('#regBar')!.hidden = !running
    this.text('regCount', running ? `${n} / ${this.cells.length}` : n ? String(n) : '—'); this.text('regName', this.base?.name || '—')
    if (!running) this.text('regLeft', '')
    const total = g.moisture.length * g.shear.length, parallel = poolSize(total)
    this.text('regHint', running ? L(`Опытов сразу: ${Math.min(parallel, this.cells.length - n)}; живой расчёт на паузе.`, `Runs at once: ${Math.min(parallel, this.cells.length - n)}; the live run is paused.`)
      : n ? L(`${n} опытов по ${this.minutes} мин из настроек «${this.base?.name}».`, `${n} runs of ${this.minutes} min from the settings “${this.base?.name}”.`)
      : L(`Текущие настройки на сетке ${g.moisture.length} × ${g.shear.length}: ${total} опытов по ${this.minutes} мин, по ${parallel} сразу. Один опыт на стандартной области — ~2–3 мин на модельный час на ядро.`, `The current settings on a ${g.moisture.length} × ${g.shear.length} grid: ${total} runs of ${this.minutes} min, ${parallel} at once. One run on the standard domain takes ~2–3 min per model hour on a core.`))

    const k = this.chosen, cell = k === null ? undefined : this.cells[k], p = k === null ? null : this.peaks[k], r = k === null ? null : this.results[k]
    this.text('regCell', cell ? readings([
      [L('влажность', 'moisture'), `×${decimal(g.moisture[cell.row], 1)}`], ['ML CAPE', `${Math.round(cell.cape)} ${L('Дж/кг', 'J/kg')}`], [L('сдвиг 0–6 км', 'shear 0–6 km'), `${Math.round(cell.shear)} ${L('м/с', 'm/s')}`],
      ...(p && r ? [[L('режим', 'regime'), REGIMES[regimeOf(r, p)].name], [L('поток', 'updraught'), `${decimal(p.updraft, 1)} ${L('м/с', 'm/s')}`], ['UH 2–5 км', `${Math.round(p.uh)} ${L('м²/с²', 'm²/s²')}`],
        [L('дождь', 'rain'), `${Math.round(p.rain)} ${L('мм/ч', 'mm/h')}`], [L('град', 'hail'), `${decimal(p.hail, 0)} ${L('мм', 'mm')}`], [L('ветер у земли', 'surface wind'), `${decimal(p.gust, 1)} ${L('м/с', 'm/s')}`],
        [L('мезоциклон с', 'mesocyclone from'), p.mesocyclone === null ? L('нет', 'none') : `${Math.round(p.mesocyclone / 60)} ${L('мин', 'min')}`]] as [string, string][] : [[L('режим', 'regime'), running ? L('считается', 'running') : '—']] as [string, string][]),
    ]) : '')
    this.root.querySelector<HTMLButtonElement>('#regApply')!.disabled = !cell || running
    this.root.querySelector<HTMLButtonElement>('#regCsv')!.disabled = !n
    this.paint()
  }

  private paint() {
    const c = this.canvas, host = c.parentElement!, dpr = Math.min(devicePixelRatio, 2), w = host.clientWidth, h = host.clientHeight, ctx = this.ctx
    if (!this.open || !w) return
    c.style.width = `${w}px`; c.style.height = `${h}px`
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const pal = instrumentPalette(this.root)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, w, h); ctx.font = `11px ${MONO}`
    this.boxes = []
    if (!this.cells.length) { ctx.fillStyle = pal.label; ctx.fillText(L('Запустите карту: справа — размер сетки и длительность опытов.', 'Run the map: the grid’s size and the runs’ length are on the right.'), 24, 30); return }

    const g = GRIDS[this.size], rows = g.moisture.length, cols = g.shear.length
    // The legend's entries, wrapped into lines to fit the width.
    const legend = [...Object.values(REGIMES), { name: L('настройки опыта', 'the run’s settings'), colour: '' }], lines: { x: number; name: string; colour: string }[][] = [[]]
    let lx = 0
    for (const e of legend) { const width = 24 + ctx.measureText(e.name).width; if (lx && lx + width > w - 24) { lines.push([]); lx = 0 } lines[lines.length - 1].push({ ...e, x: lx }); lx += width }
    const left = Math.min(130, w * .22), right = 16, top = 40, bottom = 48 + 16 * lines.length, cw = (w - left - right) / cols, ch = (h - top - bottom) / rows
    const title = L(`Режим грозы за ${this.minutes} мин: влажность (CAPE) × сдвиг 0–6 км`, `Storm regime over ${this.minutes} min: moisture (CAPE) × 0–6 km shear`)
    ctx.fillStyle = pal.text; ctx.fillText(ctx.measureText(title).width < w - left - 8 ? title : L(`Режим грозы за ${this.minutes} мин`, `Storm regime, ${this.minutes} min`), left, 20)
    const wMax = Math.max(20, ...this.peaks.map(p => p?.updraft ?? 0)) * 1.05, span = this.minutes * 60
    for (const [index, cell] of this.cells.entries()) {
      const x = left + cell.column * cw, y = top + (rows - 1 - cell.row) * ch, r = this.results[index], p = this.peaks[index], t = this.running?.times.get(index)
      this.boxes.push({ index, x, y, w: cw, h: ch })
      const regime = r && p ? REGIMES[regimeOf(r, p)] : null
      ctx.fillStyle = regime ? `${regime.colour}38` : '#ffffff08'; ctx.fillRect(x + 2, y + 2, cw - 4, ch - 4)
      ctx.strokeStyle = index === this.chosen ? '#ffffff' : regime ? regime.colour : pal.grid; ctx.lineWidth = index === this.chosen ? 2 : 1
      ctx.setLineDash(regime ? [] : [4, 3]); ctx.strokeRect(x + 2.5, y + 2.5, cw - 5, ch - 5); ctx.setLineDash([])
      if (regime && r && p) {
        ctx.fillStyle = regime.colour; ctx.fillText(regime.name, x + 8, y + 16)
        ctx.fillStyle = pal.label; ctx.fillText(`w ${Math.round(p.updraft)}${p.mesocyclone === null ? '' : ` · UH ${Math.round(p.uh)}`}`, x + 8, y + 30)
        // The updraught's course over the run, on one scale for every cell.
        const px0 = x + 8, px1 = x + cw - 8, py0 = y + 38, py1 = y + ch - 8
        if (py1 - py0 > 12) {
          ctx.strokeStyle = regime.colour; ctx.lineWidth = 1.5; ctx.beginPath()
          r.samples.forEach((s, i) => { const X = px0 + (px1 - px0) * s.t / span, Y = py1 - (py1 - py0) * s.updraft / wMax; if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y) })
          ctx.stroke()
        }
      } else { ctx.fillStyle = pal.label; ctx.fillText(t === undefined ? (this.running ? L('в очереди', 'queued') : L('не посчитана', 'not run')) : `${Math.floor(t / 60)} / ${this.minutes} ${L('мин', 'min')}`, x + 8, y + 16) }
    }
    // The axes: the rows' moisture and CAPE, the columns' shear.
    ctx.fillStyle = pal.label
    for (let row = 0; row < rows; row++) {
      const y = top + (rows - 1 - row) * ch + ch / 2, cape = this.cells[row * cols].cape
      ctx.fillText(`×${decimal(g.moisture[row], 1)}`, 8, y - 4); ctx.fillText(`${Math.round(cape)} ${L('Дж/кг', 'J/kg')}`, 8, y + 10)
    }
    g.shear.forEach((s, column) => { const label = `${s} ${L('м/с', 'm/s')}`; ctx.fillText(label, left + (column + .5) * cw - ctx.measureText(label).width / 2, top + rows * ch + 16) })
    ctx.fillStyle = pal.text; ctx.fillText(L('сдвиг 0–6 км →', '0–6 km shear →'), left, top + rows * ch + 34); ctx.fillText(L('↑ влажность', '↑ moisture'), 8, top - 8)
    // Where the settings themselves stand: their moisture row, their own shear.
    const baseRow = g.moisture.findIndex(m => m === 1)
    if (this.base && baseRow >= 0) {
      const x = left + cw * (position(g.shear, this.base.shear) + .5), y = top + (rows - 1 - baseRow) * ch + ch / 2
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 6, 0, 2 * Math.PI); ctx.stroke()
    }
    // The legend.
    lines.forEach((line, k) => {
      const ly = h - 14 - 16 * (lines.length - 1 - k)
      for (const { x, name, colour } of line) {
        if (colour) { ctx.fillStyle = colour; ctx.fillRect(16 + x, ly - 9, 10, 10) } else { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(16 + x + 5, ly - 4, 5, 0, 2 * Math.PI); ctx.stroke() }
        ctx.fillStyle = pal.label; ctx.fillText(name, 16 + x + 14, ly)
      }
    })
  }
}

/** The index of the value nearest `v`. */
function nearest(values: readonly number[], v: number) { let best = 0; values.forEach((x, k) => { if (Math.abs(x - v) < Math.abs(values[best] - v)) best = k }); return best }
/** Where `v` falls among increasing `values`, as a fractional index (clamped to the ends). */
function position(values: readonly number[], v: number) {
  if (v <= values[0]) return 0
  for (let k = 1; k < values.length; k++) if (v <= values[k]) return k - 1 + (v - values[k - 1]) / (values[k] - values[k - 1])
  return values.length - 1
}
