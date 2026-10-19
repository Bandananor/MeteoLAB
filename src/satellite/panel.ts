import { decimal, L } from '../i18n'
import { type AtmosphereModel, overshootingTops, type OvershootingTop, satelliteImage, type SatelliteImage, sunDirection } from '../core'
import { help, instrumentPalette, instrumentScreen, numbers, press, readings, section } from '../instrument'
import { MONO } from '../theme'

type Channel = 'vis' | 'ir'
const CHANNELS: [Channel, string][] = [['vis', L('Видимый', 'Visible')], ['ir', L('ИК 10,8 мкм', 'IR 10.8 µm')]]
/**
 * The enhanced infrared scale, °C: grey from warm (dark) to -30 (light), then colours for the cold cloud tops, as the
 * forecasters' «enhanced IR» images: the colder the top, the stronger the updraught that lifted it.
 */
const IR_STOPS: [number, [number, number, number]][] = [[40, [20, 20, 20]], [-30, [225, 225, 225]], [-31, [120, 190, 235]], [-40, [40, 110, 210]], [-50, [40, 170, 80]], [-58, [235, 220, 60]], [-64, [235, 120, 40]], [-70, [200, 30, 40]], [-76, [255, 255, 255]]]
const OT_COLOR = '#ff4fd8'

function irColour(t: number): [number, number, number] {
  if (t >= IR_STOPS[0][0]) return IR_STOPS[0][1]
  for (let k = 1; k < IR_STOPS.length; k++) {
    const [a, ca] = IR_STOPS[k - 1], [b, cb] = IR_STOPS[k]
    if (t >= b) { const f = (a - t) / (a - b); return [0, 1, 2].map(j => Math.round(ca[j] + (cb[j] - ca[j]) * f)) as [number, number, number] }
  }
  return IR_STOPS[IR_STOPS.length - 1][1]
}

/**
 * The weather satellite (2.8): a separate screen like the instruments'. The domain from straight above in two channels:
 * visible (the clouds' brightness in sunlight) and the infrared window (the temperature of the cloud tops), with the
 * overshooting tops marked; a click shows a point's readings.
 */
export class SatellitePanel {
  private readonly root: HTMLDivElement; private readonly canvas: HTMLCanvasElement; private readonly ctx: CanvasRenderingContext2D
  private readonly image = document.createElement('canvas')
  private model: AtmosphereModel | null = null
  private channel: Channel = 'ir'; private drawn = ''
  private img: SatelliteImage | null = null; private tops: OvershootingTop[] = []; private sun = 0
  private picked: number | null = null
  private view = { X: (x: number) => x, Y: (y: number) => y, scale: 1 }
  open = false

