import { L } from '../i18n'
import type { SimConfig } from '../core'
import { minuteMark } from '../clock'
import { help, instrumentPalette, instrumentScreen, readings, section } from '../instrument'
import { BUILTIN, colorAt } from '../radar/palettes'
import { MONO } from '../theme'
import type { TimelinePoint } from '../timeline'
import { atTime, configChanges, echoDbz, type EchoMap, peaks, type Peaks, type RunRecord } from './run'

/** The run going on (B), as the page knows it. */
export interface CurrentRun { name: string; config: SimConfig; points: readonly TimelinePoint[]; maps: readonly EchoMap[]; time: number }

const A_COLOR = '#aab4ba', B_COLOR = '#ffb347'
const Z_PALETTE = BUILTIN.find(p => p.kind === 'Z')!
type Key = 'updraft' | 'uh' | 'rain' | 'gust' | 'flashes'
const ROWS: { key: Key; title: string; unit: string; floor: number }[] = [
  { key: 'updraft', title: L('Восходящий поток', 'Updraught'), unit: L('м/с', 'm/s'), floor: 10 },
  { key: 'uh', title: L('Вращение UH 2–5 км', 'Rotation UH 2–5 km'), unit: L('м²/с²', 'm²/s²'), floor: 200 },
  { key: 'rain', title: L('Дождь в ядре', 'Rain in the core'), unit: L('мм/ч', 'mm/h'), floor: 10 },
  { key: 'gust', title: L('Порыв у земли', 'Surface gust'), unit: L('м/с', 'm/s'), floor: 10 },
  { key: 'flashes', title: L('Молнии', 'Lightning'), unit: L('вспышек/мин', 'flashes/min'), floor: 10 },
]
/** Settings without a slider of their own: their names. */
const NAMES: Partial<Record<keyof SimConfig, string>> = {
  seed: L('Зерно случайности (узор поверхности, начальные возмущения)', 'Random seed (the surface pattern, the first disturbances)'),
  sounding: L('Зондирование', 'Sounding'), profile: L('Профиль', 'Profile'), zones: L('Зоны среды', 'Environment zones'), frontLine: L('Фронт', 'Front'),
  largeScale: L('Адвекция', 'Advection'), surfaceType: L('Поверхность', 'Surface'), microphysics: L('Микрофизика', 'Microphysics'), transport: L('Перенос', 'Transport'),
  domain: L('Размер области', 'Domain size'), domainSize: L('Своя область, км', 'Own domain, km'), followStorm: L('Область движется с грозой', 'The domain moves with the storm'),
  frameMotion: L('Скорость области', 'The domain’s motion'), lightning: L('Молнии', 'Lightning'), front: L('Фронт', 'Front'), edges: L('Края области', 'Domain edges'),
  start: L('Начальный толчок', 'The first trigger'), city: L('Город', 'City'), dayOfYear: L('День года', 'Day of the year'),
}
const minutes = (t: number | null) => t === null ? L('нет', 'none') : `${Math.round(t / 60)} ${L('мин', 'min')}`

/** A setting's name and its value as the page shows them (the slider's label and units, the select's option). */
function setting(key: keyof SimConfig, value: unknown) {
  const input = document.querySelector<HTMLInputElement>(`input[data-key="${key}"]`), select = document.querySelector<HTMLSelectElement>(`select#${key}`)
  // A slider's own label may be only its layer («1–3 км»): then with its group's title («Влажность: 1–3 км»).
  const label = input?.closest('.field')?.querySelector('.field__label')?.firstChild?.textContent?.trim(), group = input?.closest('details')?.querySelector('.group__title')?.textContent?.trim()
  const name = label ? (/^\d/.test(label) && group ? `${group}: ${label}` : label) : NAMES[key] ?? key
  let shown: string
  if (value === undefined || value === null) shown = '—'
  else if (typeof value === 'number') shown = input ? `${value.toFixed(Number(input.dataset.digits ?? 0))}${input.dataset.unit ?? ''}` : String(value)
  else if (typeof value === 'boolean') shown = value ? L('да', 'yes') : L('нет', 'no')
  else if (typeof value === 'string') shown = [...(select?.options ?? [])].find(o => o.value === value)?.textContent ?? value
  else shown = L('задано', 'set')
  return { name, shown }
}

