import { type AtmosphereModel, beamHeight, type Circulation, DBZ_FLOOR, DUAL_MIN_DBZ, MESO_STRENGTH, type MesoStrength, MesocycloneDetector, PPI, RADAR_TILTS } from '../core'
import { help, instrumentPalette, instrumentScreen, press, readings, section } from '../instrument'
import { download } from '../share'
import { MONO } from '../theme'
import { cssGradient, extent, KINDS, lookup, lutIndex, type Palette, type PaletteKind, Palettes, parsePal, type RGB, type Stop, ticks, toPal } from './palettes'

type Product = 'Z' | 'V' | 'SRV' | 'CR' | 'ZDR' | 'RHO' | 'KDP' | 'RHI'
/** What the RHI shows. */
type RhiField = 'Z' | 'SRV' | 'ZDR' | 'RHO' | 'KDP'
/** Raster resolution of the scan, m per pixel. */
const PIXEL = 150
/** The vertical section (RHI): gate and row spacing, m, and the highest level shown. */
const RHI_STEP = 250, RHI_DZ = 250, RHI_TOP = 18_000
/** Real time between two runs of the mesocyclone detection (all 14 tilts), ms. */
const MDA_EVERY = 2000
/** Shortest signed periodic difference. */
const wrap = (d: number, size: number) => d - size * Math.round(d / size)

const PRODUCTS: Record<Product, { label: string; title: string; kind: PaletteKind }> = {
  Z: { label: 'Z — отражаемость', title: 'Z · ОТРАЖАЕМОСТЬ', kind: 'Z' },
  V: { label: 'V — радиальная скорость', title: 'V · СКОРОСТЬ', kind: 'V' },
  SRV: { label: 'SRV — относительно грозы', title: 'SRV · СКОРОСТЬ ОТНОСИТЕЛЬНО ГРОЗЫ', kind: 'V' },
  CR: { label: 'CR — составная', title: 'CR · СОСТАВНАЯ ОТРАЖАЕМОСТЬ', kind: 'Z' },
  ZDR: { label: 'ZDR — дифференциальная отражаемость', title: 'ZDR · ДИФФ. ОТРАЖАЕМОСТЬ', kind: 'ZDR' },
  RHO: { label: 'ρhv (RHO, CC) — коэффициент корреляции', title: 'ρhv · КОРРЕЛЯЦИЯ', kind: 'RHO' },
  KDP: { label: 'KDP — удельная дифференциальная фаза', title: 'KDP · ДИФФ. ФАЗА', kind: 'KDP' },
  RHI: { label: 'RHI — вертикальный разрез', title: 'RHI · ВЕРТИКАЛЬНЫЙ РАЗРЕЗ', kind: 'Z' },
}
const RHI_FIELDS: Record<RhiField, { name: string; kind: PaletteKind }> = {
  Z: { name: 'отражаемость', kind: 'Z' }, SRV: { name: 'скорость относительно грозы', kind: 'V' }, ZDR: { name: 'ZDR', kind: 'ZDR' }, RHO: { name: 'ρhv', kind: 'RHO' }, KDP: { name: 'KDP', kind: 'KDP' },
}
const DUAL_NOTE = `Порог эха — ${DUAL_MIN_DBZ} dBZ. Оценка по средним размерам частиц: микрофизика модели одномоментная (размер следует только из массы), поэтому сортировка капель по размеру — дуга ZDR у переднего края суперячейки — почти не видна; точнее станет с двухмоментной схемой.`
const HELP: Record<Product, string> = {
  Z: 'Луч идёт под углом к горизонту и с дальностью поднимается выше: низкий наклон видит осадки у земли, высокий — ядро грозы и наковальню. Щелчок по экрану переносит радар.',
  V: 'Скорость вдоль луча: зелёное — к радару, красное — от радара. Видна только там, где есть эхо. Движение самой грозы часто маскирует вращение — для мезоциклона смотрите SRV.',
  SRV: '',
  CR: 'Сильнейшее эхо по всем 14 наклонам объёмного скана над каждой точкой — как обычная радарная карта.',
  ZDR: `Дифференциальная отражаемость: насколько эхо в горизонтальной поляризации сильнее, чем в вертикальной. Крупные капли сплюснуты — ZDR +1…+4 дБ; град и крупа кувыркаются и почти круглые — около 0; сухой снег — 0…+0,5. Колонна ZDR — капли, вынесенные потоком выше 0 °C (высокие наклоны и RHI): признак сильного потока, раньше роста отражаемости. Высокая Z при ZDR около 0 — ядро града. ${DUAL_NOTE}`,
  RHO: `Коэффициент корреляции ρhv: насколько одинаково эхо в двух поляризациях. Чистый дождь или снег — 0,97–1; смесь разных частиц — ниже: полоса таяния (снег и крупа тают в дождь) — около 0,9, град с дождём — 0,85–0,95. Обломки смерча (TDS, ρhv < 0,8) модель не показывает: вихрь мельче её сетки. ${DUAL_NOTE}`,
  KDP: `Удельная дифференциальная фаза, °/км: насколько горизонтальная волна отстаёт от вертикальной в дожде. Растёт с количеством воды и почти не замечает града, поэтому по KDP находят сильный ливень внутри ядра града. Здесь — только от дождя. ${DUAL_NOTE}`,
  RHI: 'Вертикальный разрез от радара вдоль азимута по всему объёму: видно, как высоко поднимается эхо, свод слабого эха (BWER) над восходящим потоком, нависающее эхо, ядро града, наковальню, колонну ZDR. Тонкие линии — лучи 14 наклонов: так их видит настоящий радар. По вертикали масштаб растянут.',
}

/** Range rings, azimuth radials and their labels: steps (0: off), compass points instead of degrees. */
interface GridSettings { radials: number; rings: number; labels: boolean; compass: boolean }
const GRID_STORE = 'meteolab-radar-grid', GRID_DEFAULT: GridSettings = { radials: 30, rings: 5, labels: true, compass: false }
const RADIAL_STEPS = [0, 10, 30, 45], RING_STEPS = [0, 5, 10, 25]
const POINTS = ['С', 'ССВ', 'СВ', 'ВСВ', 'В', 'ВЮВ', 'ЮВ', 'ЮЮВ', 'Ю', 'ЮЮЗ', 'ЮЗ', 'ЗЮЗ', 'З', 'ЗСЗ', 'СЗ', 'ССЗ']
/** The compass point (of 16) of an azimuth. */
const point = (azimuth: number) => POINTS[Math.round(((azimuth % 360) + 360) % 360 / 22.5) % 16]
function loadGrid(): GridSettings {
  try {
    const g = JSON.parse(localStorage.getItem(GRID_STORE) ?? 'null')
    if (g && RADIAL_STEPS.includes(g.radials) && RING_STEPS.includes(g.rings)) return { radials: g.radials, rings: g.rings, labels: g.labels !== false, compass: g.compass === true }
  } catch { /* default */ }
  return { ...GRID_DEFAULT }
}

