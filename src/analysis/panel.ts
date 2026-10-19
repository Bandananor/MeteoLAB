import { decimal, L } from '../i18n'
import { type AtmosphereModel, contour, groundRain, frontDistance, isobarStep, pressureCentres, type StationPlot, stationPlots, surfacePressureField } from '../core'
import { flashPoint } from '../detector/stats'
import { help, instrumentPalette, instrumentScreen, numbers, press, readings, section } from '../instrument'
import { MONO } from '../theme'

type Layer = 'isobars' | 'stations' | 'front' | 'rain'
const LAYERS: [Layer, string][] = [['isobars', L('Изобары и центры В / Н', 'Isobars and H / L centres')], ['stations', L('Станции', 'Stations')], ['front', L('Фронт', 'Front')], ['rain', L('Осадки у земли', 'Precipitation at the ground')]]
const CLICK_STATION = L('Щёлкните по станции на карте', 'Click a station on the map')
const TEMP = '#ff6b5a', DEW = '#4fc46a', PRESSURE = '#d9dee2', ISOBAR = '#8fb3ff', HIGH = '#5aa0ff', LOW = '#ff5a5a', THUNDER = '#ffb03d'
/** Rain at the ground, mm/h: [from, colour] (light green to dark, as on a surface chart's precipitation shading). */
const RAIN: [number, string][] = [[.5, 'rgba(80,200,110,.25)'], [5, 'rgba(80,200,110,.45)'], [20, 'rgba(60,170,90,.65)'], [50, 'rgba(40,140,70,.8)']]

/**
 * The surface analysis (2.6): a separate screen like the instruments'. The domain now from above with what a
 * forecaster draws on a surface chart: isobars of the pressure at the ground (smoothed) with the highs and lows, the
 * front with its symbols, the rain at the ground, and station plots — temperature, dew point, pressure, the wind as a
 * barb, cloud overhead, shower or thunderstorm. A click on a station shows its numbers.
 */
export class AnalysisPanel {
  private readonly root: HTMLDivElement; private readonly canvas: HTMLCanvasElement; private readonly ctx: CanvasRenderingContext2D
  private model: AtmosphereModel | null = null
  private layers = new Set<Layer>(['isobars', 'stations', 'front', 'rain']); private spacing = 6000
  private drawn = ''
  private plots: StationPlot[] = []; private chosen: StationPlot | null = null
  private view = { X: (x: number) => x, Y: (y: number) => y }
  open = false

