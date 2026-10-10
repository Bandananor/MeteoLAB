import { type AtmosphereModel, columnLevels, type Environment, dryAdiabat, environmentLevels, mixingRatioTemperature, moistAdiabat, type ParcelKind, type ParcelPath, parcelIndices, parcelPath, type SkewIndices, skewIndices, type SkewLevel } from '../core'

/** Pressure range of the diagram, hPa, and the temperature range along its bottom edge, °C. */
const P_BOTTOM = 1050, P_TOP = 100, T_LEFT = -40, T_RIGHT = 50
const ISOBARS = [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150, 100]
const MIXING = [1, 2, 4, 7, 10, 16, 24]
const PARCELS: Record<ParcelKind, { label: string; hint: string }> = {
  sb: { label: 'SB — от земли', hint: 'Частица от земли с температурой и влажностью приземного воздуха.' },
  ml: { label: 'ML — перемешанный слой', hint: 'Средние θ и влажность нижних 100 гПа: устойчивее к дневным колебаниям у самой земли, обычный выбор синоптика.' },
  mu: { label: 'MU — наиболее неустойчивая', hint: 'Частица с наибольшей θe в нижних 300 гПа; над холодным куполом или инверсией может стартовать выше земли.' },
}
type Probe = 'none' | 'core' | 'inflow'
/** Distance of the inflow probe from the cell centre, m. */
const INFLOW_DISTANCE = 8000

/** Which live sounding the diagram shows: its model time (s), the share of quiet columns it averages, or all of them. */
export interface LiveInfo { time: number; quiet: number; all: boolean }

/** Where the model's virtual radiosonde goes: the selected cell (centre, motion) or nothing. */
export interface ProbeCell { id: number; x: number; y: number; u: number; v: number }

/**
 * The Skew-T log-p diagram: a separate screen like the radar. Temperature falls along lines skewed 45°, pressure on a
 * log scale; dry adiabats, pseudo-adiabats and saturation mixing-ratio lines behind. The environment (temperature red,
 * dewpoint green) with wind barbs, one standard parcel (SB/ML/MU) with its CAPE and CIN shaded and LCL, LFC, EL marked,
 * and optionally a virtual radiosonde of the running model at the selected cell's core or in its inflow. The environment
 * is the live sounding (src/core/live.ts: the model now, away from the storms), the starting one faint behind it.
 */
export class SkewTPanel {
  private readonly root: HTMLDivElement; private readonly canvas: HTMLCanvasElement; private readonly ctx: CanvasRenderingContext2D
  private model: AtmosphereModel | null = null
  private env: SkewLevel[] = []; private start: SkewLevel[] = []; private live: LiveInfo = { time: 0, quiet: 1, all: false }; private parcels: Partial<Record<ParcelKind, ParcelPath>> = {}; private summary: SkewIndices | null = null; private dcape = 0
  private kind: ParcelKind = 'ml'; private probe: Probe = 'inflow'; private cell: ProbeCell | null = null
  private column: SkewLevel[] = []
  private hover: { x: number; y: number } | null = null; private lastDraw = 0; private lastTime = -1
  /** Plot rectangle in CSS pixels (set by draw). */
  private box = { left: 0, right: 0, top: 0, bottom: 0 }
  open = false