const toHex = (c: RGB | null | undefined) => c ? `#${c.map(x => x.toString(16).padStart(2, '0')).join('')}` : '#000000'
const fromHex = (h: string): RGB => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16)) as unknown as RGB
const fmt = (v: number, digits: number) => (v > 0 && digits === 0 && v % 1 === 0 ? String(v) : v.toFixed(digits)).replace('-', '−')

/**
 * The radar display: a separate screen over the 3D view, like a Doppler radar workstation. A PPI (plan position
 * indicator) at the chosen elevation angle of reflectivity (Z) or Doppler radial velocity (V, inbound green, outbound
 * red: a mesocyclone shows as a couplet), the composite reflectivity of the whole volume scan (CR), the dual-polarisation
 * products (ZDR, rho_hv, KDP; core/polarimetry.ts) or a vertical section (RHI). The beam rises with range (4/3 Earth),
 * so a higher tilt looks at higher levels. Range rings, azimuth radials and their labels as chosen, a cursor readout; a
 * click moves the radar site. Every kind of product has its palette: built-in ones, the user's own (an editor) and
 * imported .pal files (radar/palettes.ts).
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
  /** The RHI: its azimuth (degrees from north), what it shows, its raster. */
  private rhiAzimuth = 90; private rhiField: RhiField = 'Z'
  private readonly rhiRaster: HTMLCanvasElement; private readonly rhiCtx: CanvasRenderingContext2D
  private rhi: { dbz: Float32Array; velocity: Float32Array; zdr: Float32Array; rho: Float32Array; kdp: Float32Array; gates: number; rows: number } | null = null
  private grid = loadGrid()
  private readonly palettes = new Palettes()
  /** The colour lookup of the shown kind's chosen palette. */
  private lut = new Uint8ClampedArray(0); private lutFor: Palette | null = null
  /** The palette being edited (a copy) and the stop rows of the editor. */
  private editing: { id?: string; name: string; kind: PaletteKind; stops: Stop[] } | null = null
  private deleteArmed = 0
  open = false

  constructor(host: HTMLElement) {
    const strengths = (Object.keys(MESO_STRENGTH) as MesoStrength[]).map((s, i, all) => `<div class="mda--${s}"><i></i><span>${['Циркуляция', 'Слабый', 'Умеренный', 'Сильный'][i]}</span><span class="num">${i ? `≥ ${MESO_STRENGTH[s].vrot}` : `< ${MESO_STRENGTH[all[1]].vrot}`} м/с</span></div>`).join('')
    const seg = (name: string, options: [string, string][]) => `<div class="seg seg--block seg--instrument" data-seg="${name}">${options.map(([v, t]) => `<button data-value="${v}">${t}</button>`).join('')}</div>`
    this.root = instrumentScreen(host, 'radar-app', 'METEOLAB DOPPLER · S-BAND',
      '<span>ПРОДУКТ <b id="radarProduct">Z · ОТРАЖАЕМОСТЬ</b></span><span>НАКЛОН <b id="radarTilt">0.5°</b></span><span>T+ <b id="radarTime">00:00</b></span>',
      section('Продукт', `<div class="tilts tilts--4">${(Object.keys(PRODUCTS) as Product[]).map(p => `<button data-product="${p}" title="${PRODUCTS[p].label}">${p}</button>`).join('')}</div>
        <div class="stat" style="border:0;padding:0"><span id="radarProductLabel"></span><span class="unit" id="radarUnits">dBZ</span></div>`)
      + section('Угол наклона', `<div class="tilts">${RADAR_TILTS.map(t => `<button data-tilt="${t}">${t.toFixed(1)}°</button>`).join('')}</div>`)
      + section('Шкала и палитра', `<div class="colorbar"><div class="colorbar__bar" id="radarLegend"></div><div class="colorbar__ticks" id="radarTicks"></div></div>
        <div class="field"><span class="field__label" id="paletteLabel">Палитра</span><span class="select"><select id="paletteSelect"></select></span></div>
        <div class="radar-buttons"><button class="btn btn--xs" id="paletteEdit" title="Редактор палитры: точки «значение → цвет», плавно или ступенями">Изменить</button><button class="btn btn--xs" id="paletteImport" title="Файл .pal радарных программ (строки Color: / SolidColor:)">Импорт .pal</button><button class="btn btn--xs" id="paletteExport">Экспорт .pal</button><button class="btn btn--xs" id="paletteDelete" hidden>Удалить</button></div>
        <input type="file" id="paletteFile" accept=".pal,.txt,text/plain" hidden>
        <span class="t-caption" id="paletteNote"></span>`)
      + section('Сетка', `<span class="label">Радиалы</span>${seg('radials', RADIAL_STEPS.map(s => [String(s), s ? `${s}°` : 'нет']))}
        <span class="label">Кольца дальности</span>${seg('rings', RING_STEPS.map(s => [String(s), s ? `${s} км` : 'нет']))}
        <label class="check"><input type="checkbox" id="gridLabels"> Подписи азимутов и дальностей</label>
        <span class="label">Азимуты</span>${seg('compass', [['0', 'градусы'], ['1', 'румбы']])}`)
      + section('Разрез RHI', `<label class="field"><span class="field__head"><span class="field__label">Азимут</span><output class="field__value" id="rhiAzOut">90°</output></span><input class="range" type="range" id="rhiAz" min="0" max="359" step="1" value="90"></label>
        <button class="btn btn--block" id="rhiStrongest" title="Повернуть разрез к самому сильному эху объёмного скана">Через самое сильное эхо</button>
        <span class="label">Поле разреза</span>${seg('rhi', (Object.keys(RHI_FIELDS) as RhiField[]).map(f => [f, f]))}
        <span class="t-caption">Shift + щелчок по карте — разрез через эту точку</span>`)
      + section('Мезоциклоны (MDA)', `<label class="check"><input type="checkbox" id="radarMda" checked> Отмечать на экране</label>
        <label class="check" title="Вращение слабее порога мезоциклона (Vrot < 12,5 м/с): на сетке ~1 км их много в любой сильной грозе"><input type="checkbox" id="radarWeak"> И слабые циркуляции</label>
        <div class="mda-list" id="radarMdaList"></div>
        <div class="mda-legend"><span class="label">Метки силы · Vrot</span>${strengths}</div>`)
      + section('Курсор', '<dl class="kv" id="radarReadout"></dl>')
      + help('', 'radarHelp'))
    this.root.insertAdjacentHTML('beforeend', `<dialog class="modal modal--wide pal-editor" id="paletteEditor"><form method="dialog" style="display:contents">
      <h2 class="modal__title">Палитра · <span id="palKind"></span></h2>
      <label class="field"><span class="label">Название</span><input class="input" id="palName" autocomplete="off" spellcheck="false"></label>
      <div class="colorbar"><div class="colorbar__bar" id="palPreview"></div><div class="colorbar__ticks" id="palPreviewTicks"></div></div>
      <div class="pal-head"><span class="label">Значение (<span id="palUnits"></span>)</span><span class="label">Цвет</span><span class="label">Дальше</span><span></span></div>
      <div class="pal-rows" id="palRows"></div>
      <div class="radar-buttons"><button type="button" class="btn btn--xs" id="palAdd">+ точка</button><button type="button" class="btn btn--xs" id="palSmooth">Все плавно</button><button type="button" class="btn btn--xs" id="palSteps">Все ступенями</button></div>
      <p class="modal__text">Каждая точка красит значения от себя до следующей: плавно — переходом к цвету следующей точки, ступенью — одним цветом, «пусто» — ничего не рисует. <span id="palBelow"></span></p>
      <div class="modal__actions"><button class="btn btn--quiet" value="cancel">Отмена</button><button class="btn btn--primary" value="save">Сохранить</button></div>
    </form></dialog>`)
    this.canvas = this.root.querySelector('canvas')!; this.ctx = this.canvas.getContext('2d')!
    this.raster = document.createElement('canvas'); this.rasterCtx = this.raster.getContext('2d')!
    this.rhiRaster = document.createElement('canvas'); this.rhiCtx = this.rhiRaster.getContext('2d')!
    const $ = <T extends Element = HTMLElement>(s: string) => this.root.querySelector<T>(s)!
    const az = $<HTMLInputElement>('#rhiAz')
    az.addEventListener('input', () => this.setAzimuth(Number(az.value)))
    $('#rhiStrongest').addEventListener('click', () => this.aimAtStrongest())
    $<HTMLInputElement>('#radarMda').addEventListener('change', e => { this.showMda = (e.target as HTMLInputElement).checked; this.draw() })
    $<HTMLInputElement>('#radarWeak').addEventListener('change', e => { this.showWeak = (e.target as HTMLInputElement).checked; this.listMda(); this.draw() })
    $('.ibar__close').addEventListener('click', () => this.toggle(false))
    this.root.querySelectorAll<HTMLButtonElement>('[data-tilt]').forEach(b => b.addEventListener('click', () => this.setTilt(Number(b.dataset.tilt))))
    this.root.querySelectorAll<HTMLButtonElement>('[data-product]').forEach(b => b.addEventListener('click', () => this.setProduct(b.dataset.product as Product)))
    // The segmented choices: grid steps, degrees or compass points, the RHI's field.
    this.root.querySelectorAll<HTMLElement>('[data-seg]').forEach(s => s.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]')
      if (!b) return
      const v = b.dataset.value!
      if (s.dataset.seg === 'rhi') { this.rhiField = v as RhiField; this.setProduct('RHI'); return }
      if (s.dataset.seg === 'radials') this.grid.radials = Number(v)
      else if (s.dataset.seg === 'rings') this.grid.rings = Number(v)
      else this.grid.compass = v === '1'
      this.saveGrid()
    }))
    $<HTMLInputElement>('#gridLabels').addEventListener('change', e => { this.grid.labels = (e.target as HTMLInputElement).checked; this.saveGrid() })
    // Palettes.
    $<HTMLSelectElement>('#paletteSelect').addEventListener('change', e => { this.palettes.choose(this.kind(), (e.target as HTMLSelectElement).value); this.showPalette() })
    $('#paletteEdit').addEventListener('click', () => this.edit())
    $('#paletteExport').addEventListener('click', () => { const p = this.palettes.chosen(this.kind()); download(`${p.name.replace(/[\\/:*?"<>|]+/g, '_')}.pal`, toPal(p), 'text/plain') })
    $('#paletteImport').addEventListener('click', () => $<HTMLInputElement>('#paletteFile').click())
    $<HTMLInputElement>('#paletteFile').addEventListener('change', e => this.importPal(e.target as HTMLInputElement))
    $('#paletteDelete').addEventListener('click', () => this.deletePalette())
    const editor = $<HTMLDialogElement>('#paletteEditor')
    editor.addEventListener('close', () => { if (editor.returnValue === 'save') this.saveEdited(); this.editing = null })
    $('#palAdd').addEventListener('click', () => { const e = this.editing!, last = e.stops[e.stops.length - 1]; e.stops.push({ value: last ? last.value + (KINDS[e.kind].digits ? .5 : 5) : 0, color: last?.color ?? [128, 128, 128], solid: last?.solid }); this.editorRows() })
    $('#palSmooth').addEventListener('click', () => { this.editing!.stops.forEach(s => { s.solid = false }); this.editorRows() })
    $('#palSteps').addEventListener('click', () => { this.editing!.stops.forEach(s => { s.solid = true }); this.editorRows() })
    $('#palRows').addEventListener('input', e => this.editRow(e.target as HTMLElement, false))
    $('#palRows').addEventListener('change', e => this.editRow(e.target as HTMLElement, true))
    $('#palRows').addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]'); if (b && this.editing!.stops.length > 1) { this.editing!.stops.splice(Number(b.dataset.remove), 1); this.editorRows() } })
    this.canvas.addEventListener('mousemove', e => { this.hover = this.product === 'RHI' ? this.toSection(e) : this.toGround(e); this.draw() })
    this.canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw() })
    this.canvas.addEventListener('click', e => {
      if (this.product === 'RHI') return
      const g = this.toGround(e); if (!g || !this.ppi) return
      if (e.shiftKey) { this.setAzimuth(this.ppi.beamAt(g.x, g.y).azimuth); this.setProduct('RHI'); return }
      this.ppi.site = g; this.ppi.layout(); this.lastComposite = 0; this.scanTime = -1; this.refresh(true)
    })
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.open && !editor.open) this.toggle(false) })
    addEventListener('resize', () => this.open && this.draw())
    this.showGrid()
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

  /** The kind of values on screen now (which palette applies). */
  private kind(): PaletteKind { return this.product === 'RHI' ? RHI_FIELDS[this.rhiField].kind : PRODUCTS[this.product].kind }
  private dual() { const k = this.kind(); return k === 'ZDR' || k === 'RHO' || k === 'KDP' }

  /** Called every frame: rescans after new model time, at most ~5 times a second (the composite, 14 tilts, once a second). */
  refresh(force = false) {
    const ppi = this.ppi
    if (!this.open || !ppi) return
    const now = performance.now(), time = ppi.model.time, every = this.product === 'CR' ? 1000 : 200
    if (!force && (time === this.lastTime || now - (this.product === 'CR' ? this.lastComposite : this.lastDraw) < every)) return
    this.lastTime = time; this.lastDraw = now
    ppi.stormMotion = this.product === 'SRV' || (this.product === 'RHI' && this.rhiField === 'SRV') ? this.motion : null
    ppi.dual = this.dual()
    if (this.product === 'RHI') {
      const { width, depth, height } = ppi.model.grid, gates = Math.ceil(Math.hypot(width, depth) / 2 / RHI_STEP), rows = Math.ceil(Math.min(height, RHI_TOP) / RHI_DZ)
      ppi.prepare(); this.rhi = { ...ppi.section(this.rhiAzimuth, RHI_STEP, gates, RHI_DZ, rows), gates, rows }
    } else if (this.product === 'CR') { ppi.composite(); this.lastComposite = now } else ppi.sample()
    // New model time (or a new radar site): rescan, at most every MDA_EVERY ms. The detection's prepare() leaves the
    // dual-polarisation nodes as they are (it needs only Z and V).
    if (this.scanTime < 0 || (time !== this.scanTime && now - this.lastScan >= MDA_EVERY)) { ppi.dual = false; this.detections = this.detector.scan(ppi, time, this.motion); this.lastScan = now; this.scanTime = time; this.listMda() }
    this.paint(); this.draw()
    const s = Math.floor(time); this.root.querySelector<HTMLElement>('#radarTime')!.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }

  private setAzimuth(azimuth: number) {
    this.rhiAzimuth = Math.round((azimuth % 360 + 360) % 360) % 360
    this.root.querySelector<HTMLInputElement>('#rhiAz')!.value = String(this.rhiAzimuth)
    this.root.querySelector<HTMLElement>('#rhiAzOut')!.textContent = `${this.rhiAzimuth}°`
    this.markTilt(); this.refresh(true)
  }

  /** Turns the RHI towards the strongest echo of the volume scan. */
  private aimAtStrongest() {
    const ppi = this.ppi
    if (!ppi) return
    ppi.composite()
    let best = 0
    for (let i = 1; i < ppi.compositeDbz.length; i++) if (ppi.compositeDbz[i] > ppi.compositeDbz[best]) best = i
    const g = ppi.ground(best % ppi.w, Math.floor(best / ppi.w))
    this.setAzimuth(ppi.beamAt(g.x, g.y).azimuth); this.setProduct('RHI')
  }

  private setTilt(tilt: number) { if (!this.ppi) return; this.ppi.tilt = tilt; if (this.product === 'CR') this.setProduct('Z'); this.markTilt(); this.refresh(true) }

  private setProduct(product: Product) {
    this.product = product
    press(this.root.querySelectorAll<HTMLButtonElement>('[data-product]'), b => b.dataset.product === product)
    press(this.root.querySelectorAll<HTMLButtonElement>('[data-seg="rhi"] button'), b => b.dataset.value === this.rhiField)
    this.root.querySelector<HTMLElement>('#radarProduct')!.textContent = product === 'RHI' && this.rhiField !== 'Z' ? `RHI · ${this.rhiField}` : PRODUCTS[product].title
    this.root.querySelector<HTMLElement>('#radarProductLabel')!.textContent = PRODUCTS[product].label
    this.root.querySelector<HTMLElement>('#radarHelp')!.textContent = product === 'SRV'
      ? `То же, что V, но за вычетом движения грозы (по Банкерсу: ${Math.hypot(...this.motion).toFixed(0)} м/с на ${((Math.atan2(this.motion[0], this.motion[1]) * 180 / Math.PI + 360) % 360).toFixed(0)}°). Мезоциклон — пара «зелёное рядом с красным» поперёк луча на высоте 1–6 км.`
      : product === 'RHI' && this.rhiField !== 'Z' && this.rhiField !== 'SRV' ? `${HELP.RHI} ${HELP[this.rhiField]}` : HELP[product]
    this.showPalette()
    this.markTilt(); this.lastComposite = 0; this.refresh(true)
  }

  /** The chosen palette of the kind on screen: its lookup, colour bar, ticks and the palette list. */
  private showPalette() {
    const kind = this.kind(), k = KINDS[kind], palette = this.palettes.chosen(kind)
    if (palette !== this.lutFor) { this.lut = lookup(palette); this.lutFor = palette }
    this.root.querySelector<HTMLElement>('#radarUnits')!.textContent = k.units
    this.root.querySelector<HTMLElement>('#paletteLabel')!.textContent = `Палитра · ${k.label}`
    const range = extent(palette)
    this.root.querySelector<HTMLElement>('#radarLegend')!.style.background = cssGradient(palette, range)
    const values = ticks(range), at = (v: number) => (v - range[0]) / (range[1] - range[0]) * 100
    this.root.querySelector<HTMLElement>('#radarTicks')!.innerHTML = values.map(v => `<span style="position:absolute;left:${at(v)}%;transform:translateX(-${at(v)}%)">${fmt(v, k.digits)}</span>`).join('')
    const select = this.root.querySelector<HTMLSelectElement>('#paletteSelect')!, all = this.palettes.all(kind)
    const options = (list: Palette[]) => list.map(p => `<option value="${p.id}">${p.name.replace(/[<>&"]/g, c => `&#${c.charCodeAt(0)};`)}</option>`).join('')
    const own = all.filter(p => !p.builtin)
    select.innerHTML = `<optgroup label="Готовые">${options(all.filter(p => p.builtin))}</optgroup>${own.length ? `<optgroup label="Свои">${options(own)}</optgroup>` : ''}`
    select.value = palette.id
    const del = this.root.querySelector<HTMLButtonElement>('#paletteDelete')!
    del.hidden = !!palette.builtin; del.textContent = 'Удалить'; this.deleteArmed = 0
    this.paint(); this.draw()
  }

  private markTilt() {
    const t = this.ppi?.tilt ?? RADAR_TILTS[0], all = this.product === 'CR' || this.product === 'RHI'
    press(this.root.querySelectorAll<HTMLButtonElement>('[data-tilt]'), b => !all && Number(b.dataset.tilt) === t)
    this.root.querySelector<HTMLElement>('#radarTilt')!.textContent = this.product === 'RHI' ? `АЗИМУТ ${this.rhiAzimuth}°` : all ? 'ВСЕ' : `${t.toFixed(1)}°`
  }

  private showGrid() {
    const g = this.grid
    press(this.root.querySelectorAll<HTMLButtonElement>('[data-seg="radials"] button'), b => Number(b.dataset.value) === g.radials)
    press(this.root.querySelectorAll<HTMLButtonElement>('[data-seg="rings"] button'), b => Number(b.dataset.value) === g.rings)
    press(this.root.querySelectorAll<HTMLButtonElement>('[data-seg="compass"] button'), b => (b.dataset.value === '1') === g.compass)
    this.root.querySelector<HTMLInputElement>('#gridLabels')!.checked = g.labels
  }

  private saveGrid() { try { localStorage.setItem(GRID_STORE, JSON.stringify(this.grid)) } catch { /* not kept */ } this.showGrid(); this.draw() }

  /** The values of the product on screen (PPI raster or RHI section). */
  private values(): Float32Array | null {
    if (this.product === 'RHI') { const s = this.rhi; return s ? { Z: s.dbz, SRV: s.velocity, ZDR: s.zdr, RHO: s.rho, KDP: s.kdp }[this.rhiField] : null }
    const ppi = this.ppi
    if (!ppi) return null
    return { Z: ppi.dbz, V: ppi.velocity, SRV: ppi.velocity, CR: ppi.compositeDbz, ZDR: ppi.zdr, RHO: ppi.rho, KDP: ppi.kdp }[this.product]
  }

  /** Colours `values` into `data` (RGBA, pixel i at offset of(i)) through the palette; reflectivity at the noise floor stays empty. */
  private colour(values: Float32Array, data: Uint8ClampedArray, of: (i: number) => number) {
    const kind = this.kind(), lut = this.lut, floor = kind === 'Z'
    for (let i = 0; i < values.length; i++) {
      const v = values[i], o = of(i), k = floor && v <= DBZ_FLOOR + 1 ? -1 : lutIndex(kind, v)
      if (k < 0) { data[o + 3] = 0; continue }
      data[o] = lut[k * 4]; data[o + 1] = lut[k * 4 + 1]; data[o + 2] = lut[k * 4 + 2]; data[o + 3] = lut[k * 4 + 3]
    }
  }

  /** The product raster in its palette (no echo: transparent). */
  private paint() {
    if (!this.ppi || !this.image) return
    if (this.product === 'RHI') { this.paintRhi(); return }
    const values = this.values()
    if (!values) return
    this.colour(values, this.image.data, i => i * 4)
    this.rasterCtx.putImageData(this.image, 0, 0)
  }

  /** The RHI raster: gates across, rows from the top of the section down. */
  private paintRhi() {
    const s = this.rhi, values = this.values()
    if (!s || !values) return
    if (this.rhiRaster.width !== s.gates || this.rhiRaster.height !== s.rows) { this.rhiRaster.width = s.gates; this.rhiRaster.height = s.rows }
    const image = this.rhiCtx.createImageData(s.gates, s.rows)
    this.colour(values, image.data, i => ((s.rows - 1 - Math.floor(i / s.gates)) * s.gates + i % s.gates) * 4)
    this.rhiCtx.putImageData(image, 0, 0)
  }

  /** The RHI plot rectangle in CSS pixels. */
  private sectionBox() {
    const box = this.canvas.parentElement!.getBoundingClientRect(), ratio = devicePixelRatio || 1, cw = Math.max(200, box.width), ch = Math.max(150, box.height)
    if (this.canvas.width !== Math.round(cw * ratio) || this.canvas.height !== Math.round(ch * ratio)) { this.canvas.width = Math.round(cw * ratio); this.canvas.height = Math.round(ch * ratio); this.canvas.style.width = `${cw}px`; this.canvas.style.height = `${ch}px` }
    return { left: 56, top: 20, right: cw - 24, bottom: ch - 36, ratio }
  }

  private toSection(e: MouseEvent) {
    const s = this.rhi
    if (!s) return null
    const b = this.sectionBox(), r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top
    if (x < b.left || x > b.right || y < b.top || y > b.bottom) return null
    return { x: (x - b.left) / (b.right - b.left) * s.gates * RHI_STEP, y: (b.bottom - y) / (b.bottom - b.top) * s.rows * RHI_DZ }
  }

  /** A value of the kind on screen for the cursor readout. */
  private describe(v: number, inbound = '') {
    const kind = this.kind()
    if (Number.isNaN(v) || (kind === 'Z' && v < 5)) return 'нет эха'
    if (kind === 'Z') return `${v.toFixed(0)} dBZ`
    if (kind === 'V') return `${v > 0 ? '+' : ''}${v.toFixed(1)} м/с${inbound && ` ${v > 0 ? '(от радара)' : '(к радару)'}`}`
    if (kind === 'ZDR') return `${v > 0 ? '+' : ''}${v.toFixed(2)} дБ`
    if (kind === 'RHO') return v.toFixed(3)
    return `${v.toFixed(2)} °/км`
  }

  private drawSection() {
    const s = this.rhi, ctx = this.ctx, b = this.sectionBox()
    ctx.setTransform(b.ratio, 0, 0, b.ratio, 0, 0)
    const pal = instrumentPalette(this.root)
    ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    if (!s) return
    const range = s.gates * RHI_STEP, top = s.rows * RHI_DZ, X = (r: number) => b.left + r / range * (b.right - b.left), Y = (h: number) => b.bottom - h / top * (b.bottom - b.top)
    ctx.fillStyle = pal.bar; ctx.fillRect(b.left, b.top, b.right - b.left, b.bottom - b.top)
    ctx.imageSmoothingEnabled = false; ctx.drawImage(this.rhiRaster, b.left, b.top, b.right - b.left, b.bottom - b.top)
    ctx.font = `11px ${MONO}`; ctx.lineWidth = 1
    // Grid: range every 5 km, height every 2 km; the beams of the volume scan.
    ctx.strokeStyle = pal.grid; ctx.fillStyle = pal.label
    for (let km = 0; km * 1000 <= range; km += 5) { ctx.beginPath(); ctx.moveTo(X(km * 1000), b.top); ctx.lineTo(X(km * 1000), b.bottom); ctx.stroke(); ctx.fillText(`${km}`, X(km * 1000) - 4, b.bottom + 14) }
    for (let km = 0; km * 1000 <= top; km += 2) { ctx.beginPath(); ctx.moveTo(b.left, Y(km * 1000)); ctx.lineTo(b.right, Y(km * 1000)); ctx.stroke(); ctx.fillText(`${km}`, b.left - 22, Y(km * 1000) + 3) }
    ctx.fillText('дальность, км', b.right - 90, b.bottom + 28); ctx.save(); ctx.translate(14, b.top + 70); ctx.rotate(-Math.PI / 2); ctx.fillText('высота, км', 0, 0); ctx.restore()
    ctx.save(); ctx.beginPath(); ctx.rect(b.left, b.top, b.right - b.left, b.bottom - b.top); ctx.clip()
    ctx.strokeStyle = 'rgba(232, 240, 242, .22)'
    for (const tilt of RADAR_TILTS) { ctx.beginPath(); for (let r = 0; r <= range; r += 500) { const x = X(r), y = Y(beamHeight(r, tilt)); if (r) ctx.lineTo(x, y); else ctx.moveTo(x, y) } ctx.stroke() }
    ctx.restore()
    ctx.strokeStyle = pal.gridStrong; ctx.strokeRect(b.left, b.top, b.right - b.left, b.bottom - b.top)
    ctx.fillStyle = pal.label; ctx.fillText(`азимут ${this.rhiAzimuth}° · ${RHI_FIELDS[this.rhiField].name} · масштаб по вертикали ×${((range / (b.right - b.left)) / (top / (b.bottom - b.top))).toFixed(1)}`, b.left + 6, b.top + 14)
    const out = this.root.querySelector<HTMLElement>('#radarReadout')!, hv = this.hover, values = this.values()
    if (!hv || !values) { out.innerHTML = readings([['курсор', 'вне разреза']]); return }
    const g = Math.min(s.gates - 1, Math.floor(hv.x / RHI_STEP)), k = Math.min(s.rows - 1, Math.floor(hv.y / RHI_DZ)), i = k * s.gates + g
    ctx.strokeStyle = '#2f7d86'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(X(hv.x), b.top); ctx.lineTo(X(hv.x), b.bottom); ctx.moveTo(b.left, Y(hv.y)); ctx.lineTo(b.right, Y(hv.y)); ctx.stroke(); ctx.setLineDash([])
    out.innerHTML = readings([['Дальность', `${(hv.x / 1000).toFixed(1)} км`], ['Высота', `${(hv.y / 1000).toFixed(2)} км`], ['Отражаемость', s.dbz[i] < 5 ? 'нет эха' : `${s.dbz[i].toFixed(0)} dBZ`], ...(this.rhiField === 'Z' ? [] : [[this.rhiField === 'SRV' ? 'Скорость' : this.rhiField, this.describe(values[i])] as [string, string]])])
  }

  /** Detections on the screen and in the list: mesocyclones, and the weaker circulations if asked for. */
  private shown() { return this.detections.filter(d => this.showWeak || d.strength !== 'circulation') }

  /**
   * The detections in the side panel, with a check against the model itself: the strongest updraft helicity (2-5 km)
   * within 5 km, which the radar cannot see but the model knows.
   */
  private listMda() {
    const ppi = this.ppi!, m = ppi.model, { nx, ny, dx, dy, width, depth } = m.grid, [ox, oy] = m.frameOffset(), out = this.root.querySelector<HTMLElement>('#radarMdaList')!
    const shown = this.shown(), hidden = this.detections.length - shown.length
    if (!shown.length) { out.innerHTML = `<span class="t-caption">${hidden ? `мезоциклонов нет; слабых циркуляций: ${hidden}` : 'вращения не найдено'}</span>`; return }
    out.innerHTML = shown.map(d => {
      let uh = 0
      // Model columns over the ground point (the domain may have moved; distances are periodic).
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (Math.hypot(wrap(x * dx + ox - d.x, width), wrap(y * dy + oy - d.y, depth)) < 5000) uh = Math.max(uh, m.uhColumn[x + nx * y])
      const age = Math.floor((m.time - d.born) / 60)
      return `<div class="mda mda--${d.strength}"><div class="mda__head"><span class="mda__id">M${d.id}</span><span class="mda__name">${MESO_STRENGTH[d.strength].name}</span></div>`
        + `<dl class="kv">${readings([['Vrot', `${d.vrot.toFixed(1)} м/с · у основания ${d.lowVrot.toFixed(1)}`], ['Ø', `${(d.diameter / 1000).toFixed(1)} км`], ['слой', `${(d.base / 1000).toFixed(1)}–${(d.top / 1000).toFixed(1)} км · ${d.tilts} наклонов`], ['где', `${this.azimuthText(d.azimuth)} / ${(d.range / 1000).toFixed(0)} км · ${age ? `${age} мин` : 'новый'}`]])}</dl>`
        + (d.hook ? '<div class="mda__hook"><b>КРЮК</b> — эхо обвивает вращение на 0,5°, вырез притока справа от движения</div>' : '')
        + `<div class="mda__model">в модели рядом: UH ${uh.toFixed(0)} м²/с²</div></div>`
    }).join('')
  }

  private azimuthText(azimuth: number) { return `${azimuth.toFixed(0)}°${this.grid.compass ? ` (${point(azimuth)})` : ''}` }

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

  /**
   * Range rings and azimuth radials from the site (clipped to the domain), with their labels: the ranges along the
   * bearing to the farthest corner (where most rings are seen), the azimuths at the domain's edge.
   */
  private drawGrid(sx: number, sy: number, kmPx: number, box: { x: number; y: number; w: number; h: number }) {
    const ctx = this.ctx, pal = instrumentPalette(this.root), g = this.grid
    const far = Math.max(...[[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]].map(([x, y]) => Math.hypot(x - sx, y - sy)))
    const label = (text: string, x: number, y: number) => { ctx.strokeText(text, x, y); ctx.fillText(text, x, y) }
    ctx.lineWidth = 1; ctx.font = `11px ${MONO}`
    if (g.rings) { ctx.strokeStyle = pal.gridStrong; for (let km = g.rings; km * kmPx <= far; km += g.rings) { ctx.beginPath(); ctx.arc(sx, sy, km * kmPx, 0, Math.PI * 2); ctx.stroke() } }
    if (g.radials) for (let a = 0; a < 360; a += g.radials) {
      const r = a * Math.PI / 180
      ctx.strokeStyle = a % 90 === 0 ? pal.gridStrong : pal.grid
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + Math.sin(r) * far, sy - Math.cos(r) * far); ctx.stroke()
    }
    if (!g.labels) return
    ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.strokeStyle = pal.bg; ctx.fillStyle = pal.label
    if (g.rings) {
      // Ring labels along the bearing to the farthest corner, every ring (every other one if they are close).
      const corner = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]].reduce((a, b) => Math.hypot(b[0] - sx, b[1] - sy) > Math.hypot(a[0] - sx, a[1] - sy) ? b : a)
      const ux = (corner[0] - sx) / Math.hypot(corner[0] - sx, corner[1] - sy), uy = (corner[1] - sy) / Math.hypot(corner[0] - sx, corner[1] - sy), every = g.rings * kmPx < 28 ? 2 : 1
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      for (let n = every, km = g.rings * n; km * kmPx <= far - 10; n += every, km = g.rings * n) label(`${km}`, sx + ux * km * kmPx + uy * 9, sy + uy * km * kmPx - ux * 9)
    }
    // Azimuth labels where the radials meet the domain's edge (inset): every radial, or the 16 / 8 compass points.
    const step = g.compass ? (g.radials && g.radials < 30 ? 22.5 : 45) : g.radials || 30, pad = 14
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    for (let a = 0; a < 360 - 1e-9; a += step) {
      const r = a * Math.PI / 180, dx = Math.sin(r), dy = -Math.cos(r)
      const tx = dx > 1e-9 ? (box.x + box.w - pad - sx) / dx : dx < -1e-9 ? (box.x + pad - sx) / dx : Infinity
      const ty = dy > 1e-9 ? (box.y + box.h - pad - sy) / dy : dy < -1e-9 ? (box.y + pad - sy) / dy : Infinity, t = Math.min(tx, ty)
      if (t < 30) continue
      label(g.compass ? point(a) : `${Math.round(a)}°`, sx + dx * t, sy + dy * t)
    }
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic'; ctx.lineWidth = 1
  }

  private draw() {
    const ppi = this.ppi
    if (!this.open || !ppi) return
    if (this.product === 'RHI') { this.drawSection(); return }
    const { width, depth } = ppi.model.grid, f = this.frame(), ctx = this.ctx
    const toScreen = (x: number, y: number) => [f.x + x / width * ppi.w * f.scale, f.y + (depth - y) / depth * ppi.h * f.scale]
    ctx.setTransform(f.ratio, 0, 0, f.ratio, 0, 0)
    const pal = instrumentPalette(this.root), box = { x: f.x, y: f.y, w: ppi.w * f.scale, h: ppi.h * f.scale }
    ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.fillStyle = pal.bar; ctx.fillRect(box.x, box.y, box.w, box.h)
    ctx.imageSmoothingEnabled = false; ctx.drawImage(this.raster, box.x, box.y, box.w, box.h)
    ctx.save(); ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip()
    const [sx, sy] = toScreen(ppi.site.x, ppi.site.y), kmPx = box.w / (width / 1000)
    this.drawGrid(sx, sy, kmPx, box)
    // The line of the RHI section.
    const az = this.rhiAzimuth * Math.PI / 180, far = Math.hypot(box.w, box.h)
    ctx.strokeStyle = 'rgba(255, 255, 255, .45)'; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + Math.sin(az) * far, sy - Math.cos(az) * far); ctx.stroke(); ctx.setLineDash([])
    ctx.restore()
    ctx.strokeStyle = pal.gridStrong; ctx.strokeRect(box.x, box.y, box.w, box.h)
    ctx.fillStyle = '#e8f0f2'; ctx.beginPath(); ctx.arc(sx, sy, 3.5, 0, Math.PI * 2); ctx.fill()
    ctx.font = `11px ${MONO}`
    if (!this.grid.labels) ctx.fillText('N ▲', box.x + box.w - 34, box.y + 16)
    // MDA detections: a circle of the circulation's diameter (at least 3 km, to stay visible), coloured by strength.
    if (this.showMda) for (const d of this.shown()) {
      const [cx, cy] = toScreen(d.x, d.y), r = Math.max(1.5, d.diameter / 2000) * kmPx, color = pal.meso[d.strength]
      ctx.strokeStyle = color; ctx.lineWidth = d.strength === 'circulation' ? 1.5 : 2.5; ctx.setLineDash(d.strength === 'circulation' ? [4, 3] : [])
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = color; ctx.fillText(`M${d.id}`, cx + r * .75 + 3, cy - r * .75 - 3)
      if (!d.hook) continue
      // The hook: the arc of echo wrapped around the circulation (azimuths clockwise from north; canvas angles from east).
      const h = d.hook, a0 = (h.from - 90) * Math.PI / 180, a1 = (h.from + h.span - 90) * Math.PI / 180
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.arc(cx, cy, h.radius / 1000 * kmPx, a0, a1); ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = '#ffffff'; ctx.fillText('КРЮК', cx - r * .75 - 40, cy + r * .75 + 12)
    }
    ctx.lineWidth = 1
    // Cursor readout.
    const out = this.root.querySelector<HTMLElement>('#radarReadout')!, values = this.values()
    if (!this.hover || !values) { out.innerHTML = readings([['курсор', 'вне экрана']]); return }
    const b = ppi.beamAt(this.hover.x, this.hover.y), px = Math.min(ppi.w - 1, Math.floor(this.hover.x / width * ppi.w)), py = Math.min(ppi.h - 1, Math.floor((depth - this.hover.y) / depth * ppi.h)), i = px + py * ppi.w
    const kind = this.kind(), name = { Z: 'Отражаемость', V: 'Скорость', ZDR: 'ZDR', RHO: 'ρhv', KDP: 'KDP' }[kind]
    out.innerHTML = readings([['Азимут', this.azimuthText(b.azimuth)], ['Дальность', `${(b.range / 1000).toFixed(1)} км`], ...(this.product === 'CR' ? [] : [['Высота луча', `${(b.height / 1000).toFixed(2)} км`] as [string, string]]),
      ...(kind === 'Z' ? [] : [['Отражаемость', ppi.dbz[i] < 5 ? 'нет эха' : `${ppi.dbz[i].toFixed(0)} dBZ`] as [string, string]]), [name, this.describe(values[i], 'in')]])
  }

  // ---- The palette editor: a copy of the chosen palette as rows "value · colour · what follows", previewed live.

  private edit() {
    const p = this.palettes.chosen(this.kind())
    this.editing = { id: p.builtin ? undefined : p.id, name: p.builtin ? `${p.name} — своя` : p.name, kind: p.kind, stops: p.stops.map(s => ({ ...s })) }
    const $ = <T extends Element = HTMLElement>(s: string) => this.root.querySelector<T>(s)!
    $('#palKind').textContent = KINDS[p.kind].label; $('#palUnits').textContent = KINDS[p.kind].units || 'без единиц'
    $('#palBelow').textContent = KINDS[p.kind].clampBelow ? 'Скорость ниже первой точки — цветом первой.' : 'Ниже первой точки эха не видно.'
    $<HTMLInputElement>('#palName').value = this.editing.name
    this.editorRows()
    $<HTMLDialogElement>('#paletteEditor').showModal()
  }

  private editorRows() {
    const e = this.editing!, step = KINDS[e.kind].digits ? 10 ** -KINDS[e.kind].digits : 1
    e.stops.sort((a, b) => a.value - b.value)
    this.root.querySelector<HTMLElement>('#palRows')!.innerHTML = e.stops.map((s, i) => `<div class="pal-row" data-row="${i}">
      <input class="input" type="number" step="${step}" value="${s.value}" data-field="value" aria-label="Значение">
      <input class="pal-color" type="color" value="${toHex(s.color)}" data-field="color" aria-label="Цвет"${s.color ? '' : ' disabled'}>
      <span class="select"><select data-field="mode" aria-label="Что дальше"><option value="smooth"${!s.solid && s.color ? ' selected' : ''}>плавно</option><option value="solid"${s.solid && s.color ? ' selected' : ''}>ступень</option><option value="none"${s.color ? '' : ' selected'}>пусто</option></select></span>
      <button type="button" class="btn btn--quiet btn--xs" data-remove="${i}" title="Убрать точку">×</button></div>`).join('')
    this.editorPreview()
  }

  /** An edit in a row; `final` (a change, not typing) re-sorts the rows by value. */
  private editRow(target: HTMLElement, final: boolean) {
    const row = target.closest<HTMLElement>('[data-row]'), e = this.editing
    if (!row || !e) return
    const s = e.stops[Number(row.dataset.row)], field = target.dataset.field, value = (target as HTMLInputElement).value
    if (field === 'value') { const v = Number(value); if (value !== '' && Number.isFinite(v)) s.value = v; if (final) { this.editorRows(); return } }
    else if (field === 'color') { s.color = fromHex(value); if (s.to) s.to = undefined }
    else if (field === 'mode') { if (value === 'none') s.color = null; else { s.color ??= [128, 128, 128]; s.solid = value === 'solid' } this.editorRows(); return }
    this.editorPreview()
  }

  private editorPreview() {
    const e = this.editing!, p: Palette = { id: 'preview', name: e.name, kind: e.kind, stops: [...e.stops].sort((a, b) => a.value - b.value) }, range = extent(p), k = KINDS[e.kind]
    this.root.querySelector<HTMLElement>('#palPreview')!.style.background = cssGradient(p, range)
    const values = ticks(range), at = (v: number) => (v - range[0]) / (range[1] - range[0]) * 100
    this.root.querySelector<HTMLElement>('#palPreviewTicks')!.innerHTML = values.map(v => `<span style="position:absolute;left:${at(v)}%;transform:translateX(-${at(v)}%)">${fmt(v, k.digits)}</span>`).join('')
  }

  private saveEdited() {
    const e = this.editing
    if (!e || !e.stops.length) return
    e.name = this.root.querySelector<HTMLInputElement>('#palName')!.value
    this.palettes.put(e); this.lutFor = null
    this.note(`Палитра «${e.name.trim() || 'Своя'}» сохранена в этом браузере`)
    this.showPalette()
  }

  private importPal(input: HTMLInputElement) {
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    file.text().then(text => {
      const parsed = parsePal(text, this.kind(), file.name.replace(/\.[^.]+$/, ''))
      const saved = this.palettes.put(parsed); this.lutFor = null
      this.note(saved.kind === this.kind() ? `Палитра «${saved.name}» загружена: ${saved.stops.length} точек` : `Палитра «${saved.name}» загружена для продукта ${KINDS[saved.kind].label} — она появится там`)
      this.showPalette()
    }).catch((err: Error) => this.note(`Не удалось прочитать файл: ${err.message}`))
  }

  private deletePalette() {
    const p = this.palettes.chosen(this.kind()), button = this.root.querySelector<HTMLButtonElement>('#paletteDelete')!
    if (p.builtin) return
    // A second click within 4 s deletes (no browser dialog over the instrument).
    if (performance.now() - this.deleteArmed > 4000) { this.deleteArmed = performance.now(); button.textContent = 'Точно удалить?'; setTimeout(() => { if (performance.now() - this.deleteArmed >= 4000) button.textContent = 'Удалить' }, 4100); return }
    this.palettes.remove(p.id); this.lutFor = null; this.note(`Палитра «${p.name}» удалена`); this.showPalette()
  }

  private note(text: string) { this.root.querySelector<HTMLElement>('#paletteNote')!.textContent = text }
}