  constructor(host: HTMLElement) {
    const legend = `<div class="colorbar"><div class="colorbar__bar" style="background:linear-gradient(90deg, ${IR_STOPS.map(([t, c]) => `rgb(${c.join(' ')}) ${((40 - t) / 116 * 100).toFixed(1)}%`).join(', ')})"></div><div class="colorbar__ticks">${[40, 0, -30, -50, -64, -76].map(t => `<span style="position:absolute;left:${((40 - t) / 116 * 100).toFixed(1)}%;transform:translateX(-${((40 - t) / 116 * 100).toFixed(1)}%)">${t}</span>`).join('')}</div></div>`
    this.root = instrumentScreen(host, 'satellite-app', L('METEOLAB · СПУТНИК', 'METEOLAB · SATELLITE'),
      `<span>${L('КАНАЛ', 'CHANNEL')} <b id="satChannel">—</b></span><span>${L('ХОЛОДНЕЕ ВСЕГО', 'COLDEST')} <b id="satCold">—</b></span><span id="satTime"></span>`,
      section(L('Канал', 'Channel'), `<div class="seg seg--block seg--instrument" data-seg="channel">${CHANNELS.map(([k, t]) => `<button data-value="${k}">${t}</button>`).join('')}</div><span class="t-caption" id="satNote"></span>`)
      + section(L('ИК-шкала, °C', 'IR scale, °C'), legend)
      + section(L('Сейчас', 'Now'), '<div id="satNow"></div>')
      + section(L('Точка', 'Point'), `<dl class="kv" id="satPoint"><dt>${L('щёлкните по карте', 'click the map')}</dt><dd></dd></dl>`)
      + help(L('Метеоспутник смотрит на грозу сверху. Видимый канал — солнечный свет, отражённый облаками: толстое облако (много мелких капель и кристаллов) почти белое, тонкий перистый край наковальни — полупрозрачный, ночью канал тёмный. Инфракрасный (окно 10,8 мкм) — тепловое излучение того, что видит спутник: вершины облака или земли сквозь чистый воздух; чем холоднее вершина, тем выше её поднял поток. Цветом выделены холодные вершины, как на «усиленных» ИК-снимках: синее — ниже −40 °C (наковальня), зелёное, жёлтое, красное — до −70 °C. <b style="color:#ff4fd8">OT</b> — перегревающаяся вершина (overshooting top, Bedka и др. 2010): купол над наковальней на 6,5 K и больше холоднее её, где сильный поток пробил тропопаузу, — признак опасной грозы. В модели спутник смотрит строго вниз (без параллакса и теней), каждый столбец сам по себе, водяной пар канал не ослабляет; пиксель — клетка сетки ~1 км, у настоящих спутников 0,5–2 км. Облака считаются по массе частиц: облачная вода и лёд дают яркость и холод вершины, крупные капли и крупа — почти ничего.', 'A weather satellite looks at the storm from above. The visible channel is sunlight reflected by the clouds: a thick cloud (many small droplets and crystals) is nearly white, the thin cirrus edge of the anvil translucent; at night the channel is dark. The infrared (the 10.8 µm window) is the heat radiation of what the satellite sees: the cloud top, or the ground through clear air; the colder a top, the higher the updraught lifted it. Colour marks the cold tops, as on “enhanced” IR images: blue — below −40 °C (the anvil), green, yellow, red — down to −70 °C. <b style="color:#ff4fd8">OT</b> — an overshooting top (Bedka et al. 2010): a dome over the anvil 6.5 K or more colder than it, where a strong updraught has punched through the tropopause — a sign of a dangerous storm. In the model the satellite looks straight down (no parallax, no shadows), each column on its own, water vapour does not dim the channel; a pixel is a grid cell of ~1 km, real satellites have 0.5–2 km. The clouds come from the particles’ mass: cloud water and ice make the brightness and the cold top, big drops and graupel hardly anything.')))
    this.canvas = this.root.querySelector('canvas')!; this.ctx = this.canvas.getContext('2d')!
    this.root.querySelector('.ibar__close')!.addEventListener('click', () => this.toggle(false))
    this.root.querySelector('[data-seg="channel"]')!.addEventListener('click', e => {
      const v = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.value as Channel | undefined
      if (v) { this.channel = v; this.pressAll(); this.redraw() }
    })
    this.canvas.addEventListener('click', e => {
      const m = this.model
      if (!m) return
      const r = this.canvas.getBoundingClientRect(), { X, Y, scale } = this.view, { nx, ny, dx, dy } = m.grid
      const x = Math.floor(((e.clientX - r.left) - X(0)) / scale / dx), y = Math.floor((Y(0) - (e.clientY - r.top)) / scale / dy)
      this.picked = x >= 0 && x < nx && y >= 0 && y < ny ? x + nx * y : null
      this.redraw()
    })
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.open) this.toggle(false) })
    addEventListener('resize', () => this.open && this.redraw())
    this.pressAll()
  }

  toggle(open = !this.open) { this.open = open; this.root.hidden = !open; if (open) this.redraw() }

  /** Called every frame with the model the page shows: redrawn every half model minute. */
  refresh(model: AtmosphereModel) {
    if (model !== this.model) { this.model = model; this.picked = null; this.drawn = '' }
    if (!this.open) return
    const key = `${Math.floor(model.time / 30)}`
    if (key !== this.drawn) this.draw(key)
  }

  private redraw() { this.drawn = ''; if (this.model) this.refresh(this.model) }

  private pressAll() { press(this.root.querySelectorAll<HTMLElement>('[data-seg="channel"] button'), b => b.dataset.value === this.channel) }

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
    this.view = { X, Y, scale }
    this.sun = sunDirection(m.config, m.time).y
    const img = this.img = satelliteImage(m, this.sun), tops = this.tops = overshootingTops(m, img.infrared)
    // The image: one pixel per column (row 0 north on the canvas), drawn smoothed to the map's size.
    this.image.width = nx; this.image.height = ny
    const ictx = this.image.getContext('2d')!, data = ictx.createImageData(nx, ny)
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const col = x + nx * y, o = (x + nx * (ny - 1 - y)) * 4
      const rgb = this.channel === 'ir' ? irColour(img.infrared[col]) : (v => [v, v, v])(Math.round(255 * Math.min(1, img.visible[col] / .9) ** (1 / 1.6)))
      data.data[o] = rgb[0]; data.data[o + 1] = rgb[1]; data.data[o + 2] = rgb[2]; data.data[o + 3] = 255
    }
    ictx.putImageData(data, 0, 0)
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
    // One pixel per column over the domain's box (the columns' nodes half a cell off their pixels' centres: not seen).
    ctx.drawImage(this.image, X(0), Y(D), W * scale, D * scale)
    ctx.strokeStyle = pal.gridStrong; ctx.strokeRect(X(0), Y(D), W * scale, D * scale)
    // Overshooting tops.
    ctx.strokeStyle = OT_COLOR; ctx.fillStyle = OT_COLOR; ctx.lineWidth = 2
    for (const t of tops) {
      const px = X((t.column % nx + .5) * dx), py = Y((Math.floor(t.column / nx) + .5) * dy)
      ctx.beginPath(); ctx.arc(px, py, 9, 0, Math.PI * 2); ctx.stroke(); ctx.fillText('OT', px + 11, py - 8)
    }
    if (this.picked !== null) { const px = X((this.picked % nx + .5) * dx), py = Y((Math.floor(this.picked / nx) + .5) * dy); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.strokeRect(px - 5, py - 5, 10, 10) }
    ctx.lineWidth = 1; ctx.fillStyle = pal.label
    for (let x = 0; x <= W; x += 12000) ctx.fillText(`${x / 1000}`, X(x) - 6, Y(0) + 14)
    for (let y = 0; y <= D; y += 12000) ctx.fillText(`${y / 1000}`, X(0) - 24, Y(y) + 4)
    ctx.fillText(`${L('км · север сверху', 'km · north up')}${w < 600 ? '' : L(' · область модели сейчас', ' · the model’s domain now')}`, X(0), Y(D) - 8)
    this.readouts()
  }

  private readouts() {
    const m = this.model!, img = this.img!, f1 = (v: number) => decimal(v, 1)
    let cold = Infinity, cloudy = 0, anvil = 0
    for (let c = 0; c < img.infrared.length; c++) { cold = Math.min(cold, img.infrared[c]); if (img.tau[c] > 1) cloudy++; if (img.infrared[c] < -40) anvil++ }
    const n = img.infrared.length
    this.text('satChannel', CHANNELS.find(([k]) => k === this.channel)![1])
    this.text('satCold', `${f1(cold)} °C`)
    this.text('satTime', `T+${Math.floor(m.time / 3600)}:${String(Math.floor(m.time / 60) % 60).padStart(2, '0')}`)
    this.text('satNote', this.channel === 'vis' && this.sun <= 0 ? L('Ночь: видимый канал тёмный — смотрите ИК.', 'Night: the visible channel is dark — look at the IR.') : this.channel === 'vis' && this.sun < .2 ? L('Солнце низко: изображение тусклое.', 'The sun is low: the image is dim.') : '')
    this.text('satNow', numbers([[L('облачно', 'cloudy'), String(Math.round(100 * cloudy / n)), '%'], [L('наковальня', 'anvil'), String(Math.round(100 * anvil / n)), '%']])
      + `<dl class="kv">${readings([[L('перегревающиеся вершины', 'overshooting tops'), this.tops.length ? this.tops.map(t => `${f1(t.temperature)} °C (−${f1(t.contrast)} K)`).join(', ') : L('нет', 'none')]])}</dl>`)
    if (this.picked === null) return
    const c = this.picked
    this.text('satPoint', readings([[L('ИК', 'IR'), `${f1(img.infrared[c])} °C`], [L('отражение', 'reflectance'), this.sun > 0 ? `${Math.round(100 * img.visible[c] / Math.max(this.sun, 1e-3))} %` : L('ночь', 'night')], [L('оптическая толщина', 'optical depth'), f1(img.tau[c])]]))
  }
}
