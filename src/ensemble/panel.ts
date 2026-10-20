import { L } from '../i18n'
import type { SimConfig } from '../core'
import { minuteMark } from '../clock'
import { help, instrumentPalette, instrumentScreen, press, readings, section } from '../instrument'
import { MONO } from '../theme'
import { download, toCsv } from '../share'
import { EVENTS, type EventKind, MAPS, type MapKind, memberPeaks, type MemberPeaks, probabilities, probabilityMap, spread } from './combine'
import { type MemberResult, perturbConfig, UNCERTAINTY } from './member'
import { poolSize, runPool } from './pool'

const SIZES = [5, 10, 20], LENGTHS = [30, 60, 90, 120]
const EVENT_NAMES: Record<EventKind, string> = {
  storm: L('Гроза (поток от 10 м/с и дождь)', 'A storm (updraught 10+ m/s and rain)'),
  mesocyclone: L('Мезоциклон', 'Mesocyclone'),
  hail: L(`Град от ${MAPS.hail.threshold} мм`, `Hail ${MAPS.hail.threshold}+ mm`),
  gust: L(`Ветер у земли от ${MAPS.gust.threshold} м/с`, `Surface wind ${MAPS.gust.threshold}+ m/s`),
  downpour: L('Ливень от 50 мм/ч', 'Downpour 50+ mm/h'),
  total: L('Сумма осадков от 20 мм', 'Rain total 20+ mm'),
}
/** The maps: the button's word and the map's title with its threshold. */
const MAP_BUTTONS: [MapKind, string][] = [['rain', L('Осадки', 'Rain')], ['gust', L('Ветер', 'Wind')], ['uh', L('Вращение', 'Rotation')], ['hail', L('Град', 'Hail')]]
const MAP_NAMES: [MapKind, string][] = [['rain', L(`Осадки ≥ ${MAPS.rain.threshold} мм`, `Rain ≥ ${MAPS.rain.threshold} mm`)], ['gust', L(`Ветер ≥ ${MAPS.gust.threshold} м/с`, `Wind ≥ ${MAPS.gust.threshold} m/s`)], ['uh', L(`След вращения: UH 2–5 км ≥ ${MAPS.uh.threshold} м²/с²`, `Rotation track: UH 2–5 km ≥ ${MAPS.uh.threshold} m²/s²`)], ['hail', L(`Град ≥ ${MAPS.hail.threshold} мм`, `Hail ≥ ${MAPS.hail.threshold} mm`)]]
/** The probability scale: from 10 % blue through green and yellow to red at 90 %. */
const SCALE: [number, [number, number, number]][] = [[.1, [40, 90, 200]], [.3, [40, 170, 90]], [.5, [235, 215, 60]], [.7, [240, 130, 40]], [.9, [210, 40, 50]]]
const ROWS: { key: 'updraft' | 'uh' | 'rain'; title: string; floor: number }[] = [
  { key: 'updraft', title: L('Восходящий поток, м/с', 'Updraught, m/s'), floor: 10 },
  { key: 'uh', title: L('Вращение UH 2–5 км, м²/с²', 'Rotation UH 2–5 km, m²/s²'), floor: 200 },
  { key: 'rain', title: L('Дождь в ядре, мм/ч', 'Rain in the core, mm/h'), floor: 10 },
]

function scaleColour(p: number): [number, number, number] | null {
  if (p < SCALE[0][0]) return null
  for (let k = 1; k < SCALE.length; k++) {
    const [a, ca] = SCALE[k - 1], [b, cb] = SCALE[k]
    if (p < b) { const f = (p - a) / (b - a); return [0, 1, 2].map(j => Math.round(ca[j] + (cb[j] - ca[j]) * f)) as [number, number, number] }
  }
  return SCALE[SCALE.length - 1][1]
}

/** A random seed that is not one of `taken`. */
function freshSeed(taken: Set<number>) { for (;;) { const [x] = crypto.getRandomValues(new Uint32Array(1)); if (x && !taken.has(x)) { taken.add(x); return x } } }

