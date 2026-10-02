import { type AtmosphereModel, type Circulation, MESO_STRENGTH, MesocycloneDetector, PPI, RADAR_TILTS } from '../core'

type Product = 'Z' | 'V' | 'SRV' | 'CR'
type Table = [number, string][]

/** NWS reflectivity colour table: 5 dBZ bins from 5 to 75 dBZ (below 5: no echo). */
const REFLECTIVITY: Table = [[5, '#04e9e7'], [10, '#019ff4'], [15, '#0300f4'], [20, '#02fd02'], [25, '#01c501'], [30, '#008e00'], [35, '#fdf802'], [40, '#e5bc00'], [45, '#fd9500'], [50, '#fd0000'], [55, '#d40000'], [60, '#bc0000'], [65, '#f800fd'], [70, '#9854c6'], [75, '#fdfdfd']]
/** Radial velocity, m/s, 5 m/s bins from -40 to +40: inbound (towards the radar) green, outbound red, near zero grey. */
const VELOCITY: Table = [[-40, '#00ffa6'], [-35, '#00e676'], [-30, '#00c85a'], [-25, '#00a845'], [-20, '#008c37'], [-15, '#00702b'], [-10, '#005521'], [-5, '#3d4f42'], [0, '#5a4646'], [5, '#701f1f'], [10, '#8c2424'], [15, '#aa2b2b'], [20, '#c83434'], [25, '#e54242'], [30, '#ff6060'], [35, '#ffa0a0']]
const rgb = (t: Table) => t.map(([, c]) => [1, 3, 5].map(k => parseInt(c.slice(k, k + 2), 16)))
const REFLECTIVITY_RGB = rgb(REFLECTIVITY), VELOCITY_RGB = rgb(VELOCITY)
/** Raster resolution of the scan, m per pixel. */
const PIXEL = 150
/** Real time between two runs of the mesocyclone detection (all 14 tilts), ms. */
const MDA_EVERY = 2000
/** Circles of the MDA detections: dashed white-yellow for a circulation below the mesocyclone threshold, then yellow, orange, magenta. */
const MDA_COLORS = { circulation: '#f3f0b0', weak: '#ffe23d', moderate: '#ff9a1f', strong: '#ff3df2' } as const

const PRODUCTS: Record<Product, { label: string; title: string; units: string }> = {
  Z: { label: 'Z — отражаемость', title: 'Z · ОТРАЖАЕМОСТЬ', units: 'dBZ' },
  V: { label: 'V — радиальная скорость', title: 'V · СКОРОСТЬ', units: 'м/с' },
  SRV: { label: 'SRV — относительно грозы', title: 'SRV · СКОРОСТЬ ОТНОСИТЕЛЬНО ГРОЗЫ', units: 'м/с' },
  CR: { label: 'CR — составная', title: 'CR · СОСТАВНАЯ ОТРАЖАЕМОСТЬ', units: 'dBZ' },
}

/**
 * The radar display: a separate screen over the 3D view, like a Doppler radar workstation. A PPI (plan position
 * indicator) at the chosen elevation angle of reflectivity (Z) or Doppler radial velocity (V, inbound green, outbound
 * red: a mesocyclone shows as a couplet), or the composite reflectivity of the whole volume scan (CR). The beam rises
 * with range (4/3 Earth), so a higher tilt looks at higher levels. Range rings every 5 km, azimuths every 30°, a cursor
 * readout; a click moves the radar site.
 */
export class RadarPanel {
  private readonly root: HTMLDivElement; private readonly canvas: HTMLCanvasElement; private readonly ctx: CanvasRenderingContext2D
  private readonly raster: HTMLCanvasElement; private readonly rasterCtx: CanvasRenderingContext2D
  private ppi: PPI | null = null; private image: ImageData | null = null
  private lastTime = -1; private lastDraw = 0; private lastComposite = 0; private hover: { x: number; y: number } | null = null
  private product: Product = 'Z'
  /** Mesocyclone detection over the whole volume scan, rerun every MDA_EVERY ms of real time while the screen is open. */
  private detector = new MesocycloneDetector(); private detections: Circulation[] = []; private lastScan = 0; private scanTime = -1; private showMda = true; private showWeak = false
  /** Storm motion for SRV (the Bunkers right mover of the environment), m/s. */
  private motion: readonly [number, number] = [0, 0]
  open = false