  constructor(host: HTMLElement) {
    this.root = document.createElement('div'); this.root.className = 'radar-app skewt-app'; this.root.hidden = true
    this.root.innerHTML = `
      <div class="radar-bar">
        <span class="radar-name">STORMLAB · SKEW-T LOG-P</span>
        <span>ЧАСТИЦА <b id="skewKind">ML</b></span><span>ЗОНД <b id="skewProbe">—</b></span><span>СРЕДА <b id="skewLive">ИСХОДНАЯ</b></span><span>T+ <b id="skewTime">00:00</b></span>
        <button class="radar-close" title="Вернуться к 3D (Esc)">× ЗАКРЫТЬ</button>
      </div>
      <div class="radar-body">
        <div class="radar-screen skewt-screen"><canvas></canvas></div>
        <aside class="radar-side">
          <h3>Частица</h3><div class="radar-products">${(Object.keys(PARCELS) as ParcelKind[]).map(k => `<button data-kind="${k}" title="${PARCELS[k].hint}">${PARCELS[k].label}</button>`).join('')}</div>
          <h3>Индексы частицы</h3><div class="radar-readout" id="skewParcel">—</div>
          <h3>Среда</h3><div class="radar-readout" id="skewEnv">—</div>
          <h3>Зонд в модели</h3><div class="radar-products">
            <button data-probe="inflow" title="Колонка модели в ${INFLOW_DISTANCE / 1000} км от ядра против ветра 0–1 км относительно ячейки: воздух, который ячейка сейчас вдыхает">в притоке ячейки</button>
            <button data-probe="core" title="Колонка модели в центре восходящего ядра ячейки">в ядре ячейки</button>
            <button data-probe="none">не показывать</button></div>
          <div class="radar-readout skewt-probe" id="skewProbeInfo">—</div>
          <h3>Курсор</h3><div class="radar-readout" id="skewCursor">—</div>
          <p class="radar-help">Изотермы наклонены на 45°, давление — в логарифмическом масштабе. Сплошные коричневые — сухие адиабаты, пунктирные зелёные — влажные, точечные — отношение смеси насыщения (г/кг). Красное — CAPE, синее — CIN. Ветер — флажки в м/с: полное перо 5, половина 2,5, флаг 25. Среда — живое зондирование: профиль модели сейчас, средний по столбцам без облаков, осадков и холодного купола (раз в модельную минуту); бледный пунктир — исходная среда. Зонд в модели (оранжевое и голубое) показывает, как гроза изменила воздух.</p>
        </aside>
      </div>`
    host.appendChild(this.root)
    this.canvas = this.root.querySelector('canvas')!; this.ctx = this.canvas.getContext('2d')!
    this.root.querySelector('.radar-close')!.addEventListener('click', () => this.toggle(false))
    this.root.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach(b => b.addEventListener('click', () => { this.kind = b.dataset.kind as ParcelKind; this.mark(); this.draw() }))
    this.root.querySelectorAll<HTMLButtonElement>('[data-probe]').forEach(b => b.addEventListener('click', () => { this.probe = b.dataset.probe as Probe; this.mark(); this.refresh(this.cell, true) }))
    this.canvas.addEventListener('mousemove', e => { const r = this.canvas.getBoundingClientRect(); this.hover = { x: e.clientX - r.left, y: e.clientY - r.top }; this.draw() })
    this.canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw() })
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.open) this.toggle(false) })
    addEventListener('resize', () => this.open && this.draw())
    this.mark()
  }

  /** Binds the diagram to a (new) model, starting from its starting environment. */
  attach(model: AtmosphereModel) {
    this.model = model
    this.start = environmentLevels(model.env, model.grid.height)
    this.column = []; this.lastTime = -1
    this.setLive(model.env, { time: 0, quiet: 1, all: false })
  }

  /** A new live sounding (src/core/live.ts): the environment, its parcels and indices. */
  setLive(env: Environment, info: LiveInfo) {
    const height = this.model!.grid.height
    this.live = info
    this.env = environmentLevels(env, height)
    this.parcels = { sb: parcelPath(env, height, 'sb'), ml: parcelPath(env, height, 'ml'), mu: parcelPath(env, height, 'mu') }
    this.summary = skewIndices(env, height); this.dcape = parcelIndices(env, height).dcape
    const t = Math.floor(info.time / 60), label = info.time <= 0 ? 'ИСХОДНАЯ' : `T+${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}, ${info.all ? 'ВСЯ ОБЛАСТЬ' : `${Math.round(info.quiet * 100)} % ОБЛАСТИ`}`
    ;(this.root.querySelector('#skewLive') as HTMLElement).textContent = label
    if (this.open) this.draw()
  }

  toggle(open = !this.open) { this.open = open; this.root.hidden = !open; if (open) this.refresh(this.cell, true) }

  /** Called every frame with the selected cell (or null): resamples the model column after new model time, ~2 times a second. */
  refresh(cell: ProbeCell | null, force = false) {
    this.cell = cell
    const m = this.model
    if (!this.open || !m) return
    const now = performance.now()
    if (!force && (m.time === this.lastTime || now - this.lastDraw < 500)) return
    this.lastTime = m.time
    this.sample()
    this.draw()
    const s = Math.floor(m.time); (this.root.querySelector('#skewTime') as HTMLElement).textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }

  /** The model column at the probe point (nearest node). */
  private sample() {
    const m = this.model!, cell = this.cell, info = this.root.querySelector('#skewProbeInfo') as HTMLElement, label = this.root.querySelector('#skewProbe') as HTMLElement
    this.column = []
    if (this.probe === 'none') { label.textContent = 'НЕТ'; info.textContent = 'Показана только исходная среда.'; return }
    if (!cell) { label.textContent = '—'; info.textContent = 'Выберите ячейку (щелчок по ней на 3D-виде или в списке): зонд пойдёт в её приток или ядро.'; return }
    let { x, y } = cell
    if (this.probe === 'inflow') {
      // Upstream of the 0-1 km wind relative to the cell (ground-relative environment wind minus the cell's motion).
      let su = 0, sv = 0, n = 0
      for (let z = 0; z <= 1000; z += 250) { const [u, v] = m.env.windUV(z); su += u; sv += v; n++ }
      const ru = su / n - cell.u, rv = sv / n - cell.v, speed = Math.hypot(ru, rv)
      if (speed > .5) { x -= INFLOW_DISTANCE * ru / speed; y -= INFLOW_DISTANCE * rv / speed }
    }
    const { nx, ny, dx, dy } = m.grid, i = ((Math.round(x / dx) % nx) + nx) % nx, j = ((Math.round(y / dy) % ny) + ny) % ny
    this.column = columnLevels(m, i, j)
    label.textContent = `№${cell.id} ${this.probe === 'inflow' ? 'ПРИТОК' : 'ЯДРО'}`
    const ground = this.column[0], base = this.start[0]
    info.innerHTML = `ячейка №${cell.id}, точка ${(i * dx / 1000).toFixed(1)}, ${(j * dy / 1000).toFixed(1)} км<br>у земли <b>${ground.t.toFixed(1)}°</b> / Td <b>${ground.td.toFixed(1)}°</b> (было ${base.t.toFixed(1)}° / ${base.td.toFixed(1)}°)`
  }

  private mark() {
    this.root.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach(b => b.classList.toggle('active', b.dataset.kind === this.kind))
    this.root.querySelectorAll<HTMLButtonElement>('[data-probe]').forEach(b => b.classList.toggle('active', b.dataset.probe === this.probe))
    ;(this.root.querySelector('#skewKind') as HTMLElement).textContent = this.kind.toUpperCase()
  }

  // Diagram coordinates: y from log pressure, x from temperature plus the 45° skew (one pixel right per pixel up).
  private Y(p: number) { const { top, bottom } = this.box; return top + (Math.log(p) - Math.log(P_TOP)) / (Math.log(P_BOTTOM) - Math.log(P_TOP)) * (bottom - top) }
  private X(t: number, p: number) { const { left, right, bottom } = this.box; return left + (t - T_LEFT) / (T_RIGHT - T_LEFT) * (right - left) + (bottom - this.Y(p)) }
  private P(y: number) { const { top, bottom } = this.box; return Math.exp(Math.log(P_TOP) + (y - top) / (bottom - top) * (Math.log(P_BOTTOM) - Math.log(P_TOP))) }
  private T(x: number, y: number) { const { left, right, bottom } = this.box; return T_LEFT + (x - left - (bottom - y)) / (right - left) * (T_RIGHT - T_LEFT) }

  private draw() {
    if (!this.open) return
    this.lastDraw = performance.now()
    // The canvas fills its screen area (absolutely positioned there): size it from the parent.
    const c = this.canvas, host = c.parentElement!, dpr = Math.min(devicePixelRatio, 2), w = host.clientWidth, h = host.clientHeight
    c.style.width = `${w}px`; c.style.height = `${h}px`
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const ctx = this.ctx
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#05080a'; ctx.fillRect(0, 0, w, h); ctx.font = '10px IBM Plex Mono, monospace'
    // Square-ish plot (the 45° skew needs equal scales), wind barbs to its right.
    const size = Math.max(200, Math.min(h - 50, w - 160))
    this.box = { left: 56, right: 56 + size, top: 18, bottom: 18 + size }
    const { left, right, top, bottom } = this.box, parcel = this.parcels[this.kind]
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip()
    const line = (pts: { p: number; t: number }[], color: string, width = 1, dash: number[] = []) => {
      ctx.beginPath(); pts.forEach((q, k) => { const x = this.X(q.t, q.p), y = this.Y(q.p); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y) })
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([])
    }
    const span = (from: number, to: number, f: (p: number) => number) => { const pts = []; for (let p = from; p >= to; p -= 10) pts.push({ p, t: f(p) }); return pts }
    // Background: isotherms, dry adiabats, pseudo-adiabats, mixing ratio lines.
    for (let t = -120; t <= T_RIGHT; t += 10) line([{ p: P_BOTTOM, t }, { p: P_TOP, t }], t === 0 ? '#3b6f86' : '#16262d', t === 0 ? 1.3 : 1)
    for (let th = 250; th <= 470; th += 10) line(span(P_BOTTOM, P_TOP, p => dryAdiabat(th, p)), '#3a2b20')
    for (let t0 = -16; t0 <= 36; t0 += 4) line(moistAdiabat(t0), '#1f3a26', 1, [4, 4])
    for (const r of MIXING) line(span(P_BOTTOM, 600, p => mixingRatioTemperature(r / 1000, p)), '#2b3a2f', 1, [1, 3])
    for (const p of ISOBARS) { ctx.strokeStyle = '#1d2c32'; ctx.beginPath(); ctx.moveTo(left, this.Y(p)); ctx.lineTo(right, this.Y(p)); ctx.stroke() }
    // CAPE (parcel warmer) and CIN (colder, below the LFC) between the parcel and the environment.
    if (parcel) for (let k = 0; k + 1 < parcel.path.length; k++) {
      const a = parcel.path[k], b = parcel.path[k + 1], warm = a.t > a.tEnv
      const aboveLfc = parcel.pLfc !== null && a.p <= parcel.pLfc && (parcel.pEl === null || a.p > parcel.pEl)
      const belowLfc = parcel.pLfc !== null && a.p > parcel.pLfc
      if (!(warm && aboveLfc) && !(!warm && belowLfc)) continue
      ctx.fillStyle = warm ? 'rgba(232,88,64,.32)' : 'rgba(70,130,220,.32)'
      ctx.beginPath(); ctx.moveTo(this.X(a.tEnv, a.p), this.Y(a.p)); ctx.lineTo(this.X(a.t, a.p), this.Y(a.p)); ctx.lineTo(this.X(b.t, b.p), this.Y(b.p)); ctx.lineTo(this.X(b.tEnv, b.p), this.Y(b.p)); ctx.fill()
    }
    // The model column (thinner), the environment, the parcel.
    if (this.column.length) { line(this.column.map(l => ({ p: l.p, t: l.td })), '#4fc3e6', 1.6); line(this.column.map(l => ({ p: l.p, t: l.t })), '#ffa040', 1.6) }
    if (this.live.time > 0) { line(this.start.map(l => ({ p: l.p, t: l.td })), '#3f8a55', 1.3, [4, 3]); line(this.start.map(l => ({ p: l.p, t: l.t })), '#b04a3f', 1.3, [4, 3]) }
    line(this.env.map(l => ({ p: l.p, t: l.td })), '#3ecf6a', 2.2); line(this.env.map(l => ({ p: l.p, t: l.t })), '#ff4a3d', 2.2)
    if (parcel) line(parcel.path, '#e9eef0', 1.4, [6, 4])
    ctx.restore()
    ctx.strokeStyle = '#2c444d'; ctx.lineWidth = 1; ctx.strokeRect(left + .5, top + .5, right - left, bottom - top)
    // Axes: isobar labels with the environment's height, temperatures along the bottom, mixing ratios at 600 hPa.
    ctx.fillStyle = '#6f8b94'
    for (const p of ISOBARS) {
      const z = this.heightAt(p); ctx.fillText(`${p}`, left - 34, this.Y(p) + 3)
      if (z !== null) { ctx.fillStyle = '#4b6670'; ctx.fillText(`${z.toFixed(1)}км`, left - 52, this.Y(p) + 13); ctx.fillStyle = '#6f8b94' }
    }
    for (let t = T_LEFT; t <= T_RIGHT; t += 10) ctx.fillText(`${t}°`, this.X(t, P_BOTTOM) - 8, bottom + 13)
    ctx.fillStyle = '#4f6b55'
    for (const r of MIXING) { const x = this.X(mixingRatioTemperature(r / 1000, 600), 600); if (x > left && x < right) ctx.fillText(`${r}`, x - 3, this.Y(600) - 3) }
    // Parcel levels and the 0 °C level, on the right edge.
    const marks: [string, number | null, string][] = parcel ? [['LCL', parcel.pLcl, '#6fb3c9'], ['LFC', parcel.pLfc, '#e0b450'], ['EL', parcel.pEl, '#e07a5f']] : []
    const freezing = this.summary?.freezing ?? null
    if (freezing !== null) marks.push(['0°C', this.pressureAt(freezing), '#3b9fc6'])
    for (const [name, p, color] of marks) {
      if (p === null) continue
      const y = this.Y(p); ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(right - 26, y); ctx.lineTo(right, y); ctx.stroke()
      ctx.fillStyle = color; ctx.fillText(name, right - 28 - ctx.measureText(name).width, y + 3)
    }
    this.barbs(this.env, right + 34, '#cfe0e5')
    if (this.column.length) this.barbs(this.column.filter((_, k) => k % 3 === 1), right + 84, '#ffa040')
    ctx.fillStyle = '#6f8b94'; ctx.fillText('среда', right + 22, top - 4); if (this.live.time > 0) { ctx.fillStyle = '#b04a3f'; ctx.fillText('- - исходная', left + 6, top + 12) } if (this.column.length) { ctx.fillStyle = '#ffa040'; ctx.fillText('зонд', right + 72, top - 4) }
    this.cursor(); this.side()
  }

  /** Wind barbs every 50 hPa along x: full barb 5 m/s, half 2.5, pennant 25. The staff points where the wind comes from. */
  private barbs(levels: SkewLevel[], x: number, color: string) {
    const ctx = this.ctx
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.2
    let last = Infinity
    for (const l of levels) {
      if (l.p > P_BOTTOM || l.p < P_TOP || last - l.p < 45) continue
      last = l.p
      const y = this.Y(l.p), speed = Math.hypot(l.u, l.v)
      if (speed < 1.25) { ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.stroke(); continue }
      // Unit vector towards where the wind comes from (screen y grows downwards).
      const ux = -l.u / speed, uy = l.v / speed, len = 26, tx = x + ux * len, ty = y + uy * len, px = -uy, py = ux
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tx, ty); ctx.stroke()
      let rest = Math.round(speed / 2.5) * 2.5, pos = 0
      const at = (d: number) => [tx - ux * d, ty - uy * d]
      while (rest >= 25) { const [ax, ay] = at(pos), [bx, by] = at(pos + 6); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + px * 10, ay + py * 10); ctx.lineTo(bx, by); ctx.fill(); pos += 8; rest -= 25 }
      while (rest >= 5) { const [ax, ay] = at(pos); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + px * 10 + ux * 4, ay + py * 10 + uy * 4); ctx.stroke(); pos += 4; rest -= 5 }
      if (rest >= 2.5) { const [ax, ay] = at(pos === 0 ? 4 : pos); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + px * 5 + ux * 2, ay + py * 5 + uy * 2); ctx.stroke() }
    }
  }

  /** Height (km) of pressure p (hPa) in the environment, from its levels; null outside them. */
  private heightAt(p: number) {
    const e = this.env
    for (let k = 1; k < e.length; k++) if (e[k].p <= p) { const a = e[k - 1], b = e[k], f = Math.log(a.p / p) / Math.log(a.p / b.p); return a.z + (b.z - a.z) * f }
    return null
  }

  private pressureAt(z: number) {
    const e = this.env
    for (let k = 1; k < e.length; k++) if (e[k].z >= z) { const a = e[k - 1], b = e[k], f = (z - a.z) / (b.z - a.z); return Math.exp(Math.log(a.p) + (Math.log(b.p) - Math.log(a.p)) * f) }
    return null
  }

  private cursor() {
    const out = this.root.querySelector('#skewCursor') as HTMLElement, hv = this.hover, { left, right, top, bottom } = this.box
    if (!hv || hv.x < left || hv.x > right || hv.y < top || hv.y > bottom) { out.textContent = 'наведите на диаграмму'; return }
    const p = this.P(hv.y), t = this.T(hv.x, hv.y), z = this.heightAt(p), theta = (t + 273.15) * (1000 / p) ** .2857
    const ctx = this.ctx; ctx.strokeStyle = '#2f7d86'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(left, hv.y); ctx.lineTo(right, hv.y); ctx.stroke(); ctx.setLineDash([])
    const env = this.env.find(l => l.p <= p)
    out.innerHTML = `p <b>${p.toFixed(0)} гПа</b>${z !== null ? `, z <b>${z.toFixed(2)} км</b>` : ''}<br>T <b>${t.toFixed(1)}°</b>, θ <b>${theta.toFixed(1)} K</b>` + (env ? `<br>среда: <b>${env.t.toFixed(1)}°</b> / Td <b>${env.td.toFixed(1)}°</b>, ветер <b>${Math.hypot(env.u, env.v).toFixed(0)} м/с</b>` : '')
  }

  private side() {
    const p = this.parcels[this.kind], s = this.summary
    const km = (z: number | null, pr: number | null) => z === null ? '—' : `${z.toFixed(1)} км (${pr!.toFixed(0)} гПа)`
    if (p) (this.root.querySelector('#skewParcel') as HTMLElement).innerHTML =
      `CAPE <b>${p.cape.toFixed(0)}</b> Дж/кг, CIN <b>${p.cin.toFixed(0)}</b><br>LI <b>${p.li === null ? '—' : p.li.toFixed(1)}</b> K${p.start > 0 ? `, старт <b>${p.start.toFixed(1)} км</b>` : ''}<br>LCL <b>${km(p.lcl, p.pLcl)}</b><br>LFC <b>${km(p.lfc, p.pLfc)}</b><br>EL <b>${km(p.el, p.pEl)}</b>`
    const live = this.live.time <= 0 ? 'исходная (расчёт ещё не шёл)' : this.live.all ? 'вся область: столбцов без облаков и оттока меньше 5 %' : `модель сейчас, ${Math.round(this.live.quiet * 100)} % области без облаков и оттока`
    if (s) (this.root.querySelector('#skewEnv') as HTMLElement).innerHTML =
      `<span class="skewt-probe">${live}</span><br>влагосодержание <b>${s.pw.toFixed(0)} мм</b><br>γ 0–3 км <b>${s.lapse03.toFixed(1)}</b>, 700–500 гПа <b>${s.lapse75.toFixed(1)}</b> K/км<br>0 °C <b>${s.freezing === null ? '—' : `${s.freezing.toFixed(1)} км`}</b>, DCAPE <b>${this.dcape.toFixed(0)}</b> Дж/кг<br>сдвиг 0–6 км <b>${s.shear06.toFixed(0)} м/с</b>`
  }
}