/**
 * The comparison of two runs (2.9), a screen like the instruments': the remembered run A and the one going on, B —
 * their strongest echo side by side at the same model time, their courses on shared plots, the settings that differ,
 * and their highlights up to the same time. A is kept in memory (while the page is open); remembering a new one
 * replaces it. With «the seed of A» held, every restart uses A's seed, so the storms differ only by what was changed.
 */
export class ComparePanel {
  private readonly root: HTMLDivElement; private readonly canvas: HTMLCanvasElement; private readonly ctx: CanvasRenderingContext2D
  private readonly image = document.createElement('canvas')
  private current: CurrentRun | null = null; private shown = ''
  /** The remembered run, if any. */
  reference: RunRecord | null = null
  /** Restarts keep A's seed (on while A is remembered, unless the user unticks it). */
  keepSeed = true
  open = false
  /** Called when A is remembered or forgotten (the side plots redraw with it). */
  onChange: () => void = () => {}
  /** Restart the run going on with A's seed. */
  onReseed: (seed: number) => void = () => {}

  constructor(host: HTMLElement) {
    this.root = instrumentScreen(host, 'compare-app', L('METEOLAB · СРАВНЕНИЕ ОПЫТОВ', 'METEOLAB · COMPARING RUNS'),
      `<span>A <b id="cmpA">—</b></span><span>B <b id="cmpB">—</b></span><span>${L('ВРЕМЯ', 'TIME')} <b id="cmpTime">—</b></span>`,
      section(L('Опыт A', 'Run A'), `<button class="btn btn--block" data-cmp="remember" title="${L('Запомнить идущий опыт как A: его графики и карты эха останутся для сравнения со следующим', 'Remember the run going on as A: its plots and echo maps stay to compare with the next one')}">${L('Запомнить текущий как A', 'Remember this run as A')}</button>
          <div class="side__row"><button class="btn" data-cmp="reseed" title="${L('Перезапустить текущие настройки с зерном опыта A: грозы будут различаться только изменёнными настройками', 'Restart the current settings with run A’s seed: the storms will differ only by the settings changed')}">${L('Заново с зерном A', 'Restart with A’s seed')}</button><button class="btn" data-cmp="forget">${L('Забыть A', 'Forget A')}</button></div>
          <label class="check"><input type="checkbox" id="cmpKeepSeed" checked> ${L('Перезапуски — с зерном A', 'Restarts use A’s seed')}</label>
          <p class="psec__hint" id="cmpHint"></p>`)
      + section(L('Что изменено', 'What differs'), '<dl class="kv" id="cmpChanges"></dl>')
      + section(L('К одному времени', 'At the same time'), '<dl class="kv cmp-peaks" id="cmpPeaks"></dl>')
      + help(L('Как ставить опыт: дайте грозе развиться, нажмите «Запомнить текущий как A», измените одну настройку (например, сдвиг или влажность) — расчёт начнётся заново, это опыт B. Слева карта A, справа B — сильнейшее эхо над каждой точкой (как композит радара) в одну и ту же модельную минуту; ниже — общие графики: A пунктиром, B сплошной линией. Справа — пики обоих к одному времени: пока B не догнал A, A берётся только до того же времени. Зерно случайности задаёт узор поверхности и первые возмущения: с разными зёрнами даже одинаковые настройки дают разные грозы (разброс — тема ансамбля). Поэтому, пока A запомнен, перезапуски берут его зерно — и разница между A и B возникает только из изменённого. Считается один опыт: два сразу шли бы вдвое медленнее. A хранится, пока открыта страница.', 'How to set up an experiment: let a storm develop, press “Remember this run as A”, change one setting (say, the shear or the humidity) — the run starts again, this is run B. On the left is A’s map, on the right B’s — the strongest echo over each point (like a radar composite) at the same model minute; below, shared plots: A dashed, B solid. On the side, both runs’ highlights up to the same time: until B catches up with A, A is taken only up to the same time. The random seed sets the surface pattern and the first disturbances: with different seeds even the same settings give different storms (the spread is the ensemble’s theme). So while A is remembered, restarts take its seed — and A and B differ only by what was changed. One run is computed: two at once would each go at half the speed. A is kept while the page is open.')))
    this.canvas = this.root.querySelector('canvas')!; this.ctx = this.canvas.getContext('2d')!
    this.root.querySelector('.ibar__close')!.addEventListener('click', () => this.toggle(false))
    this.root.querySelector('[data-cmp="remember"]')!.addEventListener('click', () => {
      const c = this.current
      if (!c?.points.length) return
      this.reference = { name: c.name, config: structuredClone(c.config), points: [...c.points], maps: [...c.maps] }
      this.keepSeed = true; this.shown = ''; this.onChange(); this.draw()
    })
    this.root.querySelector('[data-cmp="forget"]')!.addEventListener('click', () => { this.reference = null; this.shown = ''; this.onChange(); this.draw() })
    this.root.querySelector('[data-cmp="reseed"]')!.addEventListener('click', () => { if (this.reference) this.onReseed(this.reference.config.seed) })
    this.root.querySelector<HTMLInputElement>('#cmpKeepSeed')!.addEventListener('change', e => { this.keepSeed = (e.target as HTMLInputElement).checked })
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.open) this.toggle(false) })
    addEventListener('resize', () => this.open && this.draw())
  }

  /** The seed a restart takes: A's while it is remembered and held, else none (a new one). */
  get seed() { return this.reference && this.keepSeed ? this.reference.config.seed : null }

  toggle(open = !this.open) { this.open = open; this.root.hidden = !open; if (open) { this.shown = ''; if (this.current) this.refresh(this.current) } }

  /** Called every frame with the run going on. */
  refresh(current: CurrentRun) {
    this.current = current
    if (!this.open) return
    const key = `${current.points.length}|${current.maps.length}|${current.name}|${!!this.reference}`
    if (key === this.shown) return
    this.shown = key
    this.draw()
  }

  private draw() {
    const c = this.canvas, host = c.parentElement!, dpr = Math.min(devicePixelRatio, 2), w = host.clientWidth, h = host.clientHeight, ctx = this.ctx
    c.style.width = `${w}px`; c.style.height = `${h}px`
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const pal = instrumentPalette(this.root), text = (id: string, v: string) => { (this.root.querySelector(`#${id}`) as HTMLElement).innerHTML = v }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, w, h); ctx.font = `11px ${MONO}`
    const a = this.reference, b = this.current, t = b?.time ?? 0
    const button = (name: string) => this.root.querySelector<HTMLButtonElement>(`[data-cmp="${name}"]`)!
    button('remember').disabled = !b?.points.length; button('forget').disabled = !a; button('reseed').disabled = !a || a.config.seed === b?.config.seed
    this.root.querySelector<HTMLInputElement>('#cmpKeepSeed')!.checked = this.keepSeed
    this.root.querySelector<HTMLInputElement>('#cmpKeepSeed')!.disabled = !a
    text('cmpA', a ? `${a.name} · ${minuteMark(Math.round(a.points[a.points.length - 1].t / 60))}` : L('НЕ ЗАПОМНЕН', 'NOT REMEMBERED'))
    text('cmpB', b ? b.name : '—'); text('cmpTime', minuteMark(Math.floor(t / 60)))

    // What differs, and the highlights up to the same time.
    const changes = a && b ? configChanges(a.config, b.config) : []
    text('cmpHint', !a ? L('Запомните идущий опыт как A, затем измените настройку — новый расчёт станет опытом B.', 'Remember the run going on as A, then change a setting — the new run becomes run B.')
      : !changes.length ? L('Настройки и зерно A и B совпадают: B повторит A один в один.', 'A and B have the same settings and seed: B repeats A exactly.')
      : changes.includes('seed') ? L('Зёрна разные: часть разницы — случайная. «Заново с зерном A» уберёт её.', 'The seeds differ: part of the difference is chance. “Restart with A’s seed” removes it.')
      : L('Зерно общее: вся разница — от изменённых настроек.', 'The seed is shared: all the difference comes from the settings changed.'))
    text('cmpChanges', !a ? '' : changes.length ? readings(changes.map(k => { const x = setting(k, a.config[k]), y = setting(k, b!.config[k]); return [x.name, `A ${x.shown} → B ${y.shown}`] })) : `<dt>${L('ничего', 'nothing')}</dt><dd></dd>`)
    if (a && b) {
      const pa = peaks(a.points.filter(p => p.t <= Math.max(t, 0) + 1)), pb = peaks(b.points)
      const row = (label: string, f: (p: Peaks) => string): [string, string] => [label, `<span style="color:${A_COLOR}">${f(pa)}</span> · <span style="color:${B_COLOR}">${f(pb)}</span>`]
      const n = (k: keyof Peaks, d = 0) => (p: Peaks) => (p[k] as number).toFixed(d)
      text('cmpPeaks', `<dt></dt><dd><span style="color:${A_COLOR}">A</span> · <span style="color:${B_COLOR}">B</span></dd>` + readings([
        row(L('поток, м/с', 'updraught, m/s'), n('updraft', 1)), row(L('UH, м²/с²', 'UH, m²/s²'), n('uh')), row(L('мезоциклон с', 'mesocyclone from'), p => minutes(p.mesocyclone)),
        row(L('дождь у земли с', 'rain at the ground from'), p => minutes(p.firstRain)), row(L('дождь, мм/ч', 'rain, mm/h'), n('rain')), row(L('сумма, мм', 'total, mm'), n('rainTotal', 1)),
        row(L('порыв, м/с', 'gust, m/s'), n('gust', 1)), row(L('град, мм', 'hail, mm'), n('hail', 1)), row(L('молнии, /мин', 'flashes, /min'), n('flashes')),
      ]))
    } else text('cmpPeaks', '')

    // Top: the two maps at the same model time; below: the shared plots.
    const mapsH = Math.min(h * .48, (w - 48) / 2 * .8), gap = 16, mw = (w - 48 - gap) / 2
    this.map(a ? atTime(a.maps, t) : null, 24, 26, mw, mapsH - 30, `A${a ? ` · ${a.name}` : ''}`, a ? L('карты к этому времени нет', 'no map at this time') : L('запомните опыт как A', 'remember a run as A'))
    const mb = b?.maps[b.maps.length - 1] ?? null
    this.map(mb, 24 + mw + gap, 26, mw, mapsH - 30, `B${b ? ` · ${b.name}` : ''}`, L('карта — через модельную минуту', 'the map comes after a model minute'))
    this.plots(a?.points ?? [], b?.points ?? [], t, 24, mapsH + 18, w - 48, h - mapsH - 40)
  }

  /** One echo map in the box (x, y, w, h) keeping the domain's shape, with its title and time. */
  private map(m: EchoMap | null, x: number, y: number, w: number, h: number, title: string, empty: string) {
    const ctx = this.ctx, pal = instrumentPalette(this.root)
    ctx.fillStyle = pal.text; ctx.fillText(m ? `${title} · ${minuteMark(Math.round(m.t / 60))}` : title, x, y - 8)
    if (!m) { ctx.strokeStyle = pal.grid; ctx.strokeRect(x + .5, y + .5, w, h); ctx.fillStyle = pal.label; ctx.fillText(empty, x + 10, y + 20); return }
    const scale = Math.min(w / m.width, h / m.depth), dw = m.width * scale, dh = m.depth * scale, ox = x + (w - dw) / 2, oy = y + (h - dh) / 2
    const img = this.image, g = img.getContext('2d')!
    img.width = m.nx; img.height = m.ny
    const data = g.createImageData(m.nx, m.ny)
    for (let j = 0; j < m.ny; j++) for (let i = 0; i < m.nx; i++) {
      const col = colorAt(Z_PALETTE, echoDbz(m.dbz[i + m.nx * j])), o = 4 * (i + m.nx * (m.ny - 1 - j))
      if (col) { data.data[o] = col[0]; data.data[o + 1] = col[1]; data.data[o + 2] = col[2]; data.data[o + 3] = col[3] ?? 255 }
    }
    g.putImageData(data, 0, 0)
    ctx.fillStyle = '#0b0f12'; ctx.fillRect(ox, oy, dw, dh)
    ctx.imageSmoothingEnabled = true; ctx.drawImage(img, ox, oy, dw, dh)
    ctx.strokeStyle = pal.gridStrong; ctx.strokeRect(ox + .5, oy + .5, dw, dh)
    // A 10 km bar.
    ctx.strokeStyle = pal.text; ctx.beginPath(); ctx.moveTo(ox + 8, oy + dh - 8); ctx.lineTo(ox + 8 + 10_000 * scale, oy + dh - 8); ctx.stroke()
    ctx.fillStyle = pal.text; ctx.fillText(L('10 км', '10 km'), ox + 8, oy + dh - 12)
  }

  /** The shared plots: A dashed, B solid, a line at the time now. */
  private plots(a: readonly TimelinePoint[], b: readonly TimelinePoint[], t: number, x: number, y: number, w: number, h: number) {
    const ctx = this.ctx, pal = instrumentPalette(this.root), rowH = h / ROWS.length
    const span = Math.max(1800, a.length ? a[a.length - 1].t : 0, b.length ? b[b.length - 1].t : 0), X = (s: number) => x + w * s / span
    ROWS.forEach((row, r) => {
      const top = y + r * rowH + 16, bottom = y + (r + 1) * rowH - 6
      const max = Math.max(row.floor, ...a.map(p => p[row.key]), ...b.map(p => p[row.key])) * 1.05, Y = (v: number) => bottom - (bottom - top) * v / max
      ctx.strokeStyle = pal.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, bottom + .5); ctx.lineTo(x + w, bottom + .5); ctx.stroke()
      ctx.fillStyle = pal.text; ctx.fillText(`${row.title}, ${row.unit}`, x, top - 4)
      ctx.fillStyle = pal.label; const scale = max >= 100 ? max.toFixed(0) : max.toFixed(1); ctx.fillText(scale, x + w - ctx.measureText(scale).width, top - 4)
      const line = (pts: readonly TimelinePoint[], color: string, dash: number[]) => {
        if (pts.length < 2) return
        ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.setLineDash(dash); ctx.beginPath()
        pts.forEach((p, i) => { const px = X(p.t), py = Y(p[row.key]); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py) })
        ctx.stroke(); ctx.setLineDash([])
      }
      line(a, A_COLOR, [5, 4]); line(b, B_COLOR, [])
      if (r === ROWS.length - 1) { ctx.fillStyle = pal.label; for (let m = 10; m * 60 <= span; m += 10) ctx.fillText(minuteMark(m), X(m * 60) - 8, bottom + 12) }
    })
    ctx.strokeStyle = pal.gridStrong; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(X(t) + .5, y + 8); ctx.lineTo(X(t) + .5, y + h); ctx.stroke(); ctx.setLineDash([])
  }
}
