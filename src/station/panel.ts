import type { Station, StationRecord } from '../core'
import { minuteMark } from '../clock'
import { help, instrumentPalette, instrumentScreen, numbers, readings, section } from '../instrument'
import { MONO } from '../theme'
import { download, toCsv } from '../share'

type Key = keyof Omit<StationRecord, 't'>
/** One plot of the meteogram: its values (the first is the main line), units and the floor of its scale. */
interface Row { title: string; unit: string; lines: { key: Key; label: string; color: string; bars?: boolean }[]; span?: number; floor?: number; zero?: boolean }

const ROWS: Row[] = [
  { title: 'Температура и точка росы', unit: '°C', lines: [{ key: 'temp', label: 'T', color: '#ff5a46' }, { key: 'dew', label: 'Td', color: '#3ecf6a' }], span: 6 },
  { title: 'Давление (гидростатическая оценка)', unit: 'гПа', lines: [{ key: 'pressure', label: 'p', color: '#d9c36a' }], span: 2 },
  { title: 'Ветер у земли и порывы', unit: 'м/с', lines: [{ key: 'gust', label: 'порыв', color: '#e07a5f' }, { key: 'wind', label: 'ветер', color: '#8fd3e8' }], floor: 10, zero: true },
  { title: 'Осадки', unit: 'мм/ч', lines: [{ key: 'rainRate', label: 'интенсивность', color: '#4f9fe0', bars: true }], floor: 10, zero: true },
]

/**
 * The weather station screen (like the radar and Skew-T): a meteogram of the station's records over model time, the
 * latest values, and the controls to place or remove it. The station itself lives in Atmosphere (src/core/station.ts).
 */
export class StationPanel {
  private readonly root: HTMLDivElement; private readonly canvas: HTMLCanvasElement; private readonly ctx: CanvasRenderingContext2D
  private station: Station | null = null; private shown = -1; private placing = false
  open = false
  /** Called with true when the user asks to place the station (the next click on the 3D view places it), false to remove it. */
  onPlace: (place: boolean) => void = () => {}

