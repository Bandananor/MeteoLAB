import { L } from '../i18n'
import { type Station, STATION_MAX, type StationRecord } from '../core'
import { minuteMark } from '../clock'
import { help, instrumentPalette, instrumentScreen, numbers, readings, section } from '../instrument'
import { MONO, STATION_COLORS, STATION_LETTERS } from '../theme'
import { download, toCsv } from '../share'
import { stampColumns } from '../export/stamp'

type Key = keyof Omit<StationRecord, 't'>
const NO_STATION = L('Станций нет. Поставьте станцию щелчком по 3D-виду — лучше на пути грозы; до четырёх в ряд по пути покажут, как фронт порывов доходит до каждой.', 'No stations. Place one with a click in the 3D view — best in the storm’s path; up to four in a row along it show the gust front reaching each in turn.')
/** One plot of the meteogram: its values (the first is the main line), units and the floor of its scale. */
interface Row { title: string; unit: string; lines: { key: Key; label: string; color: string; bars?: boolean }[]; span?: number; floor?: number; zero?: boolean }

const ROWS: Row[] = [
  { title: L('Температура и точка росы', 'Temperature and dew point'), unit: '°C', lines: [{ key: 'temp', label: 'T', color: '#ff5a46' }, { key: 'dew', label: 'Td', color: '#3ecf6a' }], span: 6 },
  { title: L('Давление у земли', 'Surface pressure'), unit: L('гПа', 'hPa'), lines: [{ key: 'pressure', label: 'p', color: '#d9c36a' }], span: 2 },
  { title: L('Ветер у земли и порывы', 'Surface wind and gusts'), unit: L('м/с', 'm/s'), lines: [{ key: 'gust', label: L('порыв', 'gust'), color: '#e07a5f' }, { key: 'wind', label: L('ветер', 'wind'), color: '#8fd3e8' }], floor: 10, zero: true },
  { title: L('Осадки', 'Precipitation'), unit: L('мм/ч', 'mm/h'), lines: [{ key: 'rainRate', label: L('интенсивность', 'rate'), color: '#4f9fe0', bars: true }], floor: 10, zero: true },
]
/** On the comparison the stations share each plot, one line each: its main value. */
const COMPARED: Record<Key, string> = { temp: 'T', dew: 'Td', pressure: 'p', wind: L('ветер', 'wind'), gust: L('порыв', 'gust'), dir: '', rainRate: L('интенсивность', 'rate'), rainTotal: '', hail: '' }

const km = (v: number) => (v / 1000).toFixed(1)
const COLUMNS: [string, (r: StationRecord) => number][] = [
  ['time_s', r => r.t], ['temperature_c', r => r.temp], ['dewpoint_c', r => r.dew], ['pressure_hpa', r => r.pressure], ['wind_ms', r => r.wind],
  ['gust_ms', r => r.gust], ['wind_from_deg', r => r.dir], ['rain_rate_mmh', r => r.rainRate], ['rain_total_mm', r => r.rainTotal], ['hail_mm', r => r.hail],
]

/**
 * The weather station screen (like the radar and Skew-T): up to STATION_MAX stations, each a letter and a colour (its
 * mast in the 3D view), a meteogram of the chosen one's records over model time or all of them compared on one, the
 * latest values, and the controls to place or remove them. The stations themselves live in Atmosphere (src/core/station.ts).
 */
export class StationPanel {
  private readonly root: HTMLDivElement; private readonly canvas: HTMLCanvasElement; private readonly ctx: CanvasRenderingContext2D
  private stations: readonly (Station | null)[] = []; private placing = false; private shown = ''
  /** The station shown (its slot: letter and colour), or all of them compared. */
  chosen: number | 'all' = 0
  open = false
  /** The user asks to add a station (the next click on the 3D view places it). */
  onAdd: () => void = () => {}
  /** The user removes station `index`, or all of them. */
  onRemove: (index: number | 'all') => void = () => {}
  /** The run's seed, for the CSV. */
  seed: () => number = () => 0

