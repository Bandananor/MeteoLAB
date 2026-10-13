import { type AtmosphereModel, Environment, parcelIndices, type ZoneConfig, zoneProfile } from '../core'
import { help, instrumentPalette, instrumentScreen, numbers, readings, section } from '../instrument'
import { MONO } from '../theme'

/** Ranges of a zone's differences on the sliders. */
const T_RANGE = 8, Q_RANGE = 6
const fmt = (v: number, digits = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits).replace('.', ',')}`

/**
 * The zones of the environment (2.4): a screen like the instruments' with the map of the domain from above. Zones
 * are drawn as polygons by clicks; the chosen one gets its warmth and moisture at the ground, with its CAPE and CIN
 * (surface parcel) next to the environment's; «Применить» restarts the run with them (they lie on the ground: the
 * domain then moves over them with the storm).
 */
export class ZonesPanel {
  private readonly root: HTMLDivElement; private readonly canvas: HTMLCanvasElement; private readonly ctx: CanvasRenderingContext2D
  private model: AtmosphereModel | null = null
  /** The zones being edited (applied: SimConfig.zones), the chosen one, the corners of the one being drawn (km). */
  private zones: ZoneConfig[] = []; private chosen = -1; private drawing: [number, number][] | null = null
  private applied = '[]'; private drawn = ''
  /** Map transform of the last draw: km to canvas px. */
  private view = { x0: 0, y0: 0, scale: 1 }
  open = false
  /** Called with the zones to run with (an empty list: none). */
  onApply: (zones: ZoneConfig[]) => void = () => {}

  constructor(host: HTMLElement) {
    const range = (id: string, label: string, min: number, max: number) => `<label class="field"><span class="field__head"><span class="field__label">${label}</span><output class="field__value" id="${id}Out"></output></span><input class="range" type="range" id="${id}" min="${min}" max="${max}" step="0.5" value="0"></label>`
    this.root = instrumentScreen(host, 'zones-app', 'METEOLAB · ЗОНЫ СРЕДЫ',
      '<span>ЗОН <b id="zoneCount">0</b></span><span id="zoneState"></span>',
      section('Зоны', `<button class="btn btn--block" id="zoneDraw" title="Щелчками по карте поставьте углы зоны, затем «Готово»">Нарисовать зону</button>
          <div class="side__row"><button class="btn" id="zoneDone" disabled>Готово</button><button class="btn" id="zoneCancel" disabled>Отмена</button></div>
          <p class="psec__hint" id="zoneHint"></p>`)
      + section('Выбранная зона', `<div id="zoneEdit">${range('zoneT', 'Температура у земли', -T_RANGE, T_RANGE)}${range('zoneQ', 'Влажность у земли (водяной пар)', -Q_RANGE, Q_RANGE)}
          <div id="zoneNumbers"></div><button class="btn btn--block" id="zoneDelete">Удалить зону</button></div><span class="t-caption" id="zoneNone">Щёлкните по зоне на карте</span>`)
      + section('Расчёт', `<button class="btn btn--block btn--primary" id="zoneApply">Применить — расчёт заново</button><button class="btn btn--block" id="zoneClear">Убрать все зоны</button>`)
      + help('Зона — участок земли со своим воздухом у земли: теплее или холоднее, влажнее или суше, чем профиль; к 1,5 км разница сходит на нет, края размыты на 2 км. Так задают то, что в природе делает погоду неоднородной: полосу влажного воздуха, сухую линию, остывшее после дождя пятно, тёплый город. Гроза, которая идёт через зоны, сама растёт там, где ей хватает тепла и влаги, и слабеет там, где нет. Зоны лежат на земле: область модели едет вместе с грозой, а зоны стоят. Модель мягко держит воздух каждой зоны (за ~15 минут), но не выше 1,5 км и не снаружи: отток грозы течёт свободно. Тёплая зона — как остров тепла: на её краях возникает ветерок, воздух сходится и поднимается — там могут зарождаться грозы. CAPE и CIN — частица от земли в зоне и в среде вокруг.'))
    this.canvas = this.root.querySelector('canvas')!; this.ctx = this.canvas.getContext('2d')!
    const $ = <T extends HTMLElement>(id: string) => this.root.querySelector<T>(`#${id}`)!
    this.root.querySelector('.ibar__close')!.addEventListener('click', () => this.toggle(false))
    $('zoneDraw').addEventListener('click', () => { this.drawing = []; this.chosen = -1; this.redraw() })
    $('zoneCancel').addEventListener('click', () => { this.drawing = null; this.redraw() })
    $('zoneDone').addEventListener('click', () => this.finish())
    $('zoneDelete').addEventListener('click', () => { if (this.chosen >= 0) { this.zones.splice(this.chosen, 1); this.chosen = -1; this.redraw() } })
    $('zoneApply').addEventListener('click', () => { this.applied = JSON.stringify(this.zones); this.onApply(this.zones.map(z => ({ ...z, points: z.points.map(p => [...p] as [number, number]) }))); this.redraw() })
    $('zoneClear').addEventListener('click', () => { this.zones = []; this.chosen = -1; this.drawing = null; this.redraw() })
    for (const [id, key] of [['zoneT', 'temperature'], ['zoneQ', 'moisture']] as const) $<HTMLInputElement>(id).addEventListener('input', e => {
      if (this.chosen < 0) return
      this.zones[this.chosen][key] = Number((e.target as HTMLInputElement).value); this.redraw()
    })
    this.canvas.addEventListener('click', e => {
      const r = this.canvas.getBoundingClientRect(), { x0, y0, scale } = this.view, x = (e.clientX - r.left - x0) / scale, y = (y0 - (e.clientY - r.top)) / scale
      const m = this.model
      if (!m || x < 0 || y < 0 || x > m.grid.width / 1000 || y > m.grid.depth / 1000) return
      if (this.drawing) { this.drawing.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]); this.redraw(); return }
      // The topmost zone under the click.
      this.chosen = -1
      for (let k = this.zones.length - 1; k >= 0; k--) if (inside(this.zones[k].points, x, y)) { this.chosen = k; break }
      this.redraw()
    })
    this.canvas.addEventListener('dblclick', () => this.finish())
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.open) { if (this.drawing) { this.drawing = null; this.redraw() } else this.toggle(false) } })
    addEventListener('resize', () => this.open && this.redraw())
  }

  /** Opens with the zones the run has (SimConfig.zones). */
  toggle(open = !this.open) {
    this.open = open; this.root.hidden = !open
    if (open && this.model) { this.zones = (this.model.config.zones ?? []).map(z => ({ ...z, points: z.points.map(p => [...p] as [number, number]) })); this.applied = JSON.stringify(this.zones); this.chosen = -1; this.drawing = null; this.redraw() }
  }

  /** Called every frame with the model the page shows. */
  refresh(model: AtmosphereModel) {
    if (model !== this.model) { this.model = model; this.drawn = '' }
    if (!this.open) return
    // The domain moves over the ground: redraw every model minute.
    const key = `${Math.floor(model.time / 60)}`
    if (key !== this.drawn) this.draw(key)
  }

  private redraw() { this.drawn = ''; if (this.model) this.refresh(this.model) }

  private finish() {
    if (!this.drawing || this.drawing.length < 3) return
    this.zones.push({ points: this.drawing, temperature: 0, moisture: 2 })
    this.chosen = this.zones.length - 1; this.drawing = null; this.redraw()
  }

  private text(id: string, html: string) { (this.root.querySelector(`#${id}`) as HTMLElement).innerHTML = html }

  private draw(key: string) {
    this.drawn = key
    const m = this.model!, c = this.canvas, host = c.parentElement!, dpr = Math.min(devicePixelRatio, 2), w = host.clientWidth, h = host.clientHeight, ctx = this.ctx
    c.style.width = `${w}px`; c.style.height = `${h}px`
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const pal = instrumentPalette(this.root)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, w, h); ctx.font = `11px ${MONO}`
    // The ground the domain started over, km; north up.
    const W = m.grid.width / 1000, D = m.grid.depth / 1000, scale = Math.min((w - 48) / W, (h - 48) / D), x0 = (w - W * scale) / 2, y0 = (h + D * scale) / 2
    this.view = { x0, y0, scale }
    const X = (x: number) => x0 + x * scale, Y = (y: number) => y0 - y * scale
    ctx.strokeStyle = pal.grid; ctx.lineWidth = 1; ctx.fillStyle = pal.label
    for (let x = 0; x <= W + 1e-6; x += 6) { ctx.beginPath(); ctx.moveTo(X(x), Y(0)); ctx.lineTo(X(x), Y(D)); ctx.stroke(); if (x % 12 === 0) ctx.fillText(`${x}`, X(x) - 6, Y(0) + 14) }
    for (let y = 0; y <= D + 1e-6; y += 6) { ctx.beginPath(); ctx.moveTo(X(0), Y(y)); ctx.lineTo(X(W), Y(y)); ctx.stroke(); if (y % 12 === 0) ctx.fillText(`${y}`, X(0) - 22, Y(y) + 4) }
    ctx.strokeStyle = pal.gridStrong; ctx.strokeRect(X(0), Y(D), W * scale, D * scale)
    // Zones: warm red, cool blue (deeper with the difference); the border green when moister, brown when drier.
    this.zones.forEach((z, k) => {
      const a = Math.min(.55, .12 + Math.abs(z.temperature) / T_RANGE * .45)
      ctx.fillStyle = z.temperature > 0 ? `rgba(230,90,60,${a})` : z.temperature < 0 ? `rgba(70,130,230,${a})` : 'rgba(160,160,160,.15)'
      ctx.strokeStyle = z.moisture > 0 ? '#4fc46a' : z.moisture < 0 ? '#c49a5a' : '#9aa5ab'; ctx.lineWidth = k === this.chosen ? 3 : 1.5
      ctx.beginPath(); z.points.forEach(([x, y], i) => i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))); ctx.closePath(); ctx.fill(); ctx.stroke()
      const cx = z.points.reduce((s, p) => s + p[0], 0) / z.points.length, cy = z.points.reduce((s, p) => s + p[1], 0) / z.points.length
      ctx.fillStyle = pal.text; ctx.fillText(`${fmt(z.temperature)}° ${fmt(z.moisture)} г/кг`, X(cx) - 40, Y(cy) + 4)
    })
    if (this.drawing) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.beginPath()
      this.drawing.forEach(([x, y], i) => i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))); ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = '#ffffff'; for (const [x, y] of this.drawing) { ctx.beginPath(); ctx.arc(X(x), Y(y), 3, 0, Math.PI * 2); ctx.fill() }
    }
    // Where the domain is now (it moves with the storm; periodic over this ground).
    if (m.time > 0) {
      const [ox, oy] = m.frameOffset(), sx = ((ox / 1000) % W + W) % W, sy = ((oy / 1000) % D + D) % D
      ctx.save(); ctx.beginPath(); ctx.rect(X(0), Y(D), W * scale, D * scale); ctx.clip()
      ctx.strokeStyle = '#ffd166'; ctx.setLineDash([6, 4])
      for (const dx of [0, -W]) for (const dy of [0, -D]) ctx.strokeRect(X(sx + dx), Y(sy + dy + D), W * scale, D * scale)
      ctx.restore(); ctx.setLineDash([])
    }
    ctx.fillStyle = pal.label
    ctx.fillText(`км · север вверху${m.time > 0 ? ' · жёлтый пунктир — где область сейчас' : ''}`, X(0), Y(D) - 8)
    this.side()
  }

  private side() {
    const m = this.model!, changed = JSON.stringify(this.zones) !== this.applied, z = this.zones[this.chosen]
    this.text('zoneCount', String(this.zones.length)); this.text('zoneState', changed ? '<b>НЕ ПРИМЕНЕНЫ</b>' : '')
    this.text('zoneHint', this.drawing ? `Углов: ${this.drawing.length}. Щёлкайте по карте; «Готово» (или двойной щелчок) замыкает зону, Esc — отмена.` : this.zones.length ? 'Щёлкните по зоне, чтобы выбрать её.' : 'Зон нет: среда одна на всю область.')
    ;(this.root.querySelector('#zoneDone') as HTMLButtonElement).disabled = !this.drawing || this.drawing.length < 3
    ;(this.root.querySelector('#zoneCancel') as HTMLButtonElement).disabled = !this.drawing
    ;(this.root.querySelector('#zoneApply') as HTMLButtonElement).disabled = !changed
    ;(this.root.querySelector('#zoneEdit') as HTMLElement).hidden = !z; (this.root.querySelector('#zoneNone') as HTMLElement).hidden = !!z
    if (!z) return
    for (const [id, v, unit] of [['zoneT', z.temperature, '°'], ['zoneQ', z.moisture, ' г/кг']] as const) {
      const input = this.root.querySelector<HTMLInputElement>(`#${id}`)!
      input.value = String(v); input.style.setProperty('--p', `${(v - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`)
      this.text(`${id}Out`, `${fmt(v)}<span class="u">${unit}</span>`)
    }
    const height = m.grid.height, base = parcelIndices(m.env, height).sb, here = parcelIndices(new Environment(m.config, m.grid, zoneProfile(m.env, z)), height).sb
    this.text('zoneNumbers', numbers([['CAPE в зоне', here.cape.toFixed(0), 'Дж/кг'], ['CIN в зоне', here.cin.toFixed(0), 'Дж/кг']])
      + `<dl class="kv">${readings([['вокруг', `CAPE ${base.cape.toFixed(0)}, CIN ${base.cin.toFixed(0)} Дж/кг`]])}</dl>`)
  }
}

/** Whether (x, y) is inside the polygon. */
function inside(points: [number, number][], x: number, y: number) {
  let r = false
  for (let a = 0, b = points.length - 1; a < points.length; b = a++) {
    const [xa, ya] = points[a], [xb, yb] = points[b]
    if ((ya > y) !== (yb > y) && x < xa + (xb - xa) * (y - ya) / (yb - ya)) r = !r
  }
  return r
}