  constructor(host: HTMLElement) {
    this.root = instrumentScreen(host, 'station-app', 'METEOLAB · МЕТЕОСТАНЦИЯ',
      '<span>ТОЧКА <b id="stationWhere">НЕТ</b></span><span>ЗАПИСЕЙ <b id="stationCount">0</b></span>',
      section('Станция', `<button class="btn btn--block" data-station="place" title="Закрыть экран и щёлкнуть по земле на 3D-виде: туда встанет станция">Поставить щелчком на 3D</button>
          <div class="side__row"><button class="btn" data-station="remove">Убрать</button><button class="btn" data-station="csv" title="Записи станции в CSV: время, температура, точка росы, давление, ветер, порыв, направление, осадки">Выгрузить CSV</button></div>
          <p class="psec__hint" id="stationHint">Станции нет. Поставьте её щелчком по 3D-виду — лучше на пути грозы.</p>`)
      + section('Сейчас', '<div id="stationNow"></div>')
      + help('Станция стоит на земле: область модели движется с грозой, а станция — нет, и гроза проходит над ней, как над настоящей. Запись раз в модельную минуту: температура и точка росы у земли, ветер (средний за минуту) и порыв (самый сильный за минуту), осадки (интенсивность — по приросту суммы). Давление — гидростатическая оценка по плавучести столбца, относительно среднего по области: холодный купол даёт мезомаксимум в 1–4 гПа, а понижение давления под вращающимся потоком (динамическая часть) сюда не входит. Прохождение фронта порывов — скачок давления, резкое падение температуры и порыв.'))
    this.canvas = this.root.querySelector('canvas')!; this.ctx = this.canvas.getContext('2d')!
    this.root.querySelector('.ibar__close')!.addEventListener('click', () => this.toggle(false))
    this.root.querySelector('[data-station="place"]')!.addEventListener('click', () => { this.toggle(false); this.onPlace(true) })
    this.root.querySelector('[data-station="remove"]')!.addEventListener('click', () => this.onPlace(false))
    this.root.querySelector('[data-station="csv"]')!.addEventListener('click', () => {
      const s = this.station
      if (s?.records.length) download(`meteolab-stanciya-${(s.x / 1000).toFixed(1)}-${(s.y / 1000).toFixed(1)}km.csv`, toCsv(s.records, [
        ['time_s', r => r.t], ['temperature_c', r => r.temp], ['dewpoint_c', r => r.dew], ['pressure_hpa', r => r.pressure], ['wind_ms', r => r.wind],
        ['gust_ms', r => r.gust], ['wind_from_deg', r => r.dir], ['rain_rate_mmh', r => r.rainRate], ['rain_total_mm', r => r.rainTotal], ['hail_mm', r => r.hail],
      ]))
    })
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.open) this.toggle(false) })
    addEventListener('resize', () => this.open && this.draw())
  }

  toggle(open = !this.open) { this.open = open; this.root.hidden = !open; if (open) { this.shown = -1; this.refresh(this.station, this.placing) } }

  /** Called every frame with the current station (or null) and whether the next click places one. */
  refresh(station: Station | null, placing: boolean) {
    const changed = station !== this.station || placing !== this.placing
    this.station = station; this.placing = placing
    if (!this.open) return
    const n = station?.records.length ?? 0
    if (!changed && n === this.shown) return
    this.shown = n
    this.draw()
  }

  private draw() {
    const c = this.canvas, host = c.parentElement!, dpr = Math.min(devicePixelRatio, 2), w = host.clientWidth, h = host.clientHeight, ctx = this.ctx
    c.style.width = `${w}px`; c.style.height = `${h}px`
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const pal = instrumentPalette(this.root)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, w, h); ctx.font = `11px ${MONO}`
    const s = this.station, recs = s?.records ?? [], text = (id: string, v: string) => { (this.root.querySelector(`#${id}`) as HTMLElement).innerHTML = v }
    text('stationWhere', s ? `${(s.x / 1000).toFixed(1)}, ${(s.y / 1000).toFixed(1)} КМ` : this.placing ? 'ЖДЁТ ЩЕЛЧКА' : 'НЕТ'); text('stationCount', String(recs.length))
    text('stationHint', s ? `Станция в ${(s.x / 1000).toFixed(1)} км к востоку и ${(s.y / 1000).toFixed(1)} км к северу от начала координат земли (отмечена на 3D-виде). Перезапуск начинает запись заново.` : this.placing ? 'Щёлкните по земле на 3D-виде.' : 'Станции нет. Поставьте её щелчком по 3D-виду — лучше на пути грозы.')
    const last = recs[recs.length - 1]
    text('stationNow', last ? numbers([['T', last.temp.toFixed(1), '°'], ['Td', last.dew.toFixed(1), '°'], ['порыв', last.gust.toFixed(1), 'м/с'], ['осадки', last.rainRate.toFixed(1), 'мм/ч']])
      + `<dl class="kv">${readings([['давление', `${last.pressure > 0 ? '+' : ''}${last.pressure.toFixed(1)} гПа`], ['ветер', `${last.wind.toFixed(1)} м/с с ${last.dir.toFixed(0)}°`], ['сумма', `${last.rainTotal.toFixed(1)} мм`], ...(last.hail > .05 ? [['град', `${last.hail.toFixed(1)} мм`] as [string, string]] : [])])}</dl>` : '<span class="t-caption">записей пока нет</span>')
    const left = 64, right = w - 24, top = 16, bottom = h - 26
    if (recs.length < 2) { ctx.fillStyle = pal.label; ctx.fillText(s ? 'Запись идёт: первая точка — через модельную минуту.' : 'Станции нет.', left, top + 20); return }
    const t0 = recs[0].t, span = Math.max(1800, recs[recs.length - 1].t - t0), X = (t: number) => left + (right - left) * (t - t0) / span
    const rowH = (bottom - top) / ROWS.length
    ROWS.forEach((row, r) => {
      const y0 = top + r * rowH + 14, y1 = top + (r + 1) * rowH - 12, values = row.lines.flatMap(l => recs.map(p => p[l.key]))
      let lo = Math.min(...values), hi = Math.max(...values)
      if (row.zero) lo = 0
      if (row.floor !== undefined) hi = Math.max(hi, row.floor)
      if (row.span !== undefined && hi - lo < row.span) { const mid = (hi + lo) / 2; lo = mid - row.span / 2; hi = mid + row.span / 2 }
      const Y = (v: number) => y1 - (y1 - y0) * (v - lo) / (hi - lo || 1)
      ctx.strokeStyle = pal.grid; ctx.lineWidth = 1
      for (let k = 0; k <= 2; k++) { const y = y0 + (y1 - y0) * k / 2; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.fillStyle = pal.label; ctx.fillText((hi - (hi - lo) * k / 2).toFixed(hi - lo < 5 ? 1 : 0), 8, y + 3) }
      ctx.fillStyle = pal.text; ctx.fillText(`${row.title}, ${row.unit}`, left, y0 - 4)
      let lx = right
      for (const l of [...row.lines].reverse()) { const label = `— ${l.label}`; lx -= ctx.measureText(label).width + 10; ctx.fillStyle = l.color; ctx.fillText(label, lx, y0 - 4) }
      for (const l of row.lines) {
        ctx.strokeStyle = l.color; ctx.fillStyle = l.color; ctx.lineWidth = 1.6
        if (l.bars) { const bw = Math.max(1, (right - left) * 60 / span - 1); for (const p of recs) if (p[l.key] > 0) ctx.fillRect(X(p.t) - bw, Y(p[l.key]), bw, y1 - Y(p[l.key])); continue }
        ctx.beginPath(); recs.forEach((p, i) => { const x = X(p.t), y = Y(p[l.key]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y) }); ctx.stroke()
      }
      // Precipitation: the running total on its own scale (right edge).
      if (row.lines[0].key === 'rainRate') {
        const total = recs[recs.length - 1].rainTotal - recs[0].rainTotal, top2 = Math.max(5, Math.ceil(total / 5) * 5), Yt = (v: number) => y1 - (y1 - y0) * v / top2
        ctx.strokeStyle = '#c9d6da'; ctx.setLineDash([4, 3]); ctx.beginPath(); recs.forEach((p, i) => { const x = X(p.t), y = Yt(p.rainTotal - recs[0].rainTotal); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y) }); ctx.stroke(); ctx.setLineDash([])
        ctx.fillStyle = '#c9d6da'; ctx.fillText(`сумма до ${top2} мм`, right - 90, y0 + 10)
      }
    })
    // Time axis: model minutes, every 10.
    ctx.fillStyle = pal.label; ctx.strokeStyle = pal.gridStrong
    for (let m = Math.ceil(t0 / 600) * 10; m * 60 <= t0 + span; m += 10) { const x = X(m * 60); ctx.beginPath(); ctx.moveTo(x, bottom - 6); ctx.lineTo(x, bottom); ctx.stroke(); ctx.fillText(minuteMark(m), x - 8, bottom + 12) }
  }
}