  constructor(host: HTMLElement) {
    this.root = document.createElement('div'); this.root.className = 'radar-app'; this.root.hidden = true
    this.root.innerHTML = `
      <div class="radar-bar">
        <span class="radar-name">STORMLAB DOPPLER · S-BAND</span>
        <span>ПРОДУКТ <b id="radarProduct">Z · ОТРАЖАЕМОСТЬ</b></span><span>НАКЛОН <b id="radarTilt">0.5°</b></span><span>T+ <b id="radarTime">00:00</b></span>
        <button class="radar-close" title="Вернуться к 3D (Esc)">× ЗАКРЫТЬ</button>
      </div>
      <div class="radar-body">
        <div class="radar-screen"><canvas></canvas></div>
        <aside class="radar-side">
          <h3>Продукт</h3><div class="radar-products">${(Object.keys(PRODUCTS) as Product[]).map(p => `<button data-product="${p}">${PRODUCTS[p].label}</button>`).join('')}</div>
          <h3>Угол наклона</h3><div class="radar-tilts">${RADAR_TILTS.map(t => `<button data-tilt="${t}">${t.toFixed(1)}°</button>`).join('')}</div>
          <h3 id="radarUnits">dBZ</h3><div class="radar-legend" id="radarLegend"></div>
          <h3>Мезоциклоны (MDA)</h3><label class="radar-check"><input type="checkbox" id="radarMda" checked> отмечать на экране</label><label class="radar-check" title="Вращение слабее порога мезоциклона (Vrot < 12,5 м/с): на сетке ~1 км их много в любой сильной грозе"><input type="checkbox" id="radarWeak"> и слабые циркуляции</label><div class="radar-mda" id="radarMdaList">—</div>
          <h3>Курсор</h3><div class="radar-readout" id="radarReadout">—</div>
          <p class="radar-help" id="radarHelp"></p>
        </aside>
      </div>`
    host.appendChild(this.root)
    this.canvas = this.root.querySelector('canvas')!; this.ctx = this.canvas.getContext('2d')!
    this.raster = document.createElement('canvas'); this.rasterCtx = this.raster.getContext('2d')!
    this.root.querySelector<HTMLInputElement>('#radarMda')!.addEventListener('change', e => { this.showMda = (e.target as HTMLInputElement).checked; this.draw() })
    this.root.querySelector<HTMLInputElement>('#radarWeak')!.addEventListener('change', e => { this.showWeak = (e.target as HTMLInputElement).checked; this.listMda(); this.draw() })
    this.root.querySelector('.radar-close')!.addEventListener('click', () => this.toggle(false))
    this.root.querySelectorAll<HTMLButtonElement>('[data-tilt]').forEach(b => b.addEventListener('click', () => this.setTilt(Number(b.dataset.tilt))))
    this.root.querySelectorAll<HTMLButtonElement>('[data-product]').forEach(b => b.addEventListener('click', () => this.setProduct(b.dataset.product as Product)))
    this.canvas.addEventListener('mousemove', e => { this.hover = this.toGround(e); this.draw() })
    this.canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw() })
    this.canvas.addEventListener('click', e => { const g = this.toGround(e); if (!g || !this.ppi) return; this.ppi.site = g; this.ppi.layout(); this.lastComposite = 0; this.scanTime = -1; this.refresh(true) })
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.open) this.toggle(false) })
    addEventListener('resize', () => this.open && this.draw())
    this.setProduct('Z')
  }

  /** Binds the display to a (new) model, keeping the site and tilt where possible. */
  attach(model: AtmosphereModel, stormMotion: readonly [number, number]) {
    this.motion = stormMotion
    const { width, depth } = model.grid, old = this.ppi
    this.ppi = new PPI(model, Math.round(width / PIXEL), Math.round(depth / PIXEL))
    if (old) { this.ppi.site = old.site; this.ppi.tilt = old.tilt; this.ppi.layout() }
    this.raster.width = this.ppi.w; this.raster.height = this.ppi.h; this.image = this.rasterCtx.createImageData(this.ppi.w, this.ppi.h)
    this.lastTime = -1; this.lastComposite = 0; this.scanTime = -1; this.detector = new MesocycloneDetector(); this.detections = []; this.markTilt()
  }

  toggle(open = !this.open) { this.open = open; this.root.hidden = !open; if (open) this.refresh(true) }

  /** Called every frame: rescans after new model time, at most ~5 times a second (the composite, 14 tilts, once a second). */
  refresh(force = false) {
    const ppi = this.ppi
    if (!this.open || !ppi) return
    const now = performance.now(), time = ppi.model.time, every = this.product === 'CR' ? 1000 : 200
    if (!force && (time === this.lastTime || now - (this.product === 'CR' ? this.lastComposite : this.lastDraw) < every)) return
    this.lastTime = time; this.lastDraw = now
    ppi.stormMotion = this.product === 'SRV' ? this.motion : null
    if (this.product === 'CR') { ppi.composite(); this.lastComposite = now } else ppi.sample()
    // New model time (or a new radar site): rescan, at most every MDA_EVERY ms.
    if (this.scanTime < 0 || (time !== this.scanTime && now - this.lastScan >= MDA_EVERY)) { this.detections = this.detector.scan(ppi, time, this.motion); this.lastScan = now; this.scanTime = time; this.listMda() }
    this.paint(); this.draw()
    const s = Math.floor(time); (this.root.querySelector('#radarTime') as HTMLElement).textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }

  private setTilt(tilt: number) { if (!this.ppi) return; this.ppi.tilt = tilt; if (this.product === 'CR') this.setProduct('Z'); this.markTilt(); this.refresh(true) }

  private setProduct(product: Product) {
    this.product = product
    this.root.querySelectorAll<HTMLButtonElement>('[data-product]').forEach(b => b.classList.toggle('active', b.dataset.product === product))
    ;(this.root.querySelector('#radarProduct') as HTMLElement).textContent = PRODUCTS[product].title
    ;(this.root.querySelector('#radarUnits') as HTMLElement).textContent = PRODUCTS[product].units
    const velocity = product === 'V' || product === 'SRV', table = velocity ? VELOCITY : REFLECTIVITY
    ;(this.root.querySelector('#radarLegend') as HTMLElement).innerHTML = table.map(([v, c]) => `<span style="background:${c};color:${velocity && Math.abs(v) < 20 ? '#e9f0f2' : '#05080a'}">${v}</span>`).join('')
    ;(this.root.querySelector('#radarHelp') as HTMLElement).textContent = product === 'V'
      ? 'Скорость вдоль луча: зелёное — к радару, красное — от радара. Видна только там, где есть эхо. Движение самой грозы часто маскирует вращение — для мезоциклона смотрите SRV.'
      : product === 'SRV' ? `То же, но за вычетом движения грозы (по Банкерсу: ${Math.hypot(...this.motion).toFixed(0)} м/с на ${((Math.atan2(this.motion[0], this.motion[1]) * 180 / Math.PI + 360) % 360).toFixed(0)}°). Мезоциклон — пара «зелёное рядом с красным» поперёк луча на высоте 1–6 км.`
      : product === 'CR' ? 'Сильнейшее эхо по всем 14 наклонам объёмного скана над каждой точкой — как обычная радарная карта.'
        : 'Луч идёт под углом к горизонту и с дальностью поднимается выше: низкий наклон видит осадки у земли, высокий — ядро грозы и наковальню. Щелчок по экрану переносит радар.'
    this.markTilt(); this.lastComposite = 0; this.refresh(true)
  }

  private markTilt() {
    const t = this.ppi?.tilt ?? RADAR_TILTS[0], all = this.product === 'CR'
    this.root.querySelectorAll<HTMLButtonElement>('[data-tilt]').forEach(b => b.classList.toggle('active', !all && Number(b.dataset.tilt) === t))
    ;(this.root.querySelector('#radarTilt') as HTMLElement).textContent = all ? 'ВСЕ' : `${t.toFixed(1)}°`
  }

  /** The product raster into its colour table (no echo: transparent). */
  private paint() {
    const ppi = this.ppi!, data = this.image!.data, velocity = this.product === 'V' || this.product === 'SRV', values = velocity ? ppi.velocity : this.product === 'CR' ? ppi.compositeDbz : ppi.dbz
    for (let i = 0; i < values.length; i++) {
      const v = values[i], o = i * 4
      let c: number[] | null = null
      if (velocity) { if (!Number.isNaN(v)) c = VELOCITY_RGB[Math.max(0, Math.min(VELOCITY_RGB.length - 1, Math.floor((v + 40) / 5)))] }
      else if (v >= 5) c = REFLECTIVITY_RGB[Math.min(REFLECTIVITY_RGB.length - 1, Math.floor((v - 5) / 5))]
      if (!c) { data[o + 3] = 0; continue }
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255
    }
    this.rasterCtx.putImageData(this.image!, 0, 0)
  }

  /** Detections on the screen and in the list: mesocyclones, and the weaker circulations if asked for. */
  private shown() { return this.detections.filter(d => this.showWeak || d.strength !== 'circulation') }

  /**
   * The detections in the side panel, with a check against the model itself: the strongest updraft helicity (2-5 km)
   * within 5 km, which the radar cannot see but the model knows.
   */
  private listMda() {
    const ppi = this.ppi!, m = ppi.model, { nx, ny, dx, dy } = m.grid, out = this.root.querySelector('#radarMdaList') as HTMLElement
    const shown = this.shown(), hidden = this.detections.length - shown.length
    if (!shown.length) { out.innerHTML = `<span class="radar-dim">${hidden ? `мезоциклонов нет; слабых циркуляций: ${hidden}` : 'вращения не найдено'}</span>`; return }
    out.innerHTML = shown.map(d => {
      let uh = 0
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (Math.hypot(x * dx - d.x, y * dy - d.y) < 5000) uh = Math.max(uh, m.uhColumn[x + nx * y])
      const age = Math.floor((m.time - d.born) / 60)
      return `<div class="radar-meso ${d.strength}"><b>M${d.id}</b> ${MESO_STRENGTH[d.strength].name}<br>`
        + `Vrot <b>${d.vrot.toFixed(1)} м/с</b> (у основания ${d.lowVrot.toFixed(1)}) · Ø <b>${(d.diameter / 1000).toFixed(1)} км</b><br>`
        + `${(d.base / 1000).toFixed(1)}–${(d.top / 1000).toFixed(1)} км на ${d.tilts} наклонах · ${d.azimuth.toFixed(0)}°/${(d.range / 1000).toFixed(0)} км · ${age ? `${age} мин` : 'новый'}<br>`
        + (d.hook ? '<b class="radar-hook">КРЮК</b> — эхо обвивает вращение на 0,5°, вырез притока справа от движения<br>' : '')
        + `<span class="radar-dim">в модели рядом: UH ${uh.toFixed(0)} м²/с²</span></div>`
    }).join('')
  }

  /** Screen rectangle of the domain inside the canvas (aspect kept). */
  private frame() {
    const ppi = this.ppi!, box = this.canvas.parentElement!.getBoundingClientRect(), ratio = devicePixelRatio || 1
    const cw = Math.max(200, box.width), ch = Math.max(150, box.height)
    if (this.canvas.width !== Math.round(cw * ratio) || this.canvas.height !== Math.round(ch * ratio)) { this.canvas.width = Math.round(cw * ratio); this.canvas.height = Math.round(ch * ratio); this.canvas.style.width = `${cw}px`; this.canvas.style.height = `${ch}px` }
    const scale = Math.min((cw - 40) / ppi.w, (ch - 40) / ppi.h)
    return { x: (cw - ppi.w * scale) / 2, y: (ch - ppi.h * scale) / 2, scale, ratio }
  }

  private toGround(e: MouseEvent) {
    if (!this.ppi) return null
    const f = this.frame(), r = this.canvas.getBoundingClientRect(), px = (e.clientX - r.left - f.x) / f.scale, py = (e.clientY - r.top - f.y) / f.scale
    if (px < 0 || py < 0 || px >= this.ppi.w || py >= this.ppi.h) return null
    const { width, depth } = this.ppi.model.grid
    return { x: px / this.ppi.w * width, y: depth - py / this.ppi.h * depth }
  }

  private draw() {
    const ppi = this.ppi
    if (!this.open || !ppi) return
    const { width, depth } = ppi.model.grid, f = this.frame(), ctx = this.ctx
    const toScreen = (x: number, y: number) => [f.x + x / width * ppi.w * f.scale, f.y + (depth - y) / depth * ppi.h * f.scale]
    ctx.setTransform(f.ratio, 0, 0, f.ratio, 0, 0)
    ctx.fillStyle = '#05080a'; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.fillStyle = '#0b1418'; ctx.fillRect(f.x, f.y, ppi.w * f.scale, ppi.h * f.scale)
    ctx.imageSmoothingEnabled = false; ctx.drawImage(this.raster, f.x, f.y, ppi.w * f.scale, ppi.h * f.scale)
    // Range rings every 5 km, azimuth spokes every 30°, clipped to the domain.
    ctx.save(); ctx.beginPath(); ctx.rect(f.x, f.y, ppi.w * f.scale, ppi.h * f.scale); ctx.clip()
    const [sx, sy] = toScreen(ppi.site.x, ppi.site.y), kmPx = ppi.w * f.scale / (width / 1000)
    ctx.strokeStyle = 'rgba(160, 190, 200, .35)'; ctx.lineWidth = 1; ctx.font = '10px IBM Plex Mono, monospace'; ctx.fillStyle = 'rgba(180, 205, 215, .75)'
    for (let km = 5; km <= 60; km += 5) { ctx.beginPath(); ctx.arc(sx, sy, km * kmPx, 0, Math.PI * 2); ctx.stroke(); if (km % 10 === 0) ctx.fillText(`${km}`, sx + 3, sy - km * kmPx - 3) }
    ctx.strokeStyle = 'rgba(160, 190, 200, .2)'
    for (let a = 0; a < 360; a += 30) { const r = a * Math.PI / 180; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + Math.sin(r) * 80 * kmPx, sy - Math.cos(r) * 80 * kmPx); ctx.stroke() }
    ctx.restore()
    ctx.strokeStyle = '#3c5560'; ctx.strokeRect(f.x, f.y, ppi.w * f.scale, ppi.h * f.scale)
    ctx.fillStyle = '#e8f0f2'; ctx.beginPath(); ctx.arc(sx, sy, 3.5, 0, Math.PI * 2); ctx.fill()
    ctx.font = '11px IBM Plex Mono, monospace'; ctx.fillText('N ▲', f.x + ppi.w * f.scale - 34, f.y + 16)
    // MDA detections: a circle of the circulation's diameter (at least 3 km, to stay visible), coloured by strength.
    if (this.showMda) for (const d of this.shown()) {
      const [cx, cy] = toScreen(d.x, d.y), r = Math.max(1.5, d.diameter / 2000) * kmPx, color = MDA_COLORS[d.strength]
      ctx.strokeStyle = color; ctx.lineWidth = d.strength === 'circulation' ? 1.5 : 2.5; ctx.setLineDash(d.strength === 'circulation' ? [4, 3] : [])
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = color; ctx.fillText(`M${d.id}`, cx + r * .75 + 3, cy - r * .75 - 3)
      if (!d.hook) continue
      // The hook: the arc of echo wrapped around the circulation (azimuths clockwise from north; canvas angles from east).
      const h = d.hook, a0 = (h.from - 90) * Math.PI / 180, a1 = (h.from + h.span - 90) * Math.PI / 180
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.arc(cx, cy, h.radius / 1000 * kmPx, a0, a1); ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = '#ffffff'; ctx.fillText('КРЮК', cx - r * .75 - 40, cy + r * .75 + 12)
    }
    // Cursor readout.
    const out = this.root.querySelector('#radarReadout') as HTMLElement
    if (!this.hover) { out.textContent = '—'; return }
    const b = ppi.beamAt(this.hover.x, this.hover.y), px = Math.min(ppi.w - 1, Math.floor(this.hover.x / width * ppi.w)), py = Math.min(ppi.h - 1, Math.floor((depth - this.hover.y) / depth * ppi.h)), i = px + py * ppi.w
    const value = this.product === 'V' || this.product === 'SRV'
      ? (Number.isNaN(ppi.velocity[i]) ? 'нет эха' : `${ppi.velocity[i] > 0 ? '+' : ''}${ppi.velocity[i].toFixed(1)} м/с ${ppi.velocity[i] > 0 ? '(от радара)' : '(к радару)'}`)
      : (() => { const d = this.product === 'CR' ? ppi.compositeDbz[i] : ppi.dbz[i]; return d < 5 ? 'нет эха' : `${d.toFixed(0)} dBZ` })()
    out.innerHTML = `Азимут <b>${b.azimuth.toFixed(0)}°</b><br>Дальность <b>${(b.range / 1000).toFixed(1)} км</b><br>${this.product === 'CR' ? '' : `Высота луча <b>${(b.height / 1000).toFixed(2)} км</b><br>`}${this.product === 'V' || this.product === 'SRV' ? 'Скорость' : 'Отражаемость'} <b>${value}</b>`
  }
}