  constructor(host: HTMLElement) {
    this.root = instrumentScreen(host, 'analysis-app', L('METEOLAB · ПРИЗЕМНЫЙ АНАЛИЗ', 'METEOLAB · SURFACE ANALYSIS'),
      `<span>P <b id="anaRange">—</b></span><span>${L('ИЗОБАРЫ ЧЕРЕЗ', 'ISOBARS EVERY')} <b id="anaStep">—</b></span><span id="anaTime"></span>`,
      section(L('Слои', 'Layers'), LAYERS.map(([k, t]) => `<label class="check"><input type="checkbox" data-layer="${k}" checked> ${t}</label>`).join('')
        + `<div class="seg seg--block seg--instrument" data-seg="spacing"><button data-value="6000">${L('Станции через 6 км', 'Stations every 6 km')}</button><button data-value="12000">${L('через 12 км', 'every 12 km')}</button></div>`)
      + section(L('Давление', 'Pressure'), '<div id="anaNow"></div>')
      + section(L('Станция', 'Station'), `<div id="anaCard"><span class="t-caption">${CLICK_STATION}</span></div>`)
      + section(L('Как читать станцию', 'How to read a station'), `<p class="psec__hint">${L(`<span style="color:${TEMP}">температура</span> слева сверху, <span style="color:${DEW}">точка росы</span> слева снизу, <span style="color:${PRESSURE}">давление</span> справа сверху — десятые доли гПа без «10» и «9» впереди (135 = 1013,5). Палочка — откуда дует ветер, перо — 5 м/с, полпера — 2,5, флажок — 25. Кружок закрашен по доле облачности (восьмыми, в радиусе 4 км). <span style="color:${DEW}">▽ с точкой</span> — ливень, <span style="color:${THUNDER}">ϟ</span> — гроза (вспышка ближе 10 км за 10 минут).`, `<span style="color:${TEMP}">temperature</span> top left, <span style="color:${DEW}">dew point</span> bottom left, <span style="color:${PRESSURE}">pressure</span> top right — tenths of hPa without the leading “10” or “9” (135 = 1013.5). The staff — where the wind blows from, a barb — 5 m/s, a half barb — 2.5, a pennant — 25. The circle is filled by the cloud cover (in eighths, within 4 km). <span style="color:${DEW}">▽ with a dot</span> — a shower, <span style="color:${THUNDER}">ϟ</span> — a thunderstorm (a flash within 10 km in 10 minutes).`)}</p>`)
      + help(L('Приземный анализ — карта, которую синоптик рисует по наблюдениям станций: изобары (линии равного давления), центры высокого (В) и низкого (Н) давления, фронты и сами станции. Давление берётся из самой модели у земли — и вес воздуха (холодный тяжелее, давление под ним выше), и динамическая часть (понижение под вращающимся потоком) — и сглаживается, как сглаживает синоптик. Изобары проводятся через 0,5, 1 или 2 гПа, каждые 5 гПа — толще. Область модели — 50–150 км, поэтому на карте видны мезомасштабные детали: мезоповышение под холодным оттоком грозы (+1…+4 гПа), рост давления за холодным фронтом, ложбина перед ним. Сразу после открытия файла, до первого шага расчёта, давление — гидростатическая оценка (поле давления в файл не сохраняется). Изобары циклона, на сотни километров, сюда не помещаются — это задача будущей синоптической модели MeteoLab. Ветер у станций — относительно земли; карта — область модели сейчас, север сверху.', 'A surface analysis is the map a forecaster draws from station observations: isobars (lines of equal pressure), centres of high (H) and low (L) pressure, fronts and the stations themselves. The pressure comes from the model itself at the ground — both the weight of the air (cold air is heavier, the pressure under it higher) and the dynamic part (the drop under a rotating updraught) — and is smoothed as a forecaster smooths it. Isobars are drawn every 0.5, 1 or 2 hPa, every 5 hPa thicker. The model’s domain is 50–150 km, so the map shows mesoscale detail: the mesohigh under a storm’s cold outflow (+1…+4 hPa), the pressure rise behind a cold front, the trough ahead of it. Right after opening a file, before the first step, the pressure is a hydrostatic estimate (the pressure field is not saved in the file). A cyclone’s isobars, hundreds of kilometres across, do not fit here — that is a job for MeteoLab’s future synoptic model. The wind at the stations is ground-relative; the map is the model’s domain now, north up.')))
    this.canvas = this.root.querySelector('canvas')!; this.ctx = this.canvas.getContext('2d')!
    this.root.querySelector('.ibar__close')!.addEventListener('click', () => this.toggle(false))
    this.root.querySelectorAll<HTMLInputElement>('[data-layer]').forEach(input => input.addEventListener('change', () => {
      const k = input.dataset.layer as Layer
      if (input.checked) this.layers.add(k); else this.layers.delete(k)
      this.redraw()
    }))
    this.root.querySelector('[data-seg="spacing"]')!.addEventListener('click', e => {
      const v = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.value
      if (v) { this.spacing = Number(v); this.chosen = null; this.pressAll(); this.redraw() }
    })
    this.canvas.addEventListener('click', e => {
      const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, { X, Y } = this.view
      let best: StationPlot | null = null, d2 = 24 ** 2
      for (const p of this.plots) { const d = (X(p.x) - x) ** 2 + (Y(p.y) - y) ** 2; if (d < d2) { d2 = d; best = p } }
      this.chosen = best; this.redraw()
    })
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.open) this.toggle(false) })
    addEventListener('resize', () => this.open && this.redraw())
    this.pressAll()
  }

  toggle(open = !this.open) { this.open = open; this.root.hidden = !open; if (open) this.redraw() }

  /** Called every frame with the model the page shows: redrawn every model minute. */
  refresh(model: AtmosphereModel) {
    if (model !== this.model) { this.model = model; this.chosen = null; this.drawn = '' }
    if (!this.open) return
    const key = `${Math.floor(model.time / 60)}`
    if (key !== this.drawn) this.draw(key)
  }

  private redraw() { this.drawn = ''; if (this.model) this.refresh(this.model) }

  private pressAll() { press(this.root.querySelectorAll<HTMLElement>('[data-seg="spacing"] button'), b => Number(b.dataset.value) === this.spacing) }

  private text(id: string, html: string) { (this.root.querySelector(`#${id}`) as HTMLElement).innerHTML = html }

  private draw(key: string) {
    this.drawn = key
    const m = this.model!, c = this.canvas, host = c.parentElement!, dpr = Math.min(devicePixelRatio, 2), w = host.clientWidth, h = host.clientHeight, ctx = this.ctx
    c.style.width = `${w}px`; c.style.height = `${h}px`
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const pal = instrumentPalette(this.root)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, w, h); ctx.font = `11px ${MONO}`
    const { nx, ny, dx, dy, width: W, depth: D } = m.grid, scale = Math.min((w - 48) / W, (h - 48) / D), x0 = (w - W * scale) / 2, y0 = (h + D * scale) / 2
    const X = (x: number) => x0 + x * scale, Y = (y: number) => y0 - y * scale
    this.view = { X, Y }
    const p = surfacePressureField(m), step = isobarStep(p)
    let lo = Infinity, hi = -Infinity; for (const v of p) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
    const f1 = (v: number) => decimal(v, 1)
    this.text('anaRange', `${f1(lo)}…${f1(hi)} ${L('гПа', 'hPa')}`); this.text('anaStep', `${decimal(step, String(step).split('.')[1]?.length ?? 0)} ${L('гПа', 'hPa')}`)
    this.text('anaTime', `T+${Math.floor(m.time / 3600)}:${String(Math.floor(m.time / 60) % 60).padStart(2, '0')}`)
    this.text('anaNow', numbers([[L('перепад по области', 'range over the domain'), f1(hi - lo), L('гПа', 'hPa')]]) + `<dl class="kv">${readings([[L('мин', 'min'), `${f1(lo)} ${L('гПа', 'hPa')}`], [L('макс', 'max'), `${f1(hi)} ${L('гПа', 'hPa')}`]])}</dl>`)
    ctx.save(); ctx.beginPath(); ctx.rect(X(0), Y(D), W * scale, D * scale); ctx.clip()
    // Grid every 6 km.
    ctx.strokeStyle = pal.grid; ctx.lineWidth = 1
    for (let x = 0; x <= W; x += 6000) { ctx.beginPath(); ctx.moveTo(X(x), Y(0)); ctx.lineTo(X(x), Y(D)); ctx.stroke() }
    for (let y = 0; y <= D; y += 6000) { ctx.beginPath(); ctx.moveTo(X(0), Y(y)); ctx.lineTo(X(W), Y(y)); ctx.stroke() }
    if (this.layers.has('rain')) this.drawRain(m, X, Y, scale)
    if (this.layers.has('isobars')) this.drawIsobars(p, step, nx, ny, dx, dy, X, Y)
    if (this.layers.has('front') && m.config.frontLine) this.drawFront(m, X, Y)
    // Stations at least ~80 px apart (on a phone 6 km is too dense for their numbers): the spacing grows by 6 km steps.
    const spacing = Math.max(this.spacing, Math.ceil(80 / scale / 6000) * 6000)
    this.plots = stationPlots(m, p, spacing, m.flashes, f => flashPoint(m, f))
    if (this.layers.has('stations')) for (const s of this.plots) this.drawStation(s, X(s.x), Y(s.y), s === this.chosen)
    ctx.restore()
    ctx.strokeStyle = pal.gridStrong; ctx.strokeRect(X(0), Y(D), W * scale, D * scale)
    ctx.fillStyle = pal.label
    for (let x = 0; x <= W; x += 12000) ctx.fillText(`${x / 1000}`, X(x) - 6, Y(0) + 14)
    for (let y = 0; y <= D; y += 12000) ctx.fillText(`${y / 1000}`, X(0) - 24, Y(y) + 4)
    ctx.fillText(`${L('км · север сверху', 'km · north up')}${w < 600 ? '' : L(' · область модели сейчас', ' · the model’s domain now')}${spacing > this.spacing ? L(` · станции через ${spacing / 1000} км`, ` · stations every ${spacing / 1000} km`) : ''}`, X(0), Y(D) - 8)
    this.drawCard()
  }

  private drawRain(m: AtmosphereModel, X: (x: number) => number, Y: (y: number) => number, scale: number) {
    const { nx, ny, dx, dy } = m.grid, ctx = this.ctx
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const rate = groundRain(m, x + nx * y)
      const step = [...RAIN].reverse().find(([from]) => rate >= from)
      if (!step) continue
      ctx.fillStyle = step[1]; ctx.fillRect(X((x - .5) * dx), Y((y + .5) * dy), dx * scale + .5, dy * scale + .5)
    }
  }

  /** Isobars every `step` hPa, labelled, thicker every 5 hPa (as on Russian charts); В and Н at the centres. */
  private drawIsobars(p: Float64Array, step: number, nx: number, ny: number, dx: number, dy: number, X: (x: number) => number, Y: (y: number) => number) {
    const ctx = this.ctx
    let lo = Infinity, hi = -Infinity; for (const v of p) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
    ctx.strokeStyle = ISOBAR; ctx.fillStyle = ISOBAR
    for (let level = Math.ceil(lo / step) * step; level <= hi; level += step) {
      const segs = contour(p, nx, ny, level)
      if (!segs.length) continue
      ctx.lineWidth = Math.abs(level / 5 - Math.round(level / 5)) < 1e-6 ? 2 : 1
      ctx.beginPath()
      for (const [x1, y1, x2, y2] of segs) { ctx.moveTo(X(x1 * dx), Y(y1 * dy)); ctx.lineTo(X(x2 * dx), Y(y2 * dy)) }
      ctx.stroke()
      // The label on the segment nearest the top edge (isobars across the map then stand apart).
      const s = segs.reduce((a, b) => (b[1] > a[1] ? b : a))
      const label = (Math.round(level * 10) / 10).toFixed(step < 1 ? 1 : 0).replace('.', ',')
      ctx.fillText(label, X(s[0] * dx) + 3, Math.max(Y(ny * dy - dy) + 12, Y(s[1] * dy) - 3))
    }
    ctx.font = `bold 18px ${MONO}`
    // Only distinct centres (a trough along a front is a line of small minima, not lows).
    for (const c of pressureCentres(p, nx, ny, 6, .6)) {
      ctx.fillStyle = c.high ? HIGH : LOW; ctx.fillText(c.high ? L('В', 'H') : L('Н', 'L'), X(c.x * dx) - 6, Y(c.y * dy) + 6)
      ctx.font = `10px ${MONO}`; ctx.fillText((Math.round(c.value * 10) / 10).toFixed(1).replace('.', ','), X(c.x * dx) - 14, Y(c.y * dy) + 18); ctx.font = `bold 18px ${MONO}`
    }
    ctx.font = `11px ${MONO}`
  }

  /** The front where it is now (frontDistance = 0 over the domain), with its symbols on the side it moves to. */
  private drawFront(m: AtmosphereModel, X: (x: number) => number, Y: (y: number) => number) {
    const f = m.config.frontLine!, { nx, ny, dx, dy, width, depth } = m.grid, [fx, fy] = m.frame, t = m.time, ctx = this.ctx
    const s = Float64Array.from({ length: nx * ny }, (_, i) => frontDistance(f, (i % nx) * dx + fx * t, Math.floor(i / nx) * dy + fy * t, t, width, depth))
    const segs = contour(s, nx, ny, 0), color = f.kind === 'cold' ? '#4f8fe0' : '#e0574f', a = f.heading * Math.PI / 180, ux = Math.sin(a), uy = Math.cos(a)
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3; ctx.beginPath()
    for (const [x1, y1, x2, y2] of segs) { ctx.moveTo(X(x1 * dx), Y(y1 * dy)); ctx.lineTo(X(x2 * dx), Y(y2 * dy)) }
    ctx.stroke()
    // A symbol every third segment: a triangle (cold) or a half disc (warm) towards the heading.
    segs.forEach(([x1, y1, x2, y2], k) => {
      if (k % 3) return
      const cx = X((x1 + x2) / 2 * dx), cy = Y((y1 + y2) / 2 * dy), r = 6
      ctx.beginPath()
      if (f.kind === 'cold') { ctx.moveTo(cx - uy * r, cy - ux * r); ctx.lineTo(cx + uy * r, cy + ux * r); ctx.lineTo(cx + ux * r * 1.4, cy - uy * r * 1.4) }
      else { const ang = Math.atan2(-uy, ux); ctx.arc(cx, cy, r, ang - Math.PI / 2, ang + Math.PI / 2) }
      ctx.fill()
    })
  }

  /** A station plot around (sx, sy) px. */
  private drawStation(s: StationPlot, sx: number, sy: number, chosen: boolean) {
    const ctx = this.ctx, r = 4
    // Wind barb: the staff towards where the wind comes from; barbs on the clockwise side (northern hemisphere).
    if (s.speed >= 1) {
      const a = s.dir * Math.PI / 180, bx = Math.sin(a), by = -Math.cos(a), L = 26, end = [sx + bx * (r + L), sy + by * (r + L)]
      ctx.strokeStyle = PRESSURE; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(sx + bx * r, sy + by * r); ctx.lineTo(end[0], end[1]); ctx.stroke()
      // Perpendicular, to the right of the staff looking outward.
      const px = -by, py = bx
      let left = s.speed, at = 0
      const pos = (d: number) => [end[0] - bx * d, end[1] - by * d]
      ctx.fillStyle = PRESSURE
      while (left >= 25) { const [ax, ay] = pos(at), [cx, cy] = pos(at + 6); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + px * 10, ay + py * 10); ctx.lineTo(cx, cy); ctx.fill(); left -= 25; at += 8 }
      while (left >= 4.75) { const [ax, ay] = pos(at); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + px * 10 + bx * 3, ay + py * 10 + by * 3); ctx.stroke(); left -= 5; at += 4 }
      if (left >= 2.25) { const [ax, ay] = pos(at || 4); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + px * 5 + bx * 1.5, ay + py * 5 + by * 1.5); ctx.stroke() }
    } else { ctx.strokeStyle = PRESSURE; ctx.beginPath(); ctx.arc(sx, sy, r + 3, 0, Math.PI * 2); ctx.stroke() }
    ctx.lineWidth = chosen ? 2.5 : 1.3; ctx.strokeStyle = chosen ? '#ffffff' : PRESSURE; ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.stroke()
    // Cloud cover by octants, filled clockwise from north (WMO N: 0-8 eighths).
    const octas = Math.round(s.cloud * 8)
    if (octas > 0) { ctx.fillStyle = chosen ? '#ffffff' : PRESSURE; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.arc(sx, sy, r, -Math.PI / 2, -Math.PI / 2 + octas / 8 * Math.PI * 2); ctx.closePath(); ctx.fill() }
    ctx.font = `11px ${MONO}`
    ctx.fillStyle = TEMP; ctx.fillText(String(Math.round(s.temp)).replace('-', '−'), sx - 22, sy - 6)
    ctx.fillStyle = DEW; ctx.fillText(String(Math.round(s.dew)).replace('-', '−'), sx - 22, sy + 14)
    ctx.fillStyle = PRESSURE; ctx.fillText(String(Math.round(s.pressure * 10) % 1000).padStart(3, '0'), sx + 7, sy - 6)
    if (s.thunder) { ctx.fillStyle = THUNDER; ctx.font = `bold 15px ${MONO}`; ctx.fillText('ϟ', sx - 36, sy + 5) }
    else if (s.rain >= .5) {
      // Shower (WMO ww 80-82): a dot over a downward triangle.
      const tx = sx - 30, ty = sy + 2
      ctx.strokeStyle = DEW; ctx.fillStyle = DEW; ctx.lineWidth = 1.3
      ctx.beginPath(); ctx.moveTo(tx - 5, ty - 1); ctx.lineTo(tx + 5, ty - 1); ctx.lineTo(tx, ty + 7); ctx.closePath(); ctx.stroke()
      ctx.beginPath(); ctx.arc(tx, ty - 5, 1.8, 0, Math.PI * 2); ctx.fill()
    }
  }

  private drawCard() {
    const s = this.chosen
    if (!s) { this.text('anaCard', `<span class="t-caption">${CLICK_STATION}</span>`); return }
    const f = (v: number, d = 1) => decimal(v, d).replace('-', '−')
    this.text('anaCard', `<p class="psec__hint">${L('Станция', 'Station')} ${f(s.x / 1000, 0)}, ${f(s.y / 1000, 0)} ${L('км', 'km')}</p><dl class="kv">${readings([
      [L('температура', 'temperature'), `${f(s.temp)} °C`], [L('точка росы', 'dew point'), `${f(s.dew)} °C`], [L('давление', 'pressure'), `${f(s.pressure)} ${L('гПа', 'hPa')}`], [L('ветер', 'wind'), L(`${f(s.speed)} м/с, с ${Math.round(s.dir)}°`, `${f(s.speed)} m/s, from ${Math.round(s.dir)}°`)],
      [L('дождь у земли', 'rain at the ground'), s.rain >= .1 ? `${f(s.rain)} ${L('мм/ч', 'mm/h')}` : L('нет', 'none')], [L('облачность', 'cloud cover'), L(`${Math.round(s.cloud * 8)} из 8 (в радиусе 4 км)`, `${Math.round(s.cloud * 8)} of 8 (within 4 km)`)], [L('гроза рядом', 'thunderstorm near'), s.thunder ? L('да', 'yes') : L('нет', 'no')],
    ])}</dl>`)
  }
}