  constructor(host: HTMLElement) {
    this.root = instrumentScreen(host, 'station-app', L('METEOLAB · МЕТЕОСТАНЦИИ', 'METEOLAB · WEATHER STATIONS'),
      `<span>${L('СТАНЦИЯ', 'STATION')} <b id="stationWhere">${L('НЕТ', 'NONE')}</b></span><span>${L('ЗАПИСЕЙ', 'RECORDS')} <b id="stationCount">0</b></span>`,
      section(L('Станции', 'Stations'), `<div class="seg seg--block seg--instrument station-pick" id="stationPick"></div>
          <button class="btn btn--block" data-station="place" title="${L('Закрыть экран и щёлкнуть по земле на 3D-виде: туда встанет новая станция', 'Close the screen and click the ground in the 3D view: a new station will stand there')}">${L('Добавить щелчком на 3D', 'Add with a click in 3D')}</button>
          <div class="side__row"><button class="btn" data-station="remove" title="${L('Убрать выбранную станцию', 'Remove the chosen station')}">${L('Убрать', 'Remove')}</button><button class="btn" data-station="clear">${L('Убрать все', 'Remove all')}</button></div>
          <button class="btn btn--block" data-station="csv" title="${L('Записи станции в CSV: время, температура, точка росы, давление, ветер, порыв, направление, осадки; при сравнении — всех станций, с их буквой', 'The station’s records as CSV: time, temperature, dew point, pressure, wind, gust, direction, precipitation; on the comparison every station’s, with its letter')}">${L('Выгрузить CSV', 'Export CSV')}</button>
          <p class="psec__hint" id="stationHint">${NO_STATION}</p>`)
      + section(L('Сейчас', 'Now'), '<div id="stationNow"></div>')
      + help(L('Станции стоят на земле: область модели движется с грозой, а станции — нет, и гроза проходит над ними, как над настоящими. Можно поставить до четырёх, у каждой своя буква и цвет (мачта того же цвета на 3D-виде); «Все» сравнивает их на одном графике — поставьте ряд по пути грозы и увидите, как фронт порывов доходит до каждой по очереди и с какой скоростью идёт. Запись раз в модельную минуту: температура и точка росы у земли, ветер (средний за минуту) и порыв (самый сильный за минуту), осадки (интенсивность — по приросту суммы). Давление у земли — начальное плюс собственное отклонение модели (плавучесть и динамическая часть вместе) от среднего по области, поэтому общий ход давления по области в нём не виден: холодный купол даёт мезомаксимум, вращающийся поток — понижение. Прохождение фронта порывов — скачок давления, резкое падение температуры и порыв.', 'The stations stand on the ground: the model’s domain moves with the storm, the stations do not, and the storm passes over them as over real ones. Up to four can stand, each with its letter and colour (a mast of that colour in the 3D view); “All” compares them on one chart — place a row along the storm’s path and see the gust front reach each in turn and how fast it goes. One record per model minute: temperature and dew point at the ground, the wind (the minute’s mean) and the gust (the minute’s strongest), precipitation (the rate from the growth of the total). The surface pressure is the starting one plus the model’s own departure (buoyancy and the dynamic part together) from the domain mean, so the domain’s overall pressure change is not seen in it: a cold pool gives a mesohigh, a rotating updraught a low. A gust front passing shows as a pressure jump, a sharp temperature drop and a gust.')))
    this.canvas = this.root.querySelector('canvas')!; this.ctx = this.canvas.getContext('2d')!
    this.root.querySelector('.ibar__close')!.addEventListener('click', () => this.toggle(false))
    this.root.querySelector('#stationPick')!.addEventListener('click', e => {
      const v = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-value]')?.dataset.value
      if (v === undefined) return
      this.chosen = v === 'all' ? 'all' : Number(v); this.shown = ''; this.refresh(this.stations, this.placing)
    })
    this.root.querySelector('[data-station="place"]')!.addEventListener('click', () => { this.toggle(false); this.onAdd() })
    this.root.querySelector('[data-station="remove"]')!.addEventListener('click', () => { if (this.chosen !== 'all') this.onRemove(this.chosen) })
    this.root.querySelector('[data-station="clear"]')!.addEventListener('click', () => this.onRemove('all'))
    this.root.querySelector('[data-station="csv"]')!.addEventListener('click', () => {
      if (this.chosen === 'all') {
        const rows = this.stations.flatMap((s, k) => s ? s.records.map(r => ({ ...r, k, x: s.x, y: s.y })) : [])
        if (rows.length) download('meteolab-stancii.csv', toCsv(rows, [...stampColumns(() => this.seed()), ['station', r => STATION_LETTERS[r.k]], ['x_km', r => r.x / 1000], ['y_km', r => r.y / 1000], ...COLUMNS]))
        return
      }
      const s = this.stations[this.chosen]
      if (s?.records.length) download(`meteolab-stanciya-${STATION_LETTERS[this.chosen]}-${km(s.x)}-${km(s.y)}km.csv`, toCsv(s.records, [...stampColumns(() => this.seed()), ...COLUMNS]))
    })
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.open) this.toggle(false) })
    addEventListener('resize', () => this.open && this.draw())
  }

  toggle(open = !this.open) { this.open = open; this.root.hidden = !open; if (open) { this.shown = ''; this.refresh(this.stations, this.placing) } }

  /** Called every frame with the current stations by slot and whether the next click places one. */
  refresh(stations: readonly (Station | null)[], placing: boolean) {
    // A choice of an empty slot (its station removed), or of all with fewer than two, falls back to the first station.
    if (this.chosen === 'all' ? stations.filter(Boolean).length < 2 : !stations[this.chosen]) this.chosen = Math.max(0, stations.findIndex(Boolean))
    this.stations = stations; this.placing = placing
    if (!this.open) return
    const key = `${this.chosen}|${placing}|${stations.map(s => s ? `${s.x},${s.y},${s.records.length},${s.outside}` : '-').join(';')}`
    if (key === this.shown) return
    this.shown = key
    this.draw()
  }

  private draw() {
    const c = this.canvas, host = c.parentElement!, dpr = Math.min(devicePixelRatio, 2), w = host.clientWidth, h = host.clientHeight, ctx = this.ctx
    c.style.width = `${w}px`; c.style.height = `${h}px`
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const pal = instrumentPalette(this.root)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, w, h); ctx.font = `11px ${MONO}`
    const text = (id: string, v: string) => { (this.root.querySelector(`#${id}`) as HTMLElement).innerHTML = v }
    const all = this.chosen === 'all', list = this.stations, s = all ? null : list[this.chosen as number] ?? null
    /** The stations standing, each with its slot. */
    const placed = list.flatMap((x, k) => x ? [{ x, k }] : [])
    const letter = (k: number) => `<span style="color:${STATION_COLORS[k]}">${STATION_LETTERS[k]}</span>`

    // The choice: a letter a station, «Все» from two; the buttons by what there is.
    text('stationPick', placed.map(({ k }) => `<button data-value="${k}" aria-pressed="${this.chosen === k}">${letter(k)}</button>`).join('')
      + (placed.length > 1 ? `<button data-value="all" aria-pressed="${all}">${L('Все', 'All')}</button>` : ''))
    ;(this.root.querySelector('#stationPick') as HTMLElement).hidden = !placed.length
    const button = (name: string) => this.root.querySelector<HTMLButtonElement>(`[data-station="${name}"]`)!
    button('place').disabled = placed.length >= STATION_MAX
    button('place').textContent = placed.length >= STATION_MAX ? L(`Стоят все ${STATION_MAX}`, `All ${STATION_MAX} stand`) : this.placing ? L('Ждёт щелчка на 3D…', 'Awaiting a click in 3D…') : L('Добавить щелчком на 3D', 'Add with a click in 3D')
    button('remove').disabled = !s; button('clear').disabled = !placed.length; button('csv').disabled = !placed.some(({ x }) => x.records.length)

    const where = (x: Station) => `${km(x.x)}, ${km(x.y)} ${L('КМ', 'KM')}`
    text('stationWhere', all ? L(`ВСЕ ${placed.length}`, `ALL ${placed.length}`) : s ? `${letter(this.chosen as number)} · ${where(s)}` : this.placing ? L('ЖДЁТ ЩЕЛЧКА', 'AWAITING A CLICK') : L('НЕТ', 'NONE'))
    text('stationCount', String(all ? placed.reduce((n, { x }) => n + x.records.length, 0) : s?.records.length ?? 0))
    const outside = all ? placed.filter(({ x }) => x.outside).map(({ k }) => STATION_LETTERS[k]) : s?.outside ? [STATION_LETTERS[this.chosen as number]] : []
    text('stationHint', outside.length ? L(`Область ушла вслед за грозой, а станции стоят на земле: ${outside.join(', ')} ${outside.length > 1 ? 'остались' : 'осталась'} позади, записи там остановлены. Чтобы станции и город оставались в области, снимите «Область движется вместе с грозой» в настройках расчёта.`, `The domain has followed the storm, while the stations stand on the ground: ${outside.join(', ')} ${outside.length > 1 ? 'were' : 'was'} left behind and stopped recording. To keep the stations and the city in the domain, untick “The domain moves with the storm” in the computation settings.`)
      : all ? L('Все станции на одном графике, каждая своим цветом. Время прихода фронта порывов к станциям, делённое на расстояние между ними, — его скорость.', 'All the stations on one chart, each in its colour. The time between the gust front reaching two stations over the distance between them is its speed.')
      : s ? L(`Станция ${STATION_LETTERS[this.chosen as number]} в ${km(s.x)} км к востоку и ${km(s.y)} км к северу от начала координат земли (мачта её цвета на 3D-виде). Перезапуск начинает запись заново.`, `Station ${STATION_LETTERS[this.chosen as number]} is ${km(s.x)} km east and ${km(s.y)} km north of the ground’s origin (the mast of its colour in the 3D view). A restart begins the record anew.`)
      : this.placing ? L('Щёлкните по земле на 3D-виде.', 'Click the ground in the 3D view.') : NO_STATION)

    const unit = { ms: L('м/с', 'm/s'), mmh: L('мм/ч', 'mm/h'), mm: L('мм', 'mm'), hpa: L('гПа', 'hPa') }
    const last = s?.records[s.records.length - 1]
    text('stationNow', all ? `<dl class="kv">${readings(placed.map(({ x, k }) => { const r = x.records[x.records.length - 1]; return [letter(k), r ? `${r.temp.toFixed(1)}° · ${r.pressure.toFixed(1)} ${unit.hpa} · ${r.gust.toFixed(0)} ${unit.ms} · ${r.rainRate.toFixed(0)} ${unit.mmh} · ${r.rainTotal.toFixed(1)} ${unit.mm}` : '—'] }))}</dl>`
      : last ? numbers([['T', last.temp.toFixed(1), '°'], ['Td', last.dew.toFixed(1), '°'], [L('порыв', 'gust'), last.gust.toFixed(1), unit.ms], [L('осадки', 'precip.'), last.rainRate.toFixed(1), unit.mmh]])
        + `<dl class="kv">${readings([[L('давление', 'pressure'), `${last.pressure.toFixed(1)} ${unit.hpa}`], [L('ветер', 'wind'), L(`${last.wind.toFixed(1)} м/с с ${last.dir.toFixed(0)}°`, `${last.wind.toFixed(1)} m/s from ${last.dir.toFixed(0)}°`)], [L('сумма', 'total'), `${last.rainTotal.toFixed(1)} ${unit.mm}`], ...(last.hail > .05 ? [[L('град', 'hail'), `${last.hail.toFixed(1)} ${unit.mm}`] as [string, string]] : [])])}</dl>` : `<span class="t-caption">${L('записей пока нет', 'no records yet')}</span>`)

    // The lines to draw: the chosen station's own, or every station's main value in its colour.
    const shown = all ? placed.map(({ x, k }) => ({ recs: x.records, color: STATION_COLORS[k] })).filter(x => x.recs.length > 1) : s && s.records.length > 1 ? [{ recs: s.records, color: '' }] : []
    const left = 64, right = w - 24, top = 16, bottom = h - 26
    if (!shown.length) { ctx.fillStyle = pal.label; ctx.fillText(placed.length ? L('Запись идёт: первая точка — через модельную минуту.', 'Recording: the first point comes after a model minute.') : L('Станций нет.', 'No stations.'), left, top + 20); return }
    const t0 = Math.min(...shown.map(x => x.recs[0].t)), span = Math.max(1800, Math.max(...shown.map(x => x.recs[x.recs.length - 1].t)) - t0), X = (t: number) => left + (right - left) * (t - t0) / span
    const rowH = (bottom - top) / ROWS.length
    ROWS.forEach((row, r) => {
      const y0 = top + r * rowH + 14, y1 = top + (r + 1) * rowH - 12
      const lines = all ? shown.map(x => ({ ...row.lines[0], bars: false, color: x.color, recs: x.recs })) : row.lines.map(l => ({ ...l, recs: shown[0].recs }))
      const values = lines.flatMap(l => l.recs.map(p => p[l.key]))
      let lo = Math.min(...values), hi = Math.max(...values)
      if (row.zero) lo = 0
      if (row.floor !== undefined) hi = Math.max(hi, row.floor)
      if (row.span !== undefined && hi - lo < row.span) { const mid = (hi + lo) / 2; lo = mid - row.span / 2; hi = mid + row.span / 2 }
      const Y = (v: number) => y1 - (y1 - y0) * (v - lo) / (hi - lo || 1)
      ctx.strokeStyle = pal.grid; ctx.lineWidth = 1
      for (let k = 0; k <= 2; k++) { const y = y0 + (y1 - y0) * k / 2; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.fillStyle = pal.label; ctx.fillText((hi - (hi - lo) * k / 2).toFixed(hi - lo < 5 ? 1 : 0), 8, y + 3) }
      ctx.fillStyle = pal.text; ctx.fillText(all ? `${row.title}: ${COMPARED[row.lines[0].key]}, ${row.unit}` : `${row.title}, ${row.unit}`, left, y0 - 4)
      // The legend: the values' labels, or the stations' letters.
      const legend = all ? placed.flatMap(({ x, k }) => x.records.length > 1 ? [{ label: STATION_LETTERS[k], color: STATION_COLORS[k] }] : []) : row.lines
      let lx = right
      for (const l of [...legend].reverse()) { const label = `— ${l.label}`; lx -= ctx.measureText(label).width + 10; ctx.fillStyle = l.color; ctx.fillText(label, lx, y0 - 4) }
      for (const l of lines) {
        ctx.strokeStyle = l.color; ctx.fillStyle = l.color; ctx.lineWidth = 1.6
        if (l.bars) { const bw = Math.max(1, (right - left) * 60 / span - 1); for (const p of l.recs) if (p[l.key] > 0) ctx.fillRect(X(p.t) - bw, Y(p[l.key]), bw, y1 - Y(p[l.key])); continue }
        ctx.beginPath(); l.recs.forEach((p, i) => { const x = X(p.t), y = Y(p[l.key]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y) }); ctx.stroke()
      }
      // Precipitation of one station: the running total on its own scale (right edge).
      const recs = shown[0].recs
      if (!all && row.lines[0].key === 'rainRate') {
        const total = recs[recs.length - 1].rainTotal - recs[0].rainTotal, top2 = Math.max(5, Math.ceil(total / 5) * 5), Yt = (v: number) => y1 - (y1 - y0) * v / top2
        ctx.strokeStyle = '#c9d6da'; ctx.setLineDash([4, 3]); ctx.beginPath(); recs.forEach((p, i) => { const x = X(p.t), y = Yt(p.rainTotal - recs[0].rainTotal); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y) }); ctx.stroke(); ctx.setLineDash([])
        ctx.fillStyle = '#c9d6da'; ctx.fillText(L(`сумма до ${top2} мм`, `total up to ${top2} mm`), right - 90, y0 + 10)
      }
    })
    // Time axis: model minutes, every 10.
    ctx.fillStyle = pal.label; ctx.strokeStyle = pal.gridStrong
    for (let m = Math.ceil(t0 / 600) * 10; m * 60 <= t0 + span; m += 10) { const x = X(m * 60); ctx.beginPath(); ctx.moveTo(x, bottom - 6); ctx.lineTo(x, bottom); ctx.stroke(); ctx.fillText(minuteMark(m), x - 8, bottom + 12) }
  }
}