/**
 * The ensemble (2.9), a screen like the instruments': the current settings run N times, each with its own random seed,
 * on several cores at once without a view (src/ensemble/ensemble.worker.ts); the live run pauses meanwhile. Then the
 * share of members with each event (a mesocyclone, large hail, a strong wind, a downpour), the spread of the values,
 * the probability maps on the ground and every member's course on one plot. The first member is the run's own seed.
 */
export class EnsemblePanel {
  private readonly root: HTMLDivElement; private readonly canvas: HTMLCanvasElement; private readonly ctx: CanvasRenderingContext2D
  private readonly image = document.createElement('canvas')
  private size = 10; private minutes = 60; private map: MapKind = 'rain'
  /** What makes the members differ: the seed alone, or the seed and the uncertainty of the starting data (perturbConfig). */
  private mode: 'seed' | 'data' = 'data'
  private results: MemberResult[] = []; private peaks: MemberPeaks[] = []
  private running: { total: number; started: number; times: ReadonlyMap<number, number>; stop: () => void } | null = null
  private name = ''
  open = false
  /** The settings and the name of the run going on. */
  current: () => { config: SimConfig; name: string } = () => { throw new Error('no settings') }
  /** Called with true when the ensemble starts (the live run pauses), false when it ends or is stopped. */
  onRunning: (running: boolean) => void = () => {}

