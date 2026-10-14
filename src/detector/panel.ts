import type { AtmosphereModel, Flash } from '../core'
import { minuteMark } from '../clock'
import { help, instrumentPalette, instrumentScreen, numbers, press, readings, section } from '../instrument'
import { MONO } from '../theme'
import { flashDensity, flashFacts, flashPoint, flashRates, lightningJumps, total } from './stats'

type Mode = 'marks' | 'density'
/** Colours of the marks by age, minutes: [younger than, colour] (as on lightning maps: white the newest, red the oldest). */
const AGES: [number, string][] = [[2, '#ffffff'], [5, '#ffe45c'], [10, '#ffa63d'], [20, '#ff5a3d'], [Infinity, '#b0303a']]
/** Flash density steps, flashes per km² over the period: [from, colour]. */
const DENSITY: [number, string][] = [[.05, '#203a6b'], [.1, '#2d63a8'], [.25, '#2fa3b8'], [.5, '#4fc46a'], [1, '#e2d84a'], [2, '#f0913a'], [4, '#e0443a'], [8, '#ff7ee8']]
const IC_COLOR = '#a58cff', CG_NEG = '#ffe45c', CG_POS = '#ff8a3d', JUMP = '#ff4d6a'
/** Size of the density squares, m. */
const DENSITY_CELL = 2000
const ageColor = (minutes: number) => AGES.find(([limit]) => minutes < limit)![1]

/**
 * The lightning detector (2.3): a separate screen like the radar's. A map of the flashes around the storm — CG
 * strikes as − and +, IC flashes as dots at the centre of their channel, coloured by age; or the flash density per km²
 * over the period. Under it the flash rate minute by minute (IC, −CG, +CG) with the lightning jumps (2σ). A click on a
 * mark opens the flash's card and rings the mark (a detector locates flashes; the channel is for the 3D view).
 */
export class DetectorPanel {
  private readonly root: HTMLDivElement; private readonly canvas: HTMLCanvasElement; private readonly ctx: CanvasRenderingContext2D
  private model: AtmosphereModel | null = null
  private mode: Mode = 'marks'; private period = 30
  private selected: Flash | null = null
  /** What was drawn last (flash count and model time): redraw only when they change. */
  private drawn = ''
  /** Screen positions of the marks drawn, for the click. */
  private marks: { x: number; y: number; flash: Flash }[] = []
  open = false

