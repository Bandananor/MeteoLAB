import { decimal, L } from '../i18n'
import { type AtmosphereModel, densityCurrentSpeed, Environment, type FrontConfig, headingVector, parcelIndices, stormMotion, type ZoneConfig, zoneProfile } from '../core'
import { help, instrumentPalette, instrumentScreen, numbers, readings, section } from '../instrument'
import { MONO } from '../theme'

/** Ranges of a zone's differences on the sliders. */
const T_RANGE = 8, Q_RANGE = 6
/** A new front of each kind (the sliders start here). */
const FRONT_DEFAULTS: Record<FrontConfig['kind'], FrontConfig> = {
  cold: { kind: 'cold', contrast: 6, depth: 1.5, slope: 80, speed: 8, heading: 90, start: -15 },
  warm: { kind: 'warm', contrast: 4, depth: 1, slope: 200, speed: 6, heading: 90, start: -5 },
}
/** The front's sliders: key, label, range, step, unit. */
const FRONT_SLIDERS: [keyof FrontConfig, string, number, number, number, string][] = [
  ['contrast', L('Контраст: насколько холоднее холодный воздух', 'Contrast: how much colder the cold air is'), 1, 12, .5, ' K'],
  ['depth', L('Глубина холодного воздуха', 'Depth of the cold air'), .3, 3, .1, L(' км', ' km')],
  ['slope', L('Наклон фронтальной поверхности, 1 : …', 'Slope of the frontal surface, 1 : …'), 30, 300, 10, ''],
  ['speed', L('Скорость фронта', 'Front speed'), 0, 20, .5, L(' м/с', ' m/s')],
  ['heading', L('Куда движется', 'Moving towards'), 0, 355, 5, '°'],
  ['start', L('Где в начале: от центра области', 'Start position: from the domain’s centre'), -40, 40, 1, L(' км', ' km')],
]
const LEFT = L('левая', 'left')
const POINTS8 = L('север северо-восток восток юго-восток юг юго-запад запад северо-запад', 'north north-east east south-east south south-west west north-west').split(' ')
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
  /** The moving front being edited (SimConfig.frontLine), or none. */
  private front: FrontConfig | null = null
  private applied = ''; private drawn = ''
  /** Map transform of the last draw: km to canvas px. */
  private view = { x0: 0, y0: 0, scale: 1 }
  open = false
  /** Called with the zones to run with (an empty list: none). */
  onApply: (zones: ZoneConfig[], front: FrontConfig | null) => void = () => {}

  constructor(host: HTMLElement) {
    const range = (id: string, label: string, min: number, max: number) => `<label class="field"><span class="field__head"><span class="field__label">${label}</span><output class="field__value" id="${id}Out"></output></span><input class="range" type="range" id="${id}" min="${min}" max="${max}" step="0.5" value="0"></label>`
    this.root = instrumentScreen(host, 'zones-app', L('METEOLAB · ЗОНЫ СРЕДЫ', 'METEOLAB · ENVIRONMENT ZONES'),
      `<span>${L('ЗОН', 'ZONES')} <b id="zoneCount">0</b></span><span id="zoneState"></span>`,
      section(L('Зоны', 'Zones'), `<button class="btn btn--block" id="zoneDraw" title="${L('Щелчками по карте поставьте углы зоны, затем «Готово»', 'Click the map to place the zone’s corners, then “Done”')}">${L('Нарисовать зону', 'Draw a zone')}</button>
          <div class="side__row"><button class="btn" id="zoneDone" disabled>${L('Готово', 'Done')}</button><button class="btn" id="zoneCancel" disabled>${L('Отмена', 'Cancel')}</button></div>
          <p class="psec__hint" id="zoneHint"></p>`)
      + section(L('Выбранная зона', 'Selected zone'), `<div id="zoneEdit">${range('zoneT', L('Температура у земли', 'Surface temperature'), -T_RANGE, T_RANGE)}${range('zoneQ', L('Влажность у земли (водяной пар)', 'Surface moisture (water vapour)'), -Q_RANGE, Q_RANGE)}
          <div id="zoneNumbers"></div><button class="btn btn--block" id="zoneDelete">${L('Удалить зону', 'Delete the zone')}</button></div><span class="t-caption" id="zoneNone">${L('Щёлкните по зоне на карте', 'Click a zone on the map')}</span>`)
      + section(L('Фронт', 'Front'), `<div class="seg seg--block seg--instrument" data-seg="frontKind"><button data-value="none">${L('Нет', 'None')}</button><button data-value="cold">${L('Холодный', 'Cold')}</button><button data-value="warm">${L('Тёплый', 'Warm')}</button></div>
          <div id="frontEdit">${FRONT_SLIDERS.map(([key, label, min, max, step]) => `<label class="field"><span class="field__head"><span class="field__label">${label}</span><output class="field__value" id="front_${key}Out"></output></span><input class="range" type="range" id="front_${key}" min="${min}" max="${max}" step="${step}"></label>`).join('')}
          <p class="psec__hint" id="frontNote"></p></div>`)
      + section(L('Расчёт', 'Run'), `<button class="btn btn--block btn--primary" id="zoneApply">${L('Применить — расчёт заново', 'Apply — restart the run')}</button><button class="btn btn--block" id="zoneClear">${L('Убрать все зоны', 'Remove all zones')}</button>`)
      + help(L('Зона — участок земли со своим воздухом у земли: теплее или холоднее, влажнее или суше, чем профиль; к 1,5 км разница сходит на нет, края размыты на 2 км. Так задают то, что в природе делает погоду неоднородной: полосу влажного воздуха, сухую линию, остывшее после дождя пятно, тёплый город. Гроза, которая идёт через зоны, сама растёт там, где ей хватает тепла и влаги, и слабеет там, где нет. Зоны лежат на земле: область модели едет вместе с грозой, а зоны стоят. Модель мягко держит воздух каждой зоны (за ~15 минут), но не выше 1,5 км и не снаружи: отток грозы течёт свободно. Тёплая зона — как остров тепла: на её краях возникает ветерок, воздух сходится и поднимается — там могут зарождаться грозы. CAPE и CIN — частица от земли в зоне и в среде вокруг. Линии на карте — куда пойдут грозы от термика (○) за 40 минут (у края земля повторяется, как сама область): суперячейка обычно уходит по красному пути (правая ячейка по Банкерсу), её левая пара — по синему, обычные грозы — по серому (средний ветер 0–6 км). Путь меняется с ветром: поправьте годограф — и он повернёт; зону ставьте на пути, минут на 30–40 впереди.', 'A zone is a patch of ground with its own near-surface air: warmer or colder, moister or drier than the profile; the difference fades out by 1.5 km, the edges are blurred over 2 km. This is how you set what makes the weather uneven in nature: a tongue of moist air, a dry line, a rain-cooled patch, a warm city. A storm passing through the zones grows where it finds enough heat and moisture and weakens where it does not. The zones lie on the ground: the model’s domain travels with the storm, the zones stay. The model gently holds each zone’s air (over ~15 minutes), but not above 1.5 km and not outside it: the storm’s outflow flows freely. A warm zone is like a heat island: a breeze rises at its edges, the air converges and lifts — storms can start there. CAPE and CIN — the surface parcel in the zone and in the environment around it. The lines on the map show where storms from the thermal (○) will go in 40 minutes (at the edge the ground repeats, like the domain itself): a supercell usually takes the red path (the Bunkers right mover), its left partner the blue one, ordinary storms the grey one (the 0–6 km mean wind). The path changes with the wind: adjust the hodograph and it turns; place a zone on the path, some 30–40 minutes ahead.')))
    this.canvas = this.root.querySelector('canvas')!; this.ctx = this.canvas.getContext('2d')!
    const $ = <T extends HTMLElement>(id: string) => this.root.querySelector<T>(`#${id}`)!
    this.root.querySelector('.ibar__close')!.addEventListener('click', () => this.toggle(false))
    $('zoneDraw').addEventListener('click', () => { this.drawing = []; this.chosen = -1; this.redraw() })
    $('zoneCancel').addEventListener('click', () => { this.drawing = null; this.redraw() })
    $('zoneDone').addEventListener('click', () => this.finish())
    $('zoneDelete').addEventListener('click', () => { if (this.chosen >= 0) { this.zones.splice(this.chosen, 1); this.chosen = -1; this.redraw() } })
    $('zoneApply').addEventListener('click', () => { this.applied = this.key(); this.onApply(this.zones.map(z => ({ ...z, points: z.points.map(p => [...p] as [number, number]) })), this.front && { ...this.front }); this.redraw() })
    this.root.querySelector('[data-seg="frontKind"]')!.addEventListener('click', e => {
      const v = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.value
      if (!v) return
      this.front = v === 'none' ? null : this.front?.kind === v ? this.front : { ...FRONT_DEFAULTS[v as FrontConfig['kind']] }
      this.redraw()
    })
    for (const [key] of FRONT_SLIDERS) $<HTMLInputElement>(`front_${key}`).addEventListener('input', e => { if (this.front) { (this.front as unknown as Record<string, number>)[key] = Number((e.target as HTMLInputElement).value); this.redraw() } })
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
    if (open && this.model) { this.zones = (this.model.config.zones ?? []).map(z => ({ ...z, points: z.points.map(p => [...p] as [number, number]) })); this.front = this.model.config.frontLine ? { ...this.model.config.frontLine } : null; this.applied = this.key(); this.chosen = -1; this.drawing = null; this.redraw() }
  }

  /** Called every frame with the model the page shows. */
  refresh(model: AtmosphereModel) {
    if (model !== this.model) { this.model = model; this.drawn = '' }
    if (!this.open) return
    // The domain moves over the ground: redraw every model minute.
    const key = `${Math.floor(model.time / 60)}`
    if (key !== this.drawn) this.draw(key)
  }

  /** What is set, to see whether it was applied. */
  private key() { return JSON.stringify({ zones: this.zones, front: this.front }) }

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
      ctx.fillStyle = pal.text; ctx.fillText(`${fmt(z.temperature)}° ${fmt(z.moisture)} ${L('г/кг', 'g/kg')}`, X(cx) - 40, Y(cy) + 4)
    })
    if (this.drawing) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.beginPath()
      this.drawing.forEach(([x, y], i) => i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))); ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = '#ffffff'; for (const [x, y] of this.drawing) { ctx.beginPath(); ctx.arc(X(x), Y(y), 3, 0, Math.PI * 2); ctx.fill() }
    }
    // Where storms will go in 40 minutes (from the starting thermal, ground-relative Bunkers motion of the environment):
    // lines broken at the edge and continued on the other side (the ground repeats, as the domain), ticks every 10 min.
    const motion = stormMotion(m.env), start = m.config.profile === 'weisman-klemp' ? [W * .3, D * .5] : [W * .38, D * .45]
    const tracks: [string, readonly [number, number], string][] = [[L('правая', 'right'), motion.rightMover, '#ff6b6b'], [LEFT, motion.leftMover, '#6ba8ff'], [L('средний ветер', 'mean wind'), motion.meanWind, '#c9d1d5']]
    const wrap = (x: number, size: number) => (x % size + size) % size
    for (const [name, [u, v], color] of tracks) {
      ctx.strokeStyle = ctx.fillStyle = color; ctx.lineWidth = 2
      let px = start[0], py = start[1]
      ctx.beginPath(); ctx.moveTo(X(px), Y(py))
      for (let t = 1; t <= 40; t++) {
        const x = wrap(start[0] + u * t * .06, W), y = wrap(start[1] + v * t * .06, D)
        if (Math.abs(x - px) > W / 2 || Math.abs(y - py) > D / 2) { ctx.stroke(); ctx.beginPath(); ctx.moveTo(X(x), Y(y)) } else ctx.lineTo(X(x), Y(y))
        px = x; py = y
        if (t % 10 === 0) {
          ctx.stroke(); ctx.beginPath(); ctx.arc(X(x), Y(y), t === 40 ? 4 : 3, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.moveTo(X(x), Y(y))
          // The left mover's labels under its dots: the two movers' tracks often end close together.
          if (t % 20 === 0) ctx.fillText(`${t}′${t === 40 ? ' ' + name : ''}`, X(x) + 7, Y(y) + (name === LEFT ? 15 : -7))
        }
      }
      ctx.stroke()
    }
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X(start[0]), Y(start[1]), 6, 0, Math.PI * 2); ctx.stroke()
    if (this.front) this.drawFront(X, Y, W, D)
    // Where the domain is now (it moves with the storm; periodic over this ground).
    if (m.time > 0) {
      const [ox, oy] = m.frameOffset(), sx = ((ox / 1000) % W + W) % W, sy = ((oy / 1000) % D + D) % D
      ctx.save(); ctx.beginPath(); ctx.rect(X(0), Y(D), W * scale, D * scale); ctx.clip()
      ctx.strokeStyle = '#ffd166'; ctx.setLineDash([6, 4])
      for (const dx of [0, -W]) for (const dy of [0, -D]) ctx.strokeRect(X(sx + dx), Y(sy + dy + D), W * scale, D * scale)
      ctx.restore(); ctx.setLineDash([])
    }
    ctx.fillStyle = pal.label
    ctx.fillText(L('км · север вверху · ○ термик, линии — путь гроз за 40 мин (метки каждые 10 мин; правая и левая ячейки по Банкерсу, средний ветер)', 'km · north up · ○ thermal, lines — the storms’ paths over 40 min (marks every 10 min; Bunkers right and left movers, mean wind)') + (m.time > 0 ? L(' · жёлтый пунктир — где область сейчас', ' · yellow dashes — where the domain is now') : ''), X(0), Y(D) - 8)
    this.side()
  }

  /** The front's controls: the kind pressed, the sliders, the note with the cold air's own speed. */
  private sideFront() {
    const f = this.front
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-seg="frontKind"] button')) b.setAttribute('aria-pressed', String(b.dataset.value === (f?.kind ?? 'none')))
    ;(this.root.querySelector('#frontEdit') as HTMLElement).hidden = !f
    if (!f) return
    for (const [key, , min, max, , unit] of FRONT_SLIDERS) {
      const v = f[key] as number, input = this.root.querySelector<HTMLInputElement>(`#front_${key}`)!
      input.value = String(v); input.style.setProperty('--p', `${(v - min) / (max - min) * 100}%`)
      this.text(`front_${key}Out`, key === 'heading' ? `${v}° — ${L('на', 'towards')} ${compass(v)}` : key === 'slope' ? `1 : ${v}` : `${decimal(v, String(v).split('.')[1]?.length ?? 0).replace('-', '−')}<span class="u">${unit}</span>`)
    }
    const own = densityCurrentSpeed(f)
    this.text('frontNote', f.kind === 'cold'
      ? L(`Холодный воздух такой глубины и контраста сам шёл бы со скоростью ~${own.toFixed(0)} м/с (плотностное течение); заданная скорость поддерживается крупномасштабным «подталкиванием». У земли — крутая голова фронта: на ней поднимается тёплый воздух и прорывается задерживающий слой.`, `Cold air of this depth and contrast would move at ~${own.toFixed(0)} m/s by itself (a density current); the set speed is kept by a large-scale “push”. At the ground the front has a steep head: the warm air rises over it and breaks through the cap.`)
      : L(`Тёплый воздух натекает на клин холодного и поднимается по нему; клин пологий: на 100 км он поднимается на ${(100 / f.slope).toFixed(1).replace('.', ',')} км. Грозы — над холодным слоем (приподнятая конвекция).`, `The warm air flows onto the cold wedge and rises along it; the wedge is gentle: over 100 km it rises ${(100 / f.slope).toFixed(1)} km. Storms form above the cold layer (elevated convection).`))
  }

  /** The front on the map: now (solid, with its symbols, the cold air shaded) and in 20 and 40 minutes (dashed). */
  private drawFront(X: (x: number) => number, Y: (y: number) => number, W: number, D: number) {
    const f = this.front!, ctx = this.ctx, [nx, ny] = headingVector(f.heading), color = f.kind === 'cold' ? '#4f8fe0' : '#e0574f', L = 300
    const at = (minutes: number) => { const d = f.start + f.speed * minutes * .06; return [W / 2 + nx * d, D / 2 + ny * d] as const }
    ctx.save(); ctx.beginPath(); ctx.rect(X(0), Y(D), X(W) - X(0), Y(0) - Y(D)); ctx.clip()
    const [px, py] = at(0), side = f.kind === 'cold' ? -1 : 1
    // The cold air's side, shaded.
    ctx.fillStyle = 'rgba(80,140,230,.12)'; ctx.beginPath()
    ctx.moveTo(X(px + ny * L), Y(py - nx * L)); ctx.lineTo(X(px - ny * L), Y(py + nx * L))
    ctx.lineTo(X(px - ny * L + side * nx * L), Y(py + nx * L + side * ny * L)); ctx.lineTo(X(px + ny * L + side * nx * L), Y(py - nx * L + side * ny * L)); ctx.fill()
    for (const minutes of [40, 20, 0]) {
      const [cx, cy] = at(minutes)
      ctx.strokeStyle = color; ctx.lineWidth = minutes ? 1.5 : 3; ctx.setLineDash(minutes ? [6, 5] : [])
      ctx.beginPath(); ctx.moveTo(X(cx + ny * L), Y(cy - nx * L)); ctx.lineTo(X(cx - ny * L), Y(cy + nx * L)); ctx.stroke()
      if (minutes) { ctx.fillStyle = color; ctx.fillText(`${minutes}′`, X(cx) + 6, Y(cy) - 6); continue }
      // Symbols every 4 km along the line, on the side it moves to: triangles for a cold front, semicircles for a warm one.
      ctx.setLineDash([]); ctx.fillStyle = color
      for (let k = -L; k <= L; k += 4) {
        const sx = cx + ny * k, sy = cy - nx * k, size = 1.1
        ctx.beginPath()
        if (f.kind === 'cold') { ctx.moveTo(X(sx + ny * size), Y(sy - nx * size)); ctx.lineTo(X(sx - ny * size), Y(sy + nx * size)); ctx.lineTo(X(sx + nx * size * 1.2), Y(sy + ny * size * 1.2)); ctx.fill() }
        else { const a = Math.atan2(-(ny), nx); ctx.arc(X(sx), Y(sy), size * Math.abs(X(1) - X(0)), a - Math.PI / 2, a + Math.PI / 2); ctx.fill() }
      }
    }
    ctx.restore(); ctx.setLineDash([])
  }

  private side() {
    const m = this.model!, changed = this.key() !== this.applied, z = this.zones[this.chosen]
    this.sideFront()
    this.text('zoneCount', String(this.zones.length)); this.text('zoneState', changed ? `<b>${L('НЕ ПРИМЕНЕНЫ', 'NOT APPLIED')}</b>` : '')
    this.text('zoneHint', this.drawing ? L(`Углов: ${this.drawing.length}. Щёлкайте по карте; «Готово» (или двойной щелчок) замыкает зону, Esc — отмена.`, `Corners: ${this.drawing.length}. Click the map; “Done” (or a double click) closes the zone, Esc — cancel.`) : this.zones.length ? L('Щёлкните по зоне, чтобы выбрать её.', 'Click a zone to select it.') : L('Зон нет: среда одна на всю область.', 'No zones: one environment over the whole domain.'))
    ;(this.root.querySelector('#zoneDone') as HTMLButtonElement).disabled = !this.drawing || this.drawing.length < 3
    ;(this.root.querySelector('#zoneCancel') as HTMLButtonElement).disabled = !this.drawing
    ;(this.root.querySelector('#zoneApply') as HTMLButtonElement).disabled = !changed
    ;(this.root.querySelector('#zoneEdit') as HTMLElement).hidden = !z; (this.root.querySelector('#zoneNone') as HTMLElement).hidden = !!z
    if (!z) return
    for (const [id, v, unit] of [['zoneT', z.temperature, '°'], ['zoneQ', z.moisture, L(' г/кг', ' g/kg')]] as const) {
      const input = this.root.querySelector<HTMLInputElement>(`#${id}`)!
      input.value = String(v); input.style.setProperty('--p', `${(v - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`)
      this.text(`${id}Out`, `${fmt(v)}<span class="u">${unit}</span>`)
    }
    const height = m.grid.height, base = parcelIndices(m.env, height).sb, here = parcelIndices(new Environment(m.config, m.grid, zoneProfile(m.env, z)), height).sb
    this.text('zoneNumbers', numbers([[L('CAPE в зоне', 'CAPE in the zone'), here.cape.toFixed(0), L('Дж/кг', 'J/kg')], [L('CIN в зоне', 'CIN in the zone'), here.cin.toFixed(0), L('Дж/кг', 'J/kg')]])
      + `<dl class="kv">${readings([[L('вокруг', 'around'), `CAPE ${base.cape.toFixed(0)}, CIN ${base.cin.toFixed(0)} ${L('Дж/кг', 'J/kg')}`]])}</dl>`)
  }
}

/** The 8-point compass word of a heading. */
const compass = (heading: number) => POINTS8[Math.round(((heading % 360) + 360) % 360 / 45) % 8]

/** Whether (x, y) is inside the polygon. */
function inside(points: [number, number][], x: number, y: number) {
  let r = false
  for (let a = 0, b = points.length - 1; a < points.length; b = a++) {
    const [xa, ya] = points[a], [xb, yb] = points[b]
    if ((ya > y) !== (yb > y) && x < xa + (xb - xa) * (y - ya) / (yb - ya)) r = !r
  }
  return r
}