  constructor(host: HTMLElement) {
    const seg = (name: string, options: [string | number, string][]) => `<div class="seg seg--block seg--instrument" data-seg="${name}">${options.map(([v, t]) => `<button data-value="${v}">${t}</button>`).join('')}</div>`
    this.root = instrumentScreen(host, 'ensemble-app', L('METEOLAB · АНСАМБЛЬ', 'METEOLAB · ENSEMBLE'),
      `<span>${L('УЧАСТНИКИ', 'MEMBERS')} <b id="ensCount">—</b></span><span>${L('ОПЫТ', 'RUN')} <b id="ensName">—</b></span><span id="ensLeft"></span>`,
      section(L('Ансамбль', 'Ensemble'), `<span class="t-caption">${L('Участников', 'Members')}</span>${seg('size', SIZES.map(n => [n, String(n)]))}
          <span class="t-caption">${L('Длительность, мин', 'Length, min')}</span>${seg('minutes', LENGTHS.map(n => [n, String(n)]))}
          <span class="t-caption">${L('Чем различаются', 'What differs')}</span>${seg('mode', [['data', L('Зерно и данные', 'Seed and data')], ['seed', L('Только зерно', 'Seed only')]])}
          <button class="btn btn--block btn--primary" id="ensStart">${L('Запустить', 'Run')}</button>
          <progress id="ensBar" max="1" value="0" hidden></progress>
          <p class="psec__hint" id="ensHint"></p>`)
      + section(L('Карта', 'Map'), seg('map', MAP_BUTTONS))
      + section(L('Вероятности', 'Probabilities'), '<dl class="kv" id="ensProb"></dl>')
      + section(L('Разброс: меньше · медиана · больше', 'Spread: least · median · most'), `<dl class="kv" id="ensSpread"></dl><button class="btn btn--block" id="ensCsv" title="${L('Пики каждого участника в CSV', 'Every member’s highlights as CSV')}">${L('Выгрузить CSV', 'Export CSV')}</button>`)
      + help(L(`Ансамбль — тот же опыт много раз с небольшими различиями. Зерно случайности задаёт узор поверхности и слабый шум температуры (0,02 K), но начальные термики стоят на тех же местах с той же силой, поэтому с одним зерном участники почти не расходятся. Настоящие ансамбли меняют и начальные данные в пределах их ошибки — «Зерно и данные»: температура у земли ±${UNCERTAINTY.temperature} K, влажность ниже 1,5 км ±${UNCERTAINTY.humidity} %, ветер ±${UNCERTAINTY.wind} м/с и ±${UNCERTAINTY.direction}° на каждом уровне (значит, и сдвиг), сила термика ±${UNCERTAINTY.thermal * 100} % и его место ±${UNCERTAINTY.offset / 1000} км (стандартные отклонения). Первый участник — контрольный: зерно и данные идущего опыта. Мелочи, которых не измерить, решают, где и когда встанет гроза, и ансамбль показывает это как разброс. Доля участников, в которых случилось событие, — его вероятность при этих условиях: так читают ансамбли прогнозов (например, «вероятность мезоциклона 60 %»). Карта — доля участников, у которых над этой точкой земли был след: осадки за опыт от ${MAPS.rain.threshold} мм, ветер у земли от ${MAPS.gust.threshold} м/с (средний по клетке ~1 км; порыв в точке в 1,3–1,5 раза сильнее), вращение UH 2–5 км от ${MAPS.uh.threshold} м²/с², град от ${MAPS.hail.threshold} мм. Земля одна для всех участников, а область модели едет за грозой, поэтому карта — в рамке земли. Участники считаются без 3D-вида, по одному на ядро, несколько сразу; живой расчёт на это время на паузе. Настройки берутся текущие; ансамбль хранится, пока открыта страница.`, `An ensemble is the same run many times with small differences. The random seed sets the surface pattern and a faint temperature noise (0.02 K), but the first thermals stand at the same places with the same strength, so with the seed alone the members hardly part. Real ensembles also change the starting data within its error — “Seed and data”: the surface temperature ±${UNCERTAINTY.temperature} K, the humidity below 1.5 km ±${UNCERTAINTY.humidity} %, the wind ±${UNCERTAINTY.wind} m/s and ±${UNCERTAINTY.direction}° at each level (so the shear too), the thermal’s strength ±${UNCERTAINTY.thermal * 100} % and its place ±${UNCERTAINTY.offset / 1000} km (standard deviations). The first member is the control: the seed and data of the run going on. Details too small to measure decide where and when a storm rises, and an ensemble shows that as spread. The share of members in which an event happened is its probability in these conditions: that is how forecast ensembles are read (say, “a 60 % chance of a mesocyclone”). The map is the share of members with a swath over that point of the ground: a run’s rain of ${MAPS.rain.threshold}+ mm, surface wind of ${MAPS.gust.threshold}+ m/s (a ~1 km cell mean; the gust at a point is 1.3–1.5 times stronger), UH 2–5 km of ${MAPS.uh.threshold}+ m²/s², hail of ${MAPS.hail.threshold}+ mm. The ground is the same for every member while the model’s domain follows the storm, so the map is in the ground’s frame. Members run without the 3D view, one per core, several at once; the live run is paused meanwhile. The current settings are taken; the ensemble is kept while the page is open.`)))
    this.canvas = this.root.querySelector('canvas')!; this.ctx = this.canvas.getContext('2d')!
    this.root.querySelector('.ibar__close')!.addEventListener('click', () => this.toggle(false))
    this.root.querySelectorAll<HTMLElement>('[data-seg]').forEach(s => s.addEventListener('click', e => {
      const v = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.value
      if (v === undefined) return
      if (s.dataset.seg === 'size' && !this.running) this.size = Number(v)
      if (s.dataset.seg === 'minutes' && !this.running) this.minutes = Number(v)
      if (s.dataset.seg === 'mode' && !this.running) this.mode = v as 'seed' | 'data'
      if (s.dataset.seg === 'map') this.map = v as MapKind
      this.draw()
    }))
    this.root.querySelector('#ensStart')!.addEventListener('click', () => this.running ? this.stop() : this.start())
    this.root.querySelector('#ensCsv')!.addEventListener('click', () => {
      if (!this.peaks.length) return
      const rows = this.peaks.map((p, k) => ({ ...p, seed: this.results[k].seed }))
      download(`meteolab-ansambl-${rows.length}.csv`, toCsv(rows, [['seed', r => r.seed], ['max_updraft_ms', r => r.updraft], ['max_uh_2_5km_m2s2', r => r.uh], ['max_rain_rate_mmh', r => r.rain], ['max_rain_total_mm', r => r.rainTotal],
        ['max_surface_wind_ms', r => r.gust], ['max_hail_mm', r => r.hail], ['max_flashes_per_min', r => r.flashes], ['mesocyclone_from_s', r => r.mesocyclone ?? '']]))
    })
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.open) this.toggle(false) })
    addEventListener('resize', () => this.open && this.draw())
  }

  toggle(open = !this.open) { this.open = open; this.root.hidden = !open; if (open) this.draw() }

  private start() {
    const { config, name } = this.current(), total = this.size, minutes = this.minutes, mode = this.mode
    const taken = new Set([config.seed]), seeds = [config.seed, ...Array.from({ length: total - 1 }, () => freshSeed(taken))]
    this.results = []; this.peaks = []; this.name = name
    // The first member is the control: the run's own seed and data; the others perturbed within the data's uncertainty (if chosen).
    const configs = seeds.map((seed, k) => { const member = { ...structuredClone(config), seed }; return k && mode === 'data' ? perturbConfig(member) : member })
    const running = { total, started: performance.now(), times: new Map<number, number>() as ReadonlyMap<number, number>, stop: () => {} }
    this.running = running
    running.stop = runPool(configs, minutes, {
      progress: times => { running.times = times; this.progress() },
      done: (_, result) => { this.results.push(result); this.peaks.push(memberPeaks(result)); this.draw() },
      error: message => { this.stop(); this.text('ensHint', `${L('Ошибка расчёта', 'Computation error')}: ${message}`) },
      finish: () => this.finish(),
    })
    this.onRunning(true); this.draw()
  }

  /** Stops the members still running; the finished ones stay. */
  stop() {
    if (this.running) { this.running.stop(); this.running = null; this.onRunning(false) }
    this.draw()
  }

  private finish() { this.running = null; this.onRunning(false); this.draw() }

  private text(id: string, v: string) { (this.root.querySelector(`#${id}`) as HTMLElement).innerHTML = v }

  /** The bar, the count and the time left. */
  private progress() {
    const r = this.running
    if (!r) return
    const end = this.minutes * 60, done = (this.results.length * end + [...r.times.values()].reduce((s, t) => s + t, 0)) / (r.total * end)
    const bar = this.root.querySelector<HTMLProgressElement>('#ensBar')!
    bar.hidden = false; bar.value = done
    const elapsed = (performance.now() - r.started) / 1000, left = done > .02 ? elapsed * (1 - done) / done : NaN
    this.text('ensLeft', Number.isFinite(left) ? L(`ОСТАЛОСЬ ~<b>${Math.ceil(left / 60)} МИН</b>`, `LEFT ~<b>${Math.ceil(left / 60)} MIN</b>`) : '')
    this.text('ensCount', `${this.results.length} / ${r.total}`)
  }

  private draw() {
    const running = !!this.running, n = this.results.length
    press(this.root.querySelectorAll<HTMLElement>('[data-seg="size"] button'), b => Number(b.dataset.value) === this.size)
    press(this.root.querySelectorAll<HTMLElement>('[data-seg="minutes"] button'), b => Number(b.dataset.value) === this.minutes)
    press(this.root.querySelectorAll<HTMLElement>('[data-seg="map"] button'), b => b.dataset.value === this.map)
    press(this.root.querySelectorAll<HTMLElement>('[data-seg="mode"] button'), b => b.dataset.value === this.mode)
    this.root.querySelectorAll<HTMLButtonElement>('[data-seg="size"] button, [data-seg="minutes"] button, [data-seg="mode"] button').forEach(b => { b.disabled = running })
    this.root.querySelector('#ensStart')!.textContent = running ? L('Остановить', 'Stop') : n ? L('Запустить заново', 'Run again') : L('Запустить', 'Run')
    this.root.querySelector<HTMLProgressElement>('#ensBar')!.hidden = !running
    this.root.querySelector<HTMLButtonElement>('#ensCsv')!.disabled = !n
    this.text('ensCount', running ? `${n} / ${this.running!.total}` : n ? String(n) : '—'); this.text('ensName', this.name || '—')
    if (!running) this.text('ensLeft', '')
    const parallel = poolSize(this.size)
    this.text('ensHint', running ? L(`Участников сразу: ${Math.min(parallel, this.running!.total - n)}; живой расчёт на паузе.`, `Members at once: ${Math.min(parallel, this.running!.total - n)}; the live run is paused.`)
      : n ? L(`${n} участников по ${this.minutes} мин, настройки «${this.name}».`, `${n} members of ${this.minutes} min, settings “${this.name}”.`)
      : L(`Текущие настройки ${this.size} раз по ${this.minutes} мин с разными зёрнами, по ${parallel} сразу. Один участник на стандартной области — ~2–3 мин на модельный час, на большой — в ~4 раза дольше.`, `The current settings ${this.size} times for ${this.minutes} min with different seeds, ${parallel} at once. One member on the standard domain takes ~2–3 min per model hour, on the large one ~4 times longer.`))

    const prob = probabilities(this.peaks), pct = (p: number) => `${Math.round(p * 100)} %`
    this.text('ensProb', n ? readings((Object.keys(EVENTS) as EventKind[]).map(k => [EVENT_NAMES[k], `${pct(prob[k])} <span class="t-caption">${Math.round(prob[k] * n)}/${n}</span>`])) : '')
    const s = (f: (p: MemberPeaks) => number, d = 0) => { const v = spread(this.peaks.map(f)); return `${v.min.toFixed(d)} · ${v.median.toFixed(d)} · ${v.max.toFixed(d)}` }
    const meso = this.peaks.flatMap(p => p.mesocyclone === null ? [] : [p.mesocyclone / 60])
    this.text('ensSpread', n ? readings([
      [L('поток, м/с', 'updraught, m/s'), s(p => p.updraft, 1)], [L('UH, м²/с²', 'UH, m²/s²'), s(p => p.uh)], [L('дождь, мм/ч', 'rain, mm/h'), s(p => p.rain)],
      [L('сумма, мм', 'total, mm'), s(p => p.rainTotal, 1)], [L('ветер у земли, м/с', 'surface wind, m/s'), s(p => p.gust, 1)], [L('град, мм', 'hail, mm'), s(p => p.hail, 1)],
      [L('молнии, /мин', 'flashes, /min'), s(p => p.flashes)],
      [L('мезоциклон с, мин', 'mesocyclone from, min'), meso.length ? `${(() => { const v = spread(meso); return `${v.min.toFixed(0)} · ${v.median.toFixed(0)} · ${v.max.toFixed(0)}` })()} <span class="t-caption">(${meso.length})</span>` : L('нет', 'none')],
    ]) : '')
    this.paint()
  }

  private paint() {
    const c = this.canvas, host = c.parentElement!, dpr = Math.min(devicePixelRatio, 2), w = host.clientWidth, h = host.clientHeight, ctx = this.ctx
    if (!this.open || !w) return
    c.style.width = `${w}px`; c.style.height = `${h}px`
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const pal = instrumentPalette(this.root)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, w, h); ctx.font = `11px ${MONO}`
    const results = this.results
    if (!results.length) { ctx.fillStyle = pal.label; ctx.fillText(this.running ? L('Участники считаются: первые итоги — когда закончится первый.', 'The members are running: the first results come when the first one ends.') : L('Запустите ансамбль: справа — сколько участников и на сколько минут.', 'Run the ensemble: how many members and for how long is on the right.'), 24, 30); return }

    // Top: the probability map on the ground with its scale.
    const mapH = Math.min(h * .52, (w - 48) * .7), r0 = results[0], prob = probabilityMap(results, this.map)
    const scale = Math.min((w - 140) / r0.width, (mapH - 30) / r0.depth), dw = r0.width * scale, dh = r0.depth * scale, ox = 24, oy = 34
    ctx.fillStyle = pal.text; ctx.fillText(`${MAP_NAMES.find(([k]) => k === this.map)![1]} · ${L('вероятность', 'probability')} · ${results.length} ${L('участн.', 'members')}`, ox, oy - 12)
    const img = this.image, g = img.getContext('2d')!
    img.width = r0.nx; img.height = r0.ny
    const data = g.createImageData(r0.nx, r0.ny)
    for (let j = 0; j < r0.ny; j++) for (let i = 0; i < r0.nx; i++) {
      const col = scaleColour(prob[i + r0.nx * j]), o = 4 * (i + r0.nx * (r0.ny - 1 - j))
      if (col) { data.data[o] = col[0]; data.data[o + 1] = col[1]; data.data[o + 2] = col[2]; data.data[o + 3] = 255 }
    }
    g.putImageData(data, 0, 0)
    ctx.fillStyle = '#0b0f12'; ctx.fillRect(ox, oy, dw, dh); ctx.imageSmoothingEnabled = true; ctx.drawImage(img, ox, oy, dw, dh)
    ctx.strokeStyle = pal.gridStrong; ctx.strokeRect(ox + .5, oy + .5, dw, dh)
    ctx.strokeStyle = pal.text; ctx.beginPath(); ctx.moveTo(ox + 8, oy + dh - 8); ctx.lineTo(ox + 8 + 10_000 * scale, oy + dh - 8); ctx.stroke(); ctx.fillStyle = pal.text; ctx.fillText(L('10 км', '10 km'), ox + 8, oy + dh - 12)
    // Where no member's swath reached the threshold: say so, with the most any reached.
    if (!prob.some(p => p >= SCALE[0][0])) {
      const field = MAPS[this.map].field, most = Math.max(...results.map(r => r[field].reduce((v, x) => Math.max(v, x), 0)))
      ctx.fillStyle = pal.label; ctx.fillText(L(`Ни у одного участника след не дошёл до порога (больше всего — ${most.toFixed(1)})`, `No member's swath reached the threshold (the most: ${most.toFixed(1)})`), ox + 10, oy + 20)
    }
    ctx.fillStyle = '#ffb347'; ctx.fillText(L('— медиана', '— median'), ox + dw + 18, oy + SCALE.length * 22 + 20)
    ctx.fillStyle = 'rgba(111, 180, 255, .9)'; ctx.fillText(L('— участники', '— members'), ox + dw + 18, oy + SCALE.length * 22 + 36)
    SCALE.forEach(([p, col], k) => { const y = oy + k * 22; ctx.fillStyle = `rgb(${col.join(',')})`; ctx.fillRect(ox + dw + 18, y, 14, 14); ctx.fillStyle = pal.label; ctx.fillText(`${Math.round(p * 100)} %+`, ox + dw + 38, y + 11) })

    // Below: every member's course, thin, and the median, thick.
    const top = oy + dh + 30, rowH = (h - top - 22) / ROWS.length, span = this.minutes * 60, left = 24, right = w - 24, X = (t: number) => left + (right - left) * t / span
    ROWS.forEach((row, k) => {
      const y0 = top + k * rowH + 14, y1 = top + (k + 1) * rowH - 8, max = Math.max(row.floor, ...results.flatMap(r => r.samples.map(s => s[row.key]))) * 1.05, Y = (v: number) => y1 - (y1 - y0) * v / max
      ctx.strokeStyle = pal.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, y1 + .5); ctx.lineTo(right, y1 + .5); ctx.stroke()
      ctx.fillStyle = pal.text; ctx.fillText(row.title, left, y0 - 4); ctx.fillStyle = pal.label; const m = max >= 100 ? max.toFixed(0) : max.toFixed(1); ctx.fillText(m, right - ctx.measureText(m).width, y0 - 4)
      ctx.strokeStyle = 'rgba(111, 180, 255, .35)'; ctx.lineWidth = 1
      for (const r of results) { ctx.beginPath(); r.samples.forEach((s, i) => { if (i) ctx.lineTo(X(s.t), Y(s[row.key])); else ctx.moveTo(X(s.t), Y(s[row.key])) }); ctx.stroke() }
      // The median over the members at each sample time.
      const times = results.reduce((a, r) => r.samples.length > a.length ? r.samples : a, results[0].samples).map(s => s.t)
      ctx.strokeStyle = '#ffb347'; ctx.lineWidth = 2; ctx.beginPath()
      times.forEach((t, i) => { const v = spread(results.flatMap(r => r.samples.filter(s => s.t === t).map(s => s[row.key]))).median; if (i) ctx.lineTo(X(t), Y(v)); else ctx.moveTo(X(t), Y(v)) })
      ctx.stroke()
      if (k === ROWS.length - 1) { ctx.fillStyle = pal.label; for (let mm = 10; mm * 60 <= span; mm += 10) ctx.fillText(minuteMark(mm), X(mm * 60) - 8, y1 + 14) }
    })
  }
}