  constructor(host: HTMLElement) {
    const seg = (name: string, options: [string, string][]) => `<div class="seg seg--block seg--instrument" data-seg="${name}">${options.map(([v, t]) => `<button data-value="${v}">${t}</button>`).join('')}</div>`
    this.root = instrumentScreen(host, 'detector-app', 'METEOLAB · ГРОЗОПЕЛЕНГАТОР',
      '<span>ВСПЫШЕК/МИН <b id="detRate">0</b></span><span>IC <b id="detIc">0</b></span><span>CG <b id="detCg">0</b></span><span>СКАЧОК <b id="detJump">—</b></span>',
      section('Карта', seg('mode', [['marks', 'Отметки'], ['density', 'Плотность']]) + seg('period', [['10', '10 мин'], ['30', '30 мин'], ['60', '60 мин']])
        + '<p class="psec__hint" id="detLegend"></p>')
      + section('Сейчас', '<div id="detNow"></div>')
      + section('Вспышка', '<div id="detCard"><span class="t-caption">Щёлкните по отметке на карте</span></div>')
      + help('Грозопеленгатор видит каждую вспышку модели. Удар в землю (CG) отмечен там, где канал коснулся земли: «−» — отрицательный (опускает на землю отрицательный заряд, обычный), «+» — положительный. Внутриоблачная вспышка (IC) — точка в центре её канала, как её засекает сеть VHF-датчиков. Ограничения модели: в обычной грозе в природе около 90 % ударов в землю отрицательные, в модели пока больше половины положительные (в ядре потока слишком мало переохлаждённой воды, и нижний положительный заряд слабый); на сетке ~1 км вспышек меньше и они крупнее, чем видят сети VHF-датчиков в настоящих суперячейках (там до сотни и больше в минуту). Цвет — возраст: белый — последние 2 минуты, жёлтый, оранжевый, красный — старше. Область модели движется вместе с грозой, а отметки стоят на земле, поэтому старые остаются позади. Плотность — вспышки на км² за выбранный период в квадратах 2×2 км. График внизу — вспышки за каждую модельную минуту; «скачок» — резкий рост частоты (алгоритм 2σ, Schultz и др. 2009, при 10 и более вспышках в минуту): так усиливается восходящий поток, и часто за этим следуют град и сильный ветер.'))
    this.canvas = this.root.querySelector('canvas')!; this.ctx = this.canvas.getContext('2d')!
    this.root.querySelector('.ibar__close')!.addEventListener('click', () => this.toggle(false))
    this.root.querySelectorAll<HTMLElement>('[data-seg]').forEach(s => s.addEventListener('click', e => {
      const v = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.value
      if (!v) return
      if (s.dataset.seg === 'mode') this.mode = v as Mode; else this.period = Number(v)
      this.pressAll(); this.redraw()
    }))
    this.canvas.addEventListener('click', e => {
      const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top
      let best: Flash | null = null, d2 = 14 ** 2
      for (const m of this.marks) { const d = (m.x - x) ** 2 + (m.y - y) ** 2; if (d < d2) { d2 = d; best = m.flash } }
      this.selected = best; this.redraw()
    })
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.open) this.toggle(false) })
    addEventListener('resize', () => this.open && this.redraw())
    this.pressAll()
  }

  toggle(open = !this.open) { this.open = open; this.root.hidden = !open; if (open) this.redraw() }

  /** Called every frame with the model the page shows. */
  refresh(model: AtmosphereModel) {
    if (model !== this.model) { this.model = model; this.selected = null; this.drawn = '' }
    if (!this.open) return
    const key = `${model.flashCount.ic + model.flashCount.cg} ${model.time}`
    if (key !== this.drawn) this.draw(key)
  }

  private redraw() { this.drawn = ''; if (this.model) this.refresh(this.model) }

  private pressAll() {
    press(this.root.querySelectorAll<HTMLElement>('[data-seg="mode"] button'), b => b.dataset.value === this.mode)
    press(this.root.querySelectorAll<HTMLElement>('[data-seg="period"] button'), b => Number(b.dataset.value) === this.period)
  }

  private text(id: string, html: string) { (this.root.querySelector(`#${id}`) as HTMLElement).innerHTML = html }

  private draw(key: string) {
    this.drawn = key
    const m = this.model!, c = this.canvas, host = c.parentElement!, dpr = Math.min(devicePixelRatio, 2), w = host.clientWidth, h = host.clientHeight, ctx = this.ctx
    c.style.width = `${w}px`; c.style.height = `${h}px`
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const pal = instrumentPalette(this.root)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, w, h); ctx.font = `11px ${MONO}`
    const now = m.time, since = now - this.period * 60, recent = m.flashes.filter(f => f.time > since)
    // Rates minute by minute from the start (the quiet minutes before the first flash are the jump's history), or, when
    // older flashes are not here (dropped, or a run opened from a file), from the oldest one kept; the last minute is
    // still filling.
    const dropped = m.flashCount.ic + m.flashCount.cg > m.flashes.length
    const first = !dropped ? 0 : m.flashes.length ? Math.floor((m.flashes[0].time - 1) / 60) * 60 : Math.floor(now / 60) * 60
    const bins = flashRates(m.flashes, Math.max(0, first), Math.max(first, now - 1)), jumps = lightningJumps(bins)
    const lastFull = bins.length >= 2 ? bins[bins.length - 2] : null, rate = lastFull ? total(lastFull) : 0
    this.text('detRate', String(rate)); this.text('detIc', String(m.flashCount.ic)); this.text('detCg', String(m.flashCount.cg))
    const jumpAgo = jumps.length ? (now - jumps[jumps.length - 1]) / 60 : Infinity
    this.text('detJump', jumpAgo < 10 ? `${Math.floor(jumpAgo)}′ НАЗАД` : '—')
    const cg = recent.filter(f => f.kind === 'CG'), pos = cg.filter(f => f.charge > 0).length, ic = recent.length - cg.length
    this.text('detNow', numbers([['вспышек в мин', String(rate), ''], ['за период', String(recent.length), '']])
      + `<dl class="kv">${readings([['IC : CG', cg.length ? `${(ic / cg.length).toFixed(1)} : 1` : ic ? 'только IC' : '—'], ['+CG среди CG', cg.length ? `${Math.round(100 * pos / cg.length)} %` : '—'], ['скачок', jumps.length ? `${Math.floor(jumps[jumps.length - 1] / 60)}′${jumpAgo < 10 ? ' — недавно' : ''}` : 'не было']])}</dl>`)
    this.text('detLegend', this.mode === 'marks'
      ? `<span style="color:${AGES[0][1]}">■</span> &lt;2′ <span style="color:${AGES[1][1]}">■</span> &lt;5′ <span style="color:${AGES[2][1]}">■</span> &lt;10′ <span style="color:${AGES[3][1]}">■</span> &lt;20′ <span style="color:${AGES[4][1]}">■</span> старше · − и + — удары в землю, точки — IC`
      : `вспышек на км² за ${this.period} мин: ${DENSITY.map(([v, col]) => `<span style="color:${col}">■</span> ${String(v).replace('.', ',')}`).join(' ')}`)

    // Map: the domain now with a margin of a quarter of its size around it (the strikes stay behind the moving storm).
    const graphH = Math.min(170, h * .3), mapTop = 12, mapBottom = h - graphH - 18, { width: W, depth: D } = m.grid
    const spanX = W * 1.5, spanY = D * 1.5, scale = Math.min((w - 40) / spanX, (mapBottom - mapTop) / spanY)
    const cx = w / 2, cy = (mapTop + mapBottom) / 2, X = (x: number) => cx + (x - W / 2) * scale, Y = (y: number) => cy - (y - D / 2) * scale
    ctx.save(); ctx.beginPath(); ctx.rect(X(-W / 4), Y(D * 1.25), spanX * scale, spanY * scale); ctx.clip()
    // Ground grid every 10 km, fixed to the ground (it slides as the domain moves).
    const [ox, oy] = m.frameOffset()
    ctx.strokeStyle = pal.grid; ctx.lineWidth = 1
    for (let gx = Math.ceil((ox - W / 4) / 10_000) * 10_000; gx <= ox + W * 1.25; gx += 10_000) { const x = X(gx - ox); ctx.beginPath(); ctx.moveTo(x, Y(D * 1.25)); ctx.lineTo(x, Y(-D / 4)); ctx.stroke() }
    for (let gy = Math.ceil((oy - D / 4) / 10_000) * 10_000; gy <= oy + D * 1.25; gy += 10_000) { const y = Y(gy - oy); ctx.beginPath(); ctx.moveTo(X(-W / 4), y); ctx.lineTo(X(W * 1.25), y); ctx.stroke() }
    if (this.mode === 'density') {
      const { cols, rows, density } = flashDensity(m, recent, since, DENSITY_CELL), cw = W / cols, ch = D / rows
      for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
        const v = density[k + r * cols], step = [...DENSITY].reverse().find(([from]) => v >= from)
        if (!step) continue
        ctx.fillStyle = step[1]; ctx.fillRect(X(k * cw), Y((r + 1) * ch), cw * scale + .5, ch * scale + .5)
      }
    }
    // The domain now.
    ctx.strokeStyle = pal.gridStrong; ctx.setLineDash([5, 4]); ctx.strokeRect(X(0), Y(D), W * scale, D * scale); ctx.setLineDash([])
    // A selected flash no longer kept is forgotten.
    if (this.selected && !m.flashes.includes(this.selected)) this.selected = null
    // Marks, oldest first so the newest are on top.
    this.marks = []
    if (this.mode === 'marks') for (const f of recent) {
      const p = flashPoint(m, f), x = X(p.x), y = Y(p.y), color = ageColor((now - f.time) / 60)
      this.marks.push({ x, y, flash: f })
      ctx.fillStyle = color
      if (f.kind === 'IC') { ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill(); continue }
      ctx.fillRect(x - 5, y - 1.5, 10, 3)
      if (f.charge > 0) ctx.fillRect(x - 1.5, y - 5, 3, 10)
    }
    if (this.selected) {
      const p = flashPoint(m, this.selected)
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 9, 0, Math.PI * 2); ctx.stroke()
    }
    ctx.restore()
    ctx.fillStyle = pal.label
    ctx.fillText('сетка 10 км · пунктир — область модели сейчас', X(-W / 4) + 4, mapBottom + 12)
    if (!m.flashes.length) { ctx.fillStyle = pal.text; ctx.fillText(m.config.lightning === false ? 'Молнии выключены в настройках.' : 'Вспышек пока нет: заряд в облаке копится (обычно 15–25 минут от начала грозы).', X(-W / 4) + 12, mapTop + 22) }
    this.drawRates(bins, jumps, now, mapBottom + 22, h - 8, w, pal)
    this.drawCard()
  }

  /** The flash rate graph: stacked bars per model minute over the last hour, the jumps marked. */
  private drawRates(bins: ReturnType<typeof flashRates>, jumps: number[], now: number, top: number, bottom: number, w: number, pal: ReturnType<typeof instrumentPalette>) {
    const ctx = this.ctx, left = 44, right = w - 16, start = Math.max(0, Math.floor(now / 60) * 60 - 3600), shown = bins.filter(b => b.t >= start)
    const peak = Math.max(10, ...shown.map(total)), top2 = Math.ceil(peak / 10) * 10, barW = (right - left) / 61
    const X = (t: number) => left + (t - start) / 60 * barW, Y = (v: number) => bottom - 12 - (bottom - 12 - top - 12) * v / top2
    ctx.fillStyle = pal.text; ctx.fillText('вспышек в минуту:', left, top + 4)
    let lx = left + 130
    for (const [label, col] of [['IC', IC_COLOR], ['−CG', CG_NEG], ['+CG', CG_POS], ['▼ скачок', JUMP]]) { ctx.fillStyle = col; ctx.fillText(label, lx, top + 4); lx += ctx.measureText(label).width + 14 }
    ctx.strokeStyle = pal.grid; ctx.fillStyle = pal.label
    for (const v of [0, top2 / 2, top2]) { const y = Y(v); ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.fillText(String(v), 8, y + 3) }
    for (const b of shown) {
      let below = 0
      for (const [n, col] of [[b.ic, IC_COLOR], [b.cgNeg, CG_NEG], [b.cgPos, CG_POS]] as [number, string][]) {
        if (!n) continue
        const y1 = Y(below), y2 = Y(below + n)
        ctx.fillStyle = col; ctx.fillRect(X(b.t) + .5, y2, Math.max(1, barW - 1), y1 - y2); below += n
      }
    }
    ctx.fillStyle = JUMP
    for (const t of jumps) if (t >= start) { const x = X(t) + barW / 2; ctx.beginPath(); ctx.moveTo(x - 5, top + 10); ctx.lineTo(x + 5, top + 10); ctx.lineTo(x, top + 18); ctx.fill() }
    ctx.fillStyle = pal.label
    for (let t = Math.ceil(start / 600) * 600; t <= now; t += 600) ctx.fillText(minuteMark(t / 60), X(t) - 6, bottom)
  }

  private drawCard() {
    const f = this.selected
    if (!f || !this.model) { this.text('detCard', '<span class="t-caption">Щёлкните по отметке на карте</span>'); return }
    const d = flashFacts(this.model, f), km = (v: number) => `${v.toFixed(1).replace('.', ',')} км`, ago = (this.model.time - f.time) / 60
    this.text('detCard', `<p class="psec__hint"><b>${d.kind}</b>, ${Math.floor(f.time / 60)}′${String(Math.round(f.time % 60)).padStart(2, '0')}″ (${ago < 1 ? 'только что' : `${Math.floor(ago)} мин назад`})</p><dl class="kv">${readings([
      ['начало пробоя', km(d.start)], ['канал по высоте', `${km(d.low)} — ${km(d.high)}`], ['длина канала', km(d.length)], ['размах от начала', km(d.reach)],
      ['положит. лидер', `${Math.round(d.positiveShare * 100)} % канала`],
      [f.kind === 'IC' ? 'нейтрализовано' : 'опущено на землю', `${f.kind === 'IC' ? '±' : d.charge > 0 ? '+' : '−'}${Math.abs(d.charge).toFixed(1).replace('.', ',')} Кл`],
      ['потенциал канала', `${d.potential.toFixed(0).replace('-', '−')} МВ`],
    ])}</dl>`)
  }
}
