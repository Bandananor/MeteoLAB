import { L } from '../i18n'
import { type AtmosphereModel, type Circulation, DBZ_FLOOR, DUAL_MIN_DBZ, MESO_STRENGTH, type MesoStrength, MesocycloneDetector, fold, PHENOMENA, type PhenomenaLevels, PPI, RADARS, type RadarId, type RadarProduct, type VadWind, TDA_LOW_DV, TDA_MAX_DV } from '../core'
import { help, instrumentPalette, instrumentScreen, press, readings, section } from '../instrument'
import { download } from '../share'
import { MONO } from '../theme'
import { cssGradient, extent, KINDS, lookup, lutIndex, type Palette, type PaletteKind, Palettes, parsePal, type RGB, type Stop, ticks, toPal } from './palettes'

type Product = RadarProduct
/** Products of the whole volume scan (PPI.composite), not of one tilt. */
const VOLUME: readonly Product[] = ['CR', 'VIL', 'ET', 'MESH', 'VGO', 'MAP']
/** The phenomena map's colours by code (RGBA). */
const PHEN_RGBA = new Map(PHENOMENA.map(p => [p.code, p.color === 'transparent' ? [0, 0, 0, 0] : [parseInt(p.color.slice(1, 3), 16), parseInt(p.color.slice(3, 5), 16), parseInt(p.color.slice(5, 7), 16), 255]]))
/** What the vertical section shows. */
type XsField = 'Z' | 'V' | 'SRV' | 'ZDR' | 'RHO' | 'KDP'
type Point = { x: number; y: number }
/** Raster resolution of the scan, m per pixel: half a range gate, so the radial bins' edges fall on pixel edges. */
const PIXEL = 125
/** The chosen radar profile, kept in this browser. */
const RADAR_STORE = 'meteolab-radar-type', ATTENUATION_STORE = 'meteolab-radar-attenuation', MIE_STORE = 'meteolab-radar-mie', CLUTTER_STORE = 'meteolab-radar-clutter', FILTER_STORE = 'meteolab-radar-filter'
function loadRadar(): RadarId {
  try { const r = localStorage.getItem(RADAR_STORE); if (r && r in RADARS) return r as RadarId } catch { /* default */ }
  return 'wsr88d'
}
/** The vertical section: point and row spacing, m, the highest level shown, the shortest line, m. */
const XS_STEP = 125, XS_DZ = 125, XS_TOP = 18_000, XS_MIN = 1000
/** How near (CSS px) a press must be to an end of the line to drag it. */
const HANDLE = 16
/** The isotherms on the section: 0 °C (melting) and -20 °C. */
const ISO_0 = '#8fd3ff', ISO_20 = '#c9a6ff'
/** Real time between two runs of the mesocyclone detection (all 14 tilts), ms. */
const MDA_EVERY = 2000
/** Shortest signed periodic difference. */
const wrap = (d: number, size: number) => d - size * Math.round(d / size)

const PRODUCTS: Record<Product, { label: string; title: string; kind: PaletteKind }> = {
  Z: { label: L('Z — отражаемость', 'Z — reflectivity'), title: L('Z · ОТРАЖАЕМОСТЬ', 'Z · REFLECTIVITY'), kind: 'Z' },
  V: { label: L('V — радиальная скорость', 'V — radial velocity'), title: L('V · СКОРОСТЬ', 'V · VELOCITY'), kind: 'V' },
  SRV: { label: L('SRV — относительно грозы', 'SRV — storm-relative'), title: L('SRV · СКОРОСТЬ ОТНОСИТЕЛЬНО ГРОЗЫ', 'SRV · STORM-RELATIVE VELOCITY'), kind: 'V' },
  CR: { label: L('CR — составная', 'CR — composite'), title: L('CR · СОСТАВНАЯ ОТРАЖАЕМОСТЬ', 'CR · COMPOSITE REFLECTIVITY'), kind: 'Z' },
  ZDR: { label: L('ZDR — дифференциальная отражаемость', 'ZDR — differential reflectivity'), title: L('ZDR · ДИФФ. ОТРАЖАЕМОСТЬ', 'ZDR · DIFF. REFLECTIVITY'), kind: 'ZDR' },
  RHO: { label: L('ρhv (RHO, CC) — коэффициент корреляции', 'ρhv (RHO, CC) — correlation coefficient'), title: L('ρhv · КОРРЕЛЯЦИЯ', 'ρhv · CORRELATION'), kind: 'RHO' },
  KDP: { label: L('KDP — удельная дифференциальная фаза', 'KDP — specific differential phase'), title: L('KDP · ДИФФ. ФАЗА', 'KDP · DIFF. PHASE'), kind: 'KDP' },
  VIL: { label: L('VIL — водозапас столба', 'VIL — vertically integrated liquid'), title: L('VIL · ВОДОЗАПАС СТОЛБА', 'VIL · VERTICALLY INTEGRATED LIQUID'), kind: 'VIL' },
  ET: { label: L('ET — высота эха', 'ET — echo tops'), title: L('ET · ВЫСОТА ЭХА', 'ET · ECHO TOPS'), kind: 'ET' },
  MESH: { label: L('MESH — ожидаемый размер града', 'MESH — maximum expected size of hail'), title: L('MESH · РАЗМЕР ГРАДА', 'MESH · HAIL SIZE'), kind: 'MESH' },
  MAP: { label: L('Явления — карта метеоявлений (как у ДМРЛ-С)', 'Phenomena — the phenomena map (as the DMRL-C)'), title: L('КАРТА МЕТЕОЯВЛЕНИЙ', 'PHENOMENA MAP'), kind: 'Z' },
  VGO: { label: L('ВГО — верхняя граница облачности (ДМРЛ-С)', 'ВГО — cloud top height (DMRL-C)'), title: L('ВГО · ВЕРХНЯЯ ГРАНИЦА ОБЛАЧНОСТИ', 'ВГО · CLOUD TOP HEIGHT'), kind: 'ET' },
}
const XS_FIELDS: Record<XsField, { name: string; short: string; reading: string; kind: PaletteKind }> = {
  Z: { name: L('отражаемость', 'reflectivity'), short: 'Z', reading: L('Отражаемость', 'Reflectivity'), kind: 'Z' }, V: { name: L('скорость вдоль луча', 'velocity along the beam'), short: 'V', reading: L('Скорость', 'Velocity'), kind: 'V' },
  SRV: { name: L('скорость относительно грозы', 'storm-relative velocity'), short: 'SRV', reading: L('Скорость', 'Velocity'), kind: 'V' }, ZDR: { name: 'ZDR', short: 'ZDR', reading: 'ZDR', kind: 'ZDR' },
  RHO: { name: 'ρhv', short: 'ρhv', reading: 'ρhv', kind: 'RHO' }, KDP: { name: 'KDP', short: 'KDP', reading: 'KDP', kind: 'KDP' },
}
/** The section's values: the vertical section along the line, its size, the line's length (m). */
type Cut = ReturnType<PPI['crossSection']> & { gates: number; rows: number; length: number }
const DUAL_NOTE = L(`Порог эха — ${DUAL_MIN_DBZ} dBZ. Оценка по средним размерам частиц: микрофизика модели одномоментная (размер следует только из массы), поэтому сортировка капель по размеру — дуга ZDR у переднего края суперячейки — почти не видна; точнее станет с двухмоментной схемой.`, `Echo threshold — ${DUAL_MIN_DBZ} dBZ. An estimate from the particles’ mean sizes: the model’s microphysics is single-moment (the size follows from the mass alone), so the size sorting of drops — the ZDR arc at the supercell’s forward edge — is hardly visible; it will be more accurate with a two-moment scheme.`)
const HELP: Record<Product, string> = {
  Z: L('Луч идёт под углом к горизонту и с дальностью поднимается выше: низкий наклон видит осадки у земли, высокий — ядро грозы и наковальню. Щелчок по экрану переносит радар.', 'The beam leaves at an angle to the horizon and rises with range: a low tilt sees the precipitation near the ground, a high one the storm’s core and the anvil. A click on the screen moves the radar.'),
  V: L('Скорость вдоль луча: зелёное — к радару, красное — от радара. Видна только там, где есть эхо. Движение самой грозы часто маскирует вращение — для мезоциклона смотрите SRV. С «Складыванием скоростей» — как на настоящем радаре: быстрее предела (±28 м/с у S-диапазона, ±13 у C) цвет перескакивает в противоположный (ярко-красное прямо посреди ярко-зелёного без серой полосы нуля между ними), под курсором — и скорость без складывания.', 'The velocity along the beam: green — towards the radar, red — away from it. Seen only where there is an echo. The storm’s own motion often masks the rotation — for a mesocyclone look at SRV. With «Velocity folding» — as on a real radar: beyond the limit (±28 m/s in S-band, ±13 in C) the colour jumps to the opposite one (bright red right amid bright green, with no grey zero band between them); under the cursor also the unfolded speed.'),
  SRV: '',
  CR: L('Сильнейшее эхо по всем 14 наклонам объёмного скана над каждой точкой — как обычная радарная карта.', 'The strongest echo over all 14 tilts of the volume scan above each point — like an ordinary radar map.'),
  ZDR: L(`Дифференциальная отражаемость: насколько эхо в горизонтальной поляризации сильнее, чем в вертикальной. Крупные капли сплюснуты — ZDR +1…+4 дБ; град и крупа кувыркаются и почти круглые — около 0; сухой снег — 0…+0,5. Колонна ZDR — капли, вынесенные потоком выше 0 °C (высокие наклоны и разрез): признак сильного потока, раньше роста отражаемости. Высокая Z при ZDR около 0 — ядро града. ${DUAL_NOTE}`, `Differential reflectivity: how much stronger the echo is in horizontal polarization than in vertical. Large drops are flattened — ZDR +1…+4 dB; hail and graupel tumble and are nearly round — about 0; dry snow — 0…+0.5. A ZDR column — drops lofted by the updraught above 0 °C (high tilts and the cross-section): a sign of a strong updraught, ahead of the reflectivity’s growth. High Z with ZDR near 0 — a hail core. ${DUAL_NOTE}`),
  RHO: L(`Коэффициент корреляции ρhv: насколько одинаково эхо в двух поляризациях. Чистый дождь или снег — 0,97–1; смесь разных частиц — ниже: полоса таяния (снег и крупа тают в дождь) — около 0,9, град с дождём — 0,85–0,95. Обломки смерча (TDS, ρhv < 0,8) модель не показывает: вихрь мельче её сетки. ${DUAL_NOTE}`, `The correlation coefficient ρhv: how alike the echo is in the two polarizations. Pure rain or snow — 0.97–1; a mix of particles — lower: the melting layer (snow and graupel melting into rain) — about 0.9, hail with rain — 0.85–0.95. Tornado debris (TDS, ρhv < 0.8) the model does not show: the vortex is smaller than its grid. ${DUAL_NOTE}`),
  KDP: L(`Удельная дифференциальная фаза, °/км: насколько горизонтальная волна отстаёт от вертикальной в дожде. Растёт с количеством воды и почти не замечает града, поэтому по KDP находят сильный ливень внутри ядра града. Здесь — только от дождя. ${DUAL_NOTE}`, `Specific differential phase, °/km: how much the horizontal wave lags the vertical one in rain. It grows with the amount of water and hardly notices hail, so KDP finds heavy rain inside a hail core. Here — from rain only. ${DUAL_NOTE}`),
  VIL: L('Водозапас столба: сколько воды «в каплях» над каждой точкой, кг/м², — по отражаемости всех 14 наклонов (Greene и Clark 1972; эхо сильнее 56 dBZ считается как 56, чтобы град не шёл за воду). Больше 40–50 — мощное ядро, вероятен град; под курсором — и плотность VIL (VIL на высоту эха): от 3,5 г/м³ — вероятен крупный град. В модели и одиночная ячейка доходит до ~40 при плотности ~4,5: ядро крупы отражает сильнее природного (одномоментная микрофизика); у суперячеек — 50–60.', 'Vertically integrated liquid: how much water “as drops” is above each point, kg/m², from the reflectivity of all 14 tilts (Greene and Clark 1972; echo over 56 dBZ counts as 56, so hail is not taken for water). Above 40–50 — a strong core, hail likely; under the cursor also the VIL density (VIL over the echo top): from 3.5 g/m³ large hail is likely. In the model a single cell too reaches ~40 at a density of ~4.5: its graupel core echoes more strongly than in nature (one-moment microphysics); supercells give 50–60.'),
  ET: L('Высота эха: самый высокий луч с эхом от 18 dBZ (как у NWS; у DWD — от 5 dBZ). Показывает, как высоко поднялся восходящий поток: 12–16 км — мощная гроза; вершина над тропопаузой — сильный поток пробил её (купол над наковальней). Ступенька на ~1 км — от шага наклонов, а вблизи радара даже наклон 19,5° не достаёт до вершины («конус молчания»): там высота — нижняя оценка, под курсором — «≥». Так и на настоящем радаре.', 'Echo tops: the highest beam with at least 18 dBZ echo (as the NWS; the DWD from 5 dBZ). Shows how high the updraught has risen: 12–16 km — a strong storm; a top above the tropopause — a strong updraught has punched through it (the dome over the anvil). Steps of ~1 km come from the tilts’ spacing, and near the radar even the 19.5° tilt does not reach the top (the cone of silence): there the height is a lower bound, “≥” under the cursor. So it is on a real radar too.'),
  MAP: L('Карта метеоявлений, как у ДМРЛ-С: в каждой точке — наибольшее из узнанных явлений, коды и порядок легенды — ГИМЕТ-2010 (методические указания Росгидромета 2014, табл. 4.7.1). Свои пороги ГИМЕТ-2010 не опубликованы, поэтому критерии — из руководства для МРЛ-5 РД 52.04.320-91: осадки по Z1 (18 / 30 / 46 dBZ); гроза по Y = H·lgZ3 при вершине не ниже −22 °C (порог H(−22 °C)·1,2, затем +6 и +14); град — 58 dBZ, или 55 при вершине от 10 км, с ядром от 46 dBZ выше H0 + 1,4 км; шквал — скорость по табл. 2.7 из движения ячеек при вершине от 10 км; смерч — крюкообразное эхо (из поиска мезоциклонов, в пределах 8 км) и вершина на 3 км выше тропопаузы при 53 dBZ. Выбор проекта (в РД градаций нет): ливень — осадки при Z2 от 18 dBZ и вершине выше нулевой изотермы; град умеренный — от 63 dBZ, сильный — ещё и MESH от 2 см; шквал 15–20 / 20–25 / > 25 м/с и только над ядром от 46 dBZ выше H0 + 1,4 км. Град, шквал и смерч — только при грозе > 90 % (так в указаниях). Код шквала старше града, поэтому над ядром суперячейки град часто скрыт шквалом — смотрите MESH. Модель даёт ядра крупы 63–69 dBZ и слишком холодный отток — град и шквал на карте чаще, чем в природе.', 'The phenomena map as the DMRL-C makes it: at each point the highest of the phenomena recognised, the codes and the legend\'s order those of GIMET-2010 (the Roshydromet guidelines of 2014, table 4.7.1). GIMET-2010\'s own thresholds are not published, so the criteria are those of the MRL-5 guide RD 52.04.320-91: precipitation by Z1 (18 / 30 / 46 dBZ); thunder by Y = H·lgZ3 with the top at least at −22 °C (threshold H(−22 °C)·1.2, then +6 and +14); hail — 58 dBZ, or 55 with a top from 10 km, with a core from 46 dBZ above H0 + 1.4 km; squall — the speed by table 2.7 from the cells\' motion with a top from 10 km; tornado — a hook echo (from the mesocyclone detection, within 8 km) and the top 3 km above the tropopause with 53 dBZ. This project\'s choice (the RD has no grades): shower — precipitation with Z2 from 18 dBZ and the top above the 0 °C level; moderate hail from 63 dBZ, heavy with MESH from 2 cm too; squall 15–20 / 20–25 / > 25 m/s and only over a core from 46 dBZ above H0 + 1.4 km. Hail, squall and tornado only with thunder > 90 % (as the guidelines say). The squall code ranks above hail, so over the core of a supercell the hail is often hidden by the squall — see MESH. The model gives graupel cores of 63–69 dBZ and a too cold outflow — hail and squalls show on the map more often than in nature.'),
  VGO: L('Верхняя граница облачности, как её даёт ДМРЛ-С: самый высокий луч объёмного обзора с эхом от −5 dBZ (методические указания Росгидромета 2014). В курсоре — остальные величины столба, по которым российские радары узнают явления: Z1 (0,6–1 км) и Z2 (2–4 км) — для осадков и ливней, Z на уровне нулевой изотермы H2 и на 2,25 км выше неё H3 — для грозы и града, Zmax выше 1 км. Облака без осадков модель радару не показывает: ВГО — это верх осадков и снега в облаке, не всего облака.', 'The cloud top height as the DMRL-C gives it: the highest beam of the volume scan with echo from −5 dBZ (the Roshydromet guidelines of 2014). The cursor shows the other column quantities by which the Russian radars recognise phenomena: Z1 (0.6–1 km) and Z2 (2–4 km) for rain and showers, Z at the 0 °C level H2 and 2.25 km above it H3 for thunder and hail, Zmax above 1 km. The model shows the radar no cloud without precipitation: ВГО is the top of the rain and snow in the cloud, not of the whole cloud.'),
  MESH: L('Ожидаемый наибольший размер града, мм (Witt и др. 1998): по эхо сильнее 40 dBZ выше уровня 0 °C, с полным весом выше −20 °C, где растёт град. От 19 мм — град опасный по меркам NWS, от 50 — крупный. Оценка по отражаемости, как на настоящем радаре; сколько града падает в модели — у станции и на панели («Град у земли»). В модели MESH завышен: ядро крупы отражает сильнее природного (63–69 dBZ и у одиночной ячейки), и «Летний день» показывает до ~50 мм при граде в самой модели до 8 мм; у классической суперячейки 50–65 мм — ближе к природе в такой среде, чем град самой модели (до 16 мм: одномоментная схема не растит крупный).', 'The maximum expected size of hail, mm (Witt et al. 1998): from echo over 40 dBZ above the 0 °C level, with full weight above −20 °C, where hail grows. From 19 mm — severe hail by NWS standards, from 50 — large. An estimate from the reflectivity, as on a real radar; what hail falls in the model is at the station and on the panel («Hail at the ground»). In the model MESH runs high: the graupel core echoes more strongly than in nature (63–69 dBZ even in a single cell), and the «Summer day» shows up to ~50 mm with the model’s own hail up to 8 mm; the classic supercell’s 50–65 mm is closer to nature in such an environment than the model’s own hail (up to 16 mm: the one-moment scheme does not grow large stones).'),
}
const NO_ECHO = L('нет эха', 'no echo'), DELETE = L('Удалить', 'Delete')
const XS_HELP = L('Разрез — вертикальный срез по линии A–B через весь объём: видно, как высоко поднимается эхо, свод слабого эха (BWER) над восходящим потоком, нависающее эхо, ядро града, наковальню, колонну ZDR. Тонкие линии — лучи 14 наклонов там, где они пересекают линию: так их видит радар (вдали от радара лучи выше, между ними — пропуски). Пунктир — изотермы 0 °C (ниже тает снег и крупа) и −20 °C (около неё растёт град и разделяются заряды). Разрез от радара через точку — как RHI настоящего радара; на линии в стороне от радара скорость — всё равно вдоль его луча к каждой точке. По вертикали масштаб растянут.', 'The cross-section is a vertical slice along the line A–B through the whole volume: how high the echo rises, the bounded weak echo region (BWER) over the updraught, the overhanging echo, the hail core, the anvil, the ZDR column. Thin lines are the beams of the 14 tilts where they cross the line: as the radar sees them (far from the radar the beams are higher, with gaps between them). Dashed — the 0 °C isotherm (snow and graupel melt below it) and −20 °C (hail grows and charges separate near it). A section from the radar through a point is like a real radar’s RHI; on a line off to the side the velocity is still along the radar’s beam to each point. The vertical scale is stretched.')

/**
 * Range rings, azimuth radials and their labels: steps (0: off), compass points instead of degrees; the data drawn in
 * radial bins of the radar profile (`beam` 1; 0: smooth pixels).
 */
interface GridSettings { radials: number; rings: number; labels: boolean; compass: boolean; beam: number }
const XS_STORE = 'meteolab-radar-section'
/** The section kept in this browser: shown or not, its field, its line's ends (m from the domain's south-west corner). */
function loadSection(): { on: boolean; field: XsField; a: Point | null; b: Point | null } {
  const point = (p: unknown): Point | null => p && typeof p === 'object' && Number.isFinite((p as Point).x) && Number.isFinite((p as Point).y) ? { x: (p as Point).x, y: (p as Point).y } : null
  try {
    const s = JSON.parse(localStorage.getItem(XS_STORE) ?? 'null')
    if (s && typeof s === 'object') return { on: s.on === true, field: typeof s.field === 'string' && s.field in XS_FIELDS ? s.field : 'Z', a: point(s.a), b: point(s.b) }
  } catch { /* default */ }
  return { on: false, field: 'Z', a: null, b: null }
}
const GRID_STORE = 'meteolab-radar-grid', GRID_DEFAULT: GridSettings = { radials: 30, rings: 5, labels: true, compass: false, beam: 1 }
const RADIAL_STEPS = [0, 10, 30, 45], RING_STEPS = [0, 5, 10, 25]
const POINTS = L('С ССВ СВ ВСВ В ВЮВ ЮВ ЮЮВ Ю ЮЮЗ ЮЗ ЗЮЗ З ЗСЗ СЗ ССЗ', 'N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW').split(' ')
/** The compass point (of 16) of an azimuth. */
const point = (azimuth: number) => POINTS[Math.round(((azimuth % 360) + 360) % 360 / 22.5) % 16]
function loadGrid(): GridSettings {
  try {
    const g = JSON.parse(localStorage.getItem(GRID_STORE) ?? 'null')
    if (g && RADIAL_STEPS.includes(g.radials) && RING_STEPS.includes(g.rings)) return { radials: g.radials, rings: g.rings, labels: g.labels !== false, compass: g.compass === true, beam: g.beam === 0 ? 0 : 1 }
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
 * products (ZDR, rho_hv, KDP; core/polarimetry.ts), and under it a vertical section along any line (its ends dragged on the map; from the radar it is an RHI). The beam rises with range (4/3 Earth),
 * so a higher tilt looks at higher levels. Range rings, azimuth radials and their labels as chosen, a cursor readout; a
 * click moves the radar site. Every kind of product has its palette: built-in ones, the user's own (an editor) and
 * imported .pal files (radar/palettes.ts).
 */
export class RadarPanel {
  private readonly root: HTMLDivElement; private readonly canvas: HTMLCanvasElement; private readonly ctx: CanvasRenderingContext2D
  private readonly raster: HTMLCanvasElement; private readonly rasterCtx: CanvasRenderingContext2D
  private ppi: PPI | null = null; private image: ImageData | null = null
  private lastTime = -1; private lastDraw = 0; private lastComposite = 0; private hover: Point | null = null
  private product: Product = 'Z'
  /** Mesocyclone detection over the whole volume scan, rerun every MDA_EVERY ms of real time while the screen is open. */
  /** The radar profile (radars.ts): its tilts, bins, ranges and Nyquist velocity. */
  private radar = loadRadar()
  /** Whether the beam is attenuated by rain and gases (on unless switched off in this browser). */
  private attenuate = (() => { try { return localStorage.getItem(ATTENUATION_STORE) !== '0' } catch { return true } })()
  /** Whether rain, graupel and hail scatter by Mie at the radar's wavelength (on unless switched off in this browser). */
  private mie = (() => { try { return localStorage.getItem(MIE_STORE) !== '0' } catch { return true } })()
  /** Ground clutter and noise (on unless switched off), and the clutter filter (off unless switched on). */
  private clutter = (() => { try { return localStorage.getItem(CLUTTER_STORE) !== '0' } catch { return true } })()
  private filtered = (() => { try { return localStorage.getItem(FILTER_STORE) === '1' } catch { return false } })()
  /** Whether the base velocity folds at the radar's Nyquist velocity (V and its section), and the buffers it is folded into. */
  private folding = false; private levels: PhenomenaLevels | null = null; private foldedMap = new Float32Array(0); private foldedCut = new Float32Array(0)
  private detector = new MesocycloneDetector(); private detections: Circulation[] = []; private lastScan = 0; private scanTime = -1; private showMda = true; private showWeak = false
  /** VAD winds of the last volume scan and whether they are drawn. */
  private vad: VadWind[] = []; private showVad = true
  /** Storm motion for SRV (the Bunkers right mover of the environment), m/s. */
  private motion: readonly [number, number] = [0, 0]
  /** The vertical section: its line and field (kept in this browser), its values and raster, the cursor on it. */
  private xs = loadSection(); private cut: Cut | null = null; private xsHover: { d: number; h: number } | null = null
  private readonly xsRaster: HTMLCanvasElement; private readonly xsCtx: CanvasRenderingContext2D
  /** A press on the map: dragging an end of the line, drawing a new one (Shift), or maybe a click (moves the radar). */
  private drag: { kind: 'a' | 'b' | 'new' | 'press'; from: Point; sx: number; sy: number } | null = null
  /** What the next taps on the map give: the line's ends A then B, or the point the line from the radar goes through. */
  private picking: 'a' | 'b' | 'radial' | null = null
  private grid = loadGrid()
  private readonly palettes = new Palettes()
  /** The colour lookups of the chosen palettes (map and section may show different kinds). */
  private readonly luts = new Map<Palette, Uint8ClampedArray>()
  /** The palette being edited (a copy) and the stop rows of the editor. */
  private editing: { id?: string; name: string; kind: PaletteKind; stops: Stop[] } | null = null
  private deleteArmed = 0
  open = false

  constructor(host: HTMLElement) {
    const strengths = (Object.keys(MESO_STRENGTH) as MesoStrength[]).map((s, i, all) => `<div class="mda--${s}"><i></i><span>${[L('Циркуляция', 'Circulation'), L('Слабый', 'Weak'), L('Умеренный', 'Moderate'), L('Сильный', 'Strong')][i]}</span><span class="num">${i ? `≥ ${MESO_STRENGTH[s].vrot}` : `< ${MESO_STRENGTH[all[1]].vrot}`} ${L('м/с', 'm/s')}</span></div>`).join('')
    const seg = (name: string, options: [string, string][]) => `<div class="seg seg--block seg--instrument" data-seg="${name}">${options.map(([v, t]) => `<button data-value="${v}">${t}</button>`).join('')}</div>`
    this.root = instrumentScreen(host, 'radar-app', `METEOLAB DOPPLER · <span id="radarName">${RADARS[this.radar].name} · ${RADARS[this.radar].band}</span>`,
      `<span>${L('ПРОДУКТ', 'PRODUCT')} <b id="radarProduct">${PRODUCTS.Z.title}</b></span><span>${L('НАКЛОН', 'TILT')} <b id="radarTilt">0.5°</b></span><span>${L('РАЗРЕЗ', 'SECTION')} <b id="radarCut">${L('нет', 'none')}</b></span><span>T+ <b id="radarTime">00:00</b></span>`,
      section(L('Радар', 'Radar'), `<div class="field"><span class="select"><select id="radarType">${(Object.keys(RADARS) as RadarId[]).map(r => `<option value="${r}">${RADARS[r].name} · ${RADARS[r].band}</option>`).join('')}</select></span></div>
        <label class="check" title="${L('Луч ослабляется дождём, крупой и градом по дороге туда и обратно: за сильным ядром эхо слабее, ZDR ниже — «тень». На S почти незаметно, на C — несколько дБ, на X — десятки за ливнем. Удельное ослабление — по KDP (A = α·KDP: 0,02 / 0,08 / 0,30 для S / C / X), плюс газы. Продукты ДМРЛ-С и CR, VIL, ET, MESH считаются по ослабленному эху, как у настоящего радара без поправки; разрез и поиск мезоциклонов — без ослабления', 'The beam is attenuated by rain, graupel and hail on the way out and back: behind a strong core the echo is weaker and ZDR lower — a shadow. Barely visible at S, a few dB at C, tens behind a downpour at X. The specific attenuation from KDP (A = α·KDP: 0.02 / 0.08 / 0.30 for S / C / X), plus gases. The DMRL-C products and CR, VIL, ET, MESH use the attenuated echo, as a real radar without correction; the section and the mesocyclone detection do not')}"><input type="checkbox" id="radarAttenuation"> ${L('Ослабление в осадках', 'Attenuation in precipitation')}</label><label class="check" title="${L('Дождь, крупа и град рассеивают по теории Ми на длине волны радара, а не по Рэлею: крупный град на C и X выглядит слабее (на C при граде ~3 см — на 5–10 дБ), тающая крупа на S — ярче на 2–3 дБ. Частицы — сферы; тающие крупа и град — как капли той же массы (грубо), снег по Рэлею. Без флажка — рэлеевская отражаемость модели, одинаковая для всех радаров', 'Rain, graupel and hail scatter by Mie theory at the radar\'s wavelength instead of Rayleigh: large hail looks weaker at C and X (5–10 dB at C for ~3 cm hail), melting graupel brighter at S by 2–3 dB. Spheres; melting graupel and hail as drops of their mass (rough), snow Rayleigh. Unchecked — the model\'s Rayleigh reflectivity, the same at every radar')}"><input type="checkbox" id="radarMie"> ${L('Рассеяние Ми', 'Mie scattering')}</label><label class="check" title="${L('Отражения от земли (местники) у радара: цели на земле выше нижнего края луча — на низком наклоне в первые 20–40 км, на высоких только у самого радара. Скорость около нуля, ρhv 0,5–0,85, шумный ZDR, Z в среднем 25 dBZ, местами до 65. И шум приёмника: слабое эхо далеко не видно — порог растёт на 6 дБ при удвоении дальности (у WSR-88D около −7,5 dBZ на 50 км)', 'Ground clutter near the radar: targets on the ground above the lower edge of the beam — at the low tilt within the first 20–40 km, at the high ones only next to the radar. Velocity near zero, ρhv 0.5–0.85, noisy ZDR, Z 25 dBZ on average, up to 65 in places. And receiver noise: weak echo far away is not seen — the threshold rises 6 dB per doubling of range (about −7.5 dBZ at 50 km for the WSR-88D)')}"><input type="checkbox" id="radarClutter"> ${L('Местники и шум', 'Clutter and noise')}</label><label class="check" title="${L('Фильтр местников, как у настоящих радаров (CMD/GMAP у WSR-88D, у ДМРЛ-С подавление не меньше 50 дБ): от местников остаётся слабый след', 'The clutter filter, as on real radars (CMD/GMAP on the WSR-88D, at least 50 dB on the DMRL-C): a faint trace of the clutter stays')}"><input type="checkbox" id="radarFilter"> ${L('Фильтр местников', 'Clutter filter')}</label><span class="t-caption" id="radarNote"></span><dl class="kv" id="radarSpecs"></dl><span class="t-caption" id="radarVerified"></span>`)
      + section(L('Продукт', 'Product'), `<div class="tilts tilts--4">${(Object.keys(PRODUCTS) as Product[]).map(p => `<button data-product="${p}" title="${PRODUCTS[p].label}">${p}</button>`).join('')}</div>
        <div class="stat" style="border:0;padding:0"><span id="radarProductLabel"></span><span class="unit" id="radarUnits">dBZ</span></div>
        <span class="label" title="${L(`Как у настоящего импульсного радара: скорость вдоль луча измеряется только в пределах ±v_N = λ·PRF/4 (Найквист), быстрее — «заворачивается» в другой знак: красное посреди зелёного. Предел берётся у выбранного радара (WSR-88D ~±28 м/с, европейский C с двойной частотой импульсов ±32, ДМРЛ-С с двумя периодами импульсов ±66). Только для V: SRV и MDA считаются по раскрученной скорости, как у NWS`, `As on a real pulsed radar: the velocity along the beam is measured only within ±v_N = λ·PRF/4 (Nyquist), faster wind folds over to the other sign: red amid green. The limit is the chosen radar’s (WSR-88D ~±28 m/s, a European C with dual PRF ±32, DMRL-C with two pulse periods ±66). V only: SRV and the MDA use the unfolded velocity, as the NWS`)}">${L('Складывание скоростей (V)', 'Velocity folding (V)')}</span>${seg('fold', [['0', L('нет', 'none')], ['1', `±${RADARS[this.radar].nyquist}`]])}`)
      + section(L('Угол наклона', 'Tilt angle'), '<div class="tilts" id="radarTilts"></div>')
      + section(L('Вертикальный разрез', 'Vertical cross-section'), `<label class="check"><input type="checkbox" id="xsShow"> ${L('Показывать разрез под картой', 'Show the section under the map')}</label>
        <div class="radar-buttons"><button class="btn btn--xs" id="xsDraw" title="${L('Два щелчка или касания по карте: начало A, затем конец B', 'Two clicks or taps on the map: the start A, then the end B')}">${L('Провести разрез', 'Draw a section')}</button><button class="btn btn--xs" id="xsRadial" title="${L('Щелчок или касание по карте: разрез от радара через эту точку до края области — как RHI настоящего радара', 'A click or tap on the map: a section from the radar through that point to the domain’s edge — like a real radar’s RHI')}">${L('От радара через точку', 'From the radar through a point')}</button><button class="btn btn--xs" id="xsStrongest" title="${L('Разрез от радара через самое сильное эхо объёмного скана', 'A section from the radar through the volume scan’s strongest echo')}">${L('Через самое сильное эхо', 'Through the strongest echo')}</button></div>
        <span class="label">${L('Поле разреза', 'Section field')}</span>${seg('xs', (Object.keys(XS_FIELDS) as XsField[]).map(f => [f, XS_FIELDS[f].short]))}
        <span class="t-caption" id="xsInfo"></span>
        <span class="t-caption">${L('Концы A и B перетаскиваются. Shift + протянуть по карте — новая линия, Shift + щелчок — от радара через точку.', 'The ends A and B can be dragged. Shift + drag on the map — a new line, Shift + click — from the radar through a point.')}</span>`)
      + section(L('Шкала и палитра', 'Scale and palette'), `<div class="colorbar" id="radarColorbar"><div class="colorbar__bar" id="radarLegend"></div><div class="colorbar__ticks" id="radarTicks"></div></div><div id="radarPhenomena" hidden><div style="display:grid;grid-template-columns:auto 1fr;gap:2px 8px;font-size:12px">${PHENOMENA.map(p => `<i style="width:14px;height:10px;align-self:center;background:${p.color}"></i><span>${p.code} · ${p.name}</span>`).join('')}</div></div>
        <div class="field"><span class="field__label" id="paletteLabel">${L('Палитра', 'Palette')}</span><span class="select"><select id="paletteSelect"></select></span></div>
        <div class="radar-buttons"><button class="btn btn--xs" id="paletteEdit" title="${L('Редактор палитры: точки «значение → цвет», плавно или ступенями', 'Palette editor: “value → colour” points, smooth or in steps')}">${L('Изменить', 'Edit')}</button><button class="btn btn--xs" id="paletteImport" title="${L('Файл .pal радарных программ (строки Color: / SolidColor:)', 'A .pal file of radar software (Color: / SolidColor: lines)')}">${L('Импорт .pal', 'Import .pal')}</button><button class="btn btn--xs" id="paletteExport">${L('Экспорт .pal', 'Export .pal')}</button><button class="btn btn--xs" id="paletteDelete" hidden>${DELETE}</button></div>
        <input type="file" id="paletteFile" accept=".pal,.txt,text/plain" hidden>
        <span class="t-caption" id="paletteNote"></span>`)
      + section(L('Сетка', 'Grid'), `<span class="label" title="${L('Как на экране настоящего радара: данные лежат по лучам и стробам дальности выбранного радара, поэтому ячейки — секторы, которые расширяются с дальностью', 'As on a real radar’s screen: the data lie along the chosen radar’s beams and range gates, so the cells are sectors that widen with range')}">${L('Пиксели данных', 'Data pixels')}</span>${seg('beam', [['1', L('по лучам радара', 'the radar’s beams')], ['0', L('гладкие', 'smooth')]])}
        <span class="label">${L('Радиалы', 'Radials')}</span>${seg('radials', RADIAL_STEPS.map(s => [String(s), s ? `${s}°` : L('нет', 'none')]))}
        <span class="label">${L('Кольца дальности', 'Range rings')}</span>${seg('rings', RING_STEPS.map(s => [String(s), s ? `${s} ${L('км', 'km')}` : L('нет', 'none')]))}
        <label class="check"><input type="checkbox" id="gridLabels"> ${L('Подписи азимутов и дальностей', 'Azimuth and range labels')}</label>
        <span class="label">${L('Азимуты', 'Azimuths')}</span>${seg('compass', [['0', L('градусы', 'degrees')], ['1', L('румбы', 'compass points')]])}`)
      + section(L('Мезоциклоны (MDA)', 'Mesocyclones (MDA)'), `<label class="check"><input type="checkbox" id="radarMda" checked> ${L('Отмечать на экране', 'Mark on the screen')}</label>
        <label class="check" title="${L('Вращение слабее порога мезоциклона (Vrot < 12,5 м/с): на сетке ~1 км их много в любой сильной грозе', 'Rotation weaker than the mesocyclone threshold (Vrot < 12.5 m/s): on the ~1 km grid there are many in any strong storm')}"><input type="checkbox" id="radarWeak"> ${L('И слабые циркуляции', 'Weak circulations too')}</label>
        <div class="mda-list" id="radarMdaList"></div>
        <div class="mda-legend"><span class="label">${L('Метки силы · Vrot', 'Strength marks · Vrot')}</span>${strengths}</div>`)
      + section(L('Ветер (VAD)', 'Wind (VAD)'), `<label class="check" title="${L('Ветер над радаром по радиальной скорости, как VAD у настоящих радаров (у ДМРЛ-С — вертикальный профиль ветра и наноска векторов): на каждом наклоне скорость по кольцу 30, 20 или 10 км вписывается синусоидой по азимуту. Стрелки от радара — куда дует ветер на высоте кольца. Нужно эхо по кольцу: у модели нет эха ясного неба, поэтому ветер есть только там, где осадки', 'The wind over the radar from the radial velocity, as the VAD of real radars (the DMRL-C\'s wind profile and vectors): on each tilt the velocity around a 30, 20 or 10 km ring is fitted by a sine of the azimuth. The arrows from the radar point where the wind blows at the ring\'s height. It needs echo around the ring: the model has no clear-air echo, so there is wind only where it rains')}"><input type="checkbox" id="radarVad" checked> ${L('Стрелки от радара', 'Arrows from the radar')}</label>
        <div class="mda-list" id="radarVadList"></div>`)
      + section(L('Курсор', 'Cursor'), '<dl class="kv" id="radarReadout"></dl>')
      + help('', 'radarHelp'))
    this.root.insertAdjacentHTML('beforeend', `<dialog class="modal modal--wide pal-editor" id="paletteEditor"><form method="dialog" style="display:contents">
      <h2 class="modal__title">${L('Палитра', 'Palette')} · <span id="palKind"></span></h2>
      <label class="field"><span class="label">${L('Название', 'Name')}</span><input class="input" id="palName" autocomplete="off" spellcheck="false"></label>
      <div class="colorbar"><div class="colorbar__bar" id="palPreview"></div><div class="colorbar__ticks" id="palPreviewTicks"></div></div>
      <div class="pal-head"><span class="label">${L('Значение', 'Value')} (<span id="palUnits"></span>)</span><span class="label">${L('Цвет', 'Colour')}</span><span class="label">${L('Дальше', 'Then')}</span><span></span></div>
      <div class="pal-rows" id="palRows"></div>
      <div class="radar-buttons"><button type="button" class="btn btn--xs" id="palAdd">${L('+ точка', '+ point')}</button><button type="button" class="btn btn--xs" id="palSmooth">${L('Все плавно', 'All smooth')}</button><button type="button" class="btn btn--xs" id="palSteps">${L('Все ступенями', 'All steps')}</button></div>
      <p class="modal__text">${L('Каждая точка красит значения от себя до следующей: плавно — переходом к цвету следующей точки, ступенью — одним цветом, «пусто» — ничего не рисует.', 'Each point paints the values from itself to the next: smooth — fading into the next point’s colour, step — in one colour, “empty” — draws nothing.')} <span id="palBelow"></span></p>
      <div class="modal__actions"><button class="btn btn--quiet" value="cancel">${L('Отмена', 'Cancel')}</button><button class="btn btn--primary" value="save">${L('Сохранить', 'Save')}</button></div>
    </form></dialog>`)
    this.canvas = this.root.querySelector('canvas')!; this.ctx = this.canvas.getContext('2d')!
    this.raster = document.createElement('canvas'); this.rasterCtx = this.raster.getContext('2d')!
    this.xsRaster = document.createElement('canvas'); this.xsCtx = this.xsRaster.getContext('2d')!
    const $ = <T extends Element = HTMLElement>(s: string) => this.root.querySelector<T>(s)!
    $<HTMLInputElement>('#xsShow').addEventListener('change', e => this.showSection((e.target as HTMLInputElement).checked))
    $('#xsDraw').addEventListener('click', () => this.pick(this.picking === 'a' || this.picking === 'b' ? null : 'a'))
    $('#xsRadial').addEventListener('click', () => this.pick(this.picking === 'radial' ? null : 'radial'))
    $('#xsStrongest').addEventListener('click', () => this.aimAtStrongest())
    $<HTMLInputElement>('#radarMda').addEventListener('change', e => { this.showMda = (e.target as HTMLInputElement).checked; this.draw() })
    $<HTMLInputElement>('#radarVad').addEventListener('change', e => { this.showVad = (e.target as HTMLInputElement).checked; this.draw() })
    $<HTMLInputElement>('#radarWeak').addEventListener('change', e => { this.showWeak = (e.target as HTMLInputElement).checked; this.listMda(); this.draw() })
    $('.ibar__close').addEventListener('click', () => this.toggle(false))
    $('#radarTilts').addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tilt]'); if (b) this.setTilt(Number(b.dataset.tilt)) })
    $<HTMLInputElement>('#radarAttenuation').checked = this.attenuate
    $<HTMLInputElement>('#radarMie').checked = this.mie
    $<HTMLInputElement>('#radarClutter').checked = this.clutter; $<HTMLInputElement>('#radarFilter').checked = this.filtered
    $<HTMLInputElement>('#radarClutter').addEventListener('change', e => { this.clutter = (e.target as HTMLInputElement).checked; try { localStorage.setItem(CLUTTER_STORE, this.clutter ? '1' : '0') } catch { /* not kept */ } if (this.ppi) this.ppi.clutter = this.clutter; this.lastComposite = 0; this.refresh(true) })
    $<HTMLInputElement>('#radarFilter').addEventListener('change', e => { this.filtered = (e.target as HTMLInputElement).checked; try { localStorage.setItem(FILTER_STORE, this.filtered ? '1' : '0') } catch { /* not kept */ } if (this.ppi) this.ppi.filtered = this.filtered; this.lastComposite = 0; this.refresh(true) })
    $<HTMLInputElement>('#radarMie').addEventListener('change', e => { this.mie = (e.target as HTMLInputElement).checked; try { localStorage.setItem(MIE_STORE, this.mie ? '1' : '0') } catch { /* not kept */ } if (this.ppi) this.ppi.mie = this.mie; this.lastComposite = 0; this.refresh(true) })
    $<HTMLInputElement>('#radarAttenuation').addEventListener('change', e => { this.attenuate = (e.target as HTMLInputElement).checked; try { localStorage.setItem(ATTENUATION_STORE, this.attenuate ? '1' : '0') } catch { /* not kept */ } if (this.ppi) this.ppi.attenuate = this.attenuate; this.lastComposite = 0; this.refresh(true) })
    $<HTMLSelectElement>('#radarType').addEventListener('change', e => this.setRadar((e.target as HTMLSelectElement).value as RadarId))
    this.root.querySelectorAll<HTMLButtonElement>('[data-product]').forEach(b => b.addEventListener('click', () => this.setProduct(b.dataset.product as Product)))
    // The segmented choices: grid steps, degrees or compass points, the section's field.
    this.root.querySelectorAll<HTMLElement>('[data-seg]').forEach(s => s.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]')
      if (!b) return
      const v = b.dataset.value!
      if (s.dataset.seg === 'fold') { this.folding = v === '1'; press(s.querySelectorAll<HTMLButtonElement>('button'), x => x === b); this.refresh(true); return }
      if (s.dataset.seg === 'xs') { this.xs.field = v as XsField; this.showSection(true); return }
      if (s.dataset.seg === 'beam') { this.grid.beam = Number(v); this.applyBins(); this.saveGrid(); this.refresh(true); return }
      if (s.dataset.seg === 'radials') this.grid.radials = Number(v)
      else if (s.dataset.seg === 'rings') this.grid.rings = Number(v)
      else this.grid.compass = v === '1'
      this.saveGrid()
    }))
    press(this.root.querySelectorAll<HTMLButtonElement>('[data-seg="fold"] button'), b => b.dataset.value === '0')
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
    // The map and the section: mouse and touch alike.
    const c = this.canvas
    c.addEventListener('pointerdown', e => this.pointerDown(e))
    c.addEventListener('pointermove', e => this.pointerMove(e))
    c.addEventListener('pointerup', e => this.pointerUp(e))
    c.addEventListener('pointercancel', () => { this.drag = null })
    c.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = null; this.xsHover = null; this.draw() } })
    // On a narrow screen a swipe over the canvas scrolls the panel (touch-action: pan-y); a touch on an end of the line,
    // or while picking points, is a drag or a tap instead.
    c.addEventListener('touchstart', e => { const t = e.touches[0]; if (t && (this.picking || this.handleAt(t.clientX, t.clientY))) e.preventDefault() }, { passive: false })
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.open && !editor.open) this.toggle(false) })
    addEventListener('resize', () => this.open && this.draw())
    this.showGrid()
    this.showRadar()
    this.setProduct('Z')
  }

  /** Switches the radar profile: its tilts, bins, ranges and Nyquist velocity; the detections start afresh. */
  private setRadar(radar: RadarId) {
    this.radar = radar
    try { localStorage.setItem(RADAR_STORE, radar) } catch { /* not kept */ }
    if (this.ppi) { this.ppi.setProfile(RADARS[radar]); this.applyBins(); this.detector = new MesocycloneDetector(); this.detections = []; this.vad = []; this.scanTime = -1; this.listMda() }
    this.showRadar(); this.markTilt(); this.refresh(true)
  }

  /** The radar's name, numbers and tilts on the screen. */
  private showRadar() {
    const p = RADARS[this.radar], km = (m: number) => `${(m / 1000).toFixed(0)} ${L('км', 'km')}`
    const $ = (s: string) => this.root.querySelector<HTMLElement>(s)!
    this.root.querySelector<HTMLSelectElement>('#radarType')!.value = this.radar
    $('#radarName').textContent = `${p.name} · ${p.band}`
    $('#radarNote').textContent = p.note
    $('#radarSpecs').innerHTML = ([
      [L('Длина волны', 'Wavelength'), `${p.wavelength.toFixed(2).replace(/\.?0+$/, '')} ${L('см', 'cm')}`],
      [L('Луч / радиалы', 'Beam / radials'), `${p.beam}° / ${p.step}°`],
      [L('Строб', 'Gate'), p.velocityGate ? `Z ${p.gate} / V ${p.velocityGate} ${L('м', 'm')}` : `${p.gate} ${L('м', 'm')}`],
      [L('Наклоны', 'Tilts'), p.velocityTilts ? `Z ${p.tilts.length} / V ${p.velocityTilts.length}: ${p.tilts[0]}–${p.tilts[p.tilts.length - 1]}°` : `${p.tilts.length}: ${p.tilts[0]}–${p.tilts[p.tilts.length - 1]}°`],
      [L('Найквист', 'Nyquist'), `±${p.nyquist} ${L('м/с', 'm/s')}`],
      [L('Дальность Z / V', 'Range Z / V'), `${km(p.range)} / ${km(p.velocityRange)}`],
      [L('Объём', 'Volume'), p.volume < 60 ? `${p.volume} ${L('с', 's')}` : `${(p.volume / 60).toFixed(1).replace(/\.0$/, '')} ${L('мин', 'min')}`],
    ] as [string, string][]).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
    $('#radarVerified').textContent = `${L('Откуда числа', 'Sources')}: ${p.verified}`
    // Only the products this radar's system gives; one it lacks falls back to reflectivity.
    this.root.querySelectorAll<HTMLButtonElement>('[data-product]').forEach(b => { b.hidden = !p.products.includes(b.dataset.product as Product) })
    if (!p.products.includes(this.product)) this.setProduct('Z')
    const fold = this.root.querySelector<HTMLButtonElement>('[data-seg="fold"] button[data-value="1"]')
    if (fold) fold.textContent = `±${p.nyquist}`
  }

  /** Binds the display to a (new) model, keeping the site and tilt where possible. */
  attach(model: AtmosphereModel, stormMotion: readonly [number, number]) {
    this.motion = stormMotion
    const { width, depth } = model.grid, old = this.ppi
    this.ppi = new PPI(model, Math.round(width / PIXEL), Math.round(depth / PIXEL))
    if (old) { this.ppi.site = old.site; this.ppi.tilt = old.tilt }
    this.ppi.setProfile(RADARS[this.radar]); this.ppi.attenuate = this.attenuate; this.ppi.mie = this.mie; this.ppi.clutter = this.clutter; this.ppi.filtered = this.filtered
    // A section line kept from a larger domain does not fit this one.
    const inside = (p: Point | null) => !!p && p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= depth
    if (!inside(this.xs.a) || !inside(this.xs.b)) { this.xs.a = this.xs.b = null; this.cut = null }
    this.applyBins()
    this.raster.width = this.ppi.w; this.raster.height = this.ppi.h; this.image = this.rasterCtx.createImageData(this.ppi.w, this.ppi.h)
    this.lastTime = -1; this.lastComposite = 0; this.scanTime = -1; this.detector = new MesocycloneDetector(); this.detections = []; this.vad = []; this.markTilt(); this.markSection()
  }

  toggle(open = !this.open) {
    this.open = open; this.root.hidden = !open
    if (!open) { this.picking = null; this.drag = null }
    if (open) { if (this.xs.on && !this.xs.b) this.aimAtStrongest(); this.markSection(); this.refresh(true) }
  }

  /** The kind of values on the map (which palette the side panel shows) and on the section. */
  private kind(): PaletteKind { return PRODUCTS[this.product].kind }
  private xsKind(): PaletteKind { return XS_FIELDS[this.xs.field].kind }
  private static dual(k: PaletteKind) { return k === 'ZDR' || k === 'RHO' || k === 'KDP' }

  /** Called every frame: rescans after new model time, at most ~5 times a second (the composite, 14 tilts, once a second). */
  refresh(force = false) {
    const ppi = this.ppi
    if (!this.open || !ppi) return
    const now = performance.now(), time = ppi.model.time, every = VOLUME.includes(this.product) ? 1000 : 200
    if (!force && (time === this.lastTime || now - (VOLUME.includes(this.product) ? this.lastComposite : this.lastDraw) < every)) return
    this.lastTime = time; this.lastDraw = now
    ppi.stormMotion = this.product === 'SRV' ? this.motion : null
    ppi.dual = RadarPanel.dual(this.kind()) || (this.xs.on && RadarPanel.dual(this.xsKind()))
    if (VOLUME.includes(this.product)) { ppi.composite(); this.lastComposite = now; if (this.product === 'MAP') this.levels = ppi.phenomena(Math.hypot(...this.motion), this.detections.flatMap(d => d.hook ? [d.hook] : [])) } else ppi.sample()
    this.cutSection()
    // New model time (or a new radar site): rescan, at most every MDA_EVERY ms. The detection's prepare() leaves the
    // dual-polarisation nodes as they are (it needs only Z and V).
    if (this.scanTime < 0 || (time !== this.scanTime && now - this.lastScan >= MDA_EVERY)) { ppi.dual = false; this.detections = this.detector.scan(ppi, time, this.motion); this.vad = ppi.vad(); this.lastScan = now; this.scanTime = time; this.listMda(); this.listVad() }
    this.paint(); this.draw()
    const s = Math.floor(time); this.root.querySelector<HTMLElement>('#radarTime')!.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }

  /** The section along the line from the nodes the last scan prepared, and its raster; none without a line. */
  private cutSection() {
    const ppi = this.ppi, { a, b } = this.xs
    const length = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0
    if (!ppi || !this.xs.on || !a || !b || length < XS_MIN) { this.cut = null; return }
    const gates = Math.max(16, Math.ceil(length / XS_STEP)), rows = Math.ceil(Math.min(ppi.model.grid.height, XS_TOP) / XS_DZ)
    ppi.stormMotion = this.xs.field === 'SRV' ? this.motion : null
    ppi.dual = RadarPanel.dual(this.xsKind())
    this.cut = { ...ppi.crossSection(a, b, gates, XS_DZ, rows), gates, rows, length }
    this.paintSection()
  }

  /** Shows or hides the section (with no line yet: from the radar through the strongest echo). */
  private showSection(on: boolean) {
    this.xs.on = on
    if (!on) this.picking = null
    if (on && !(this.xs.a && this.xs.b)) { this.aimAtStrongest(); return }
    this.saveSection(); this.markSection(); this.showHelp(); this.refresh(true)
  }

  /** Waits for taps on the map: the two ends of a new line, or the point the line from the radar goes through. */
  private pick(mode: 'a' | 'radial' | null) {
    this.picking = mode
    if (mode === 'a') this.cut = null
    this.markSection(); this.draw()
  }

  private tap(g: Point) {
    if (this.picking === 'radial') { this.picking = null; this.radialThrough(g); return }
    if (this.picking === 'a') { this.xs.a = g; this.xs.b = null; this.picking = 'b'; this.markSection(); this.draw(); return }
    const a = this.xs.a!
    if (Math.hypot(g.x - a.x, g.y - a.y) < XS_MIN) return
    this.picking = null; this.setLine(a, g)
  }

  private setLine(a: Point, b: Point) {
    this.xs.a = a; this.xs.b = b; this.xs.on = true
    this.saveSection(); this.markSection(); this.showHelp(); this.refresh(true)
  }

  /** The line from the radar through a point to the edge of the domain: the RHI of a real radar. */
  private radialThrough(p: Point) {
    const ppi = this.ppi
    if (!ppi) return
    const { width, depth } = ppi.model.grid, s = ppi.site, d = Math.hypot(p.x - s.x, p.y - s.y)
    const ux = d > 1 ? (p.x - s.x) / d : 1, uy = d > 1 ? (p.y - s.y) / d : 0
    const tx = ux > 1e-9 ? (width - s.x) / ux : ux < -1e-9 ? -s.x / ux : Infinity, ty = uy > 1e-9 ? (depth - s.y) / uy : uy < -1e-9 ? -s.y / uy : Infinity
    const length = Math.max(XS_MIN, Math.min(tx, ty))
    this.setLine({ ...s }, { x: s.x + ux * length, y: s.y + uy * length })
  }

  /** The section from the radar through the strongest echo of the volume scan. */
  private aimAtStrongest() {
    const ppi = this.ppi
    if (!ppi) return
    ppi.composite()
    let best = 0
    for (let i = 1; i < ppi.compositeDbz.length; i++) if (ppi.compositeDbz[i] > ppi.compositeDbz[best]) best = i
    this.radialThrough(ppi.compositeDbz[best] > DBZ_FLOOR + 1 ? ppi.ground(best % ppi.w, Math.floor(best / ppi.w)) : { x: ppi.site.x + 1000, y: ppi.site.y })
  }

  private saveSection() { try { localStorage.setItem(XS_STORE, JSON.stringify(this.xs)) } catch { /* not kept */ } }

  /** The section's controls, its line in the bar, and the taller screen while it is shown. */
  private markSection() {
    const { on, a, b, field } = this.xs, $ = <T extends Element = HTMLElement>(s: string) => this.root.querySelector<T>(s)!
    $<HTMLInputElement>('#xsShow').checked = on
    press(this.root.querySelectorAll<HTMLButtonElement>('[data-seg="xs"] button'), x => x.dataset.value === field)
    $('#xsDraw').setAttribute('aria-pressed', String(this.picking === 'a' || this.picking === 'b'))
    $('#xsRadial').setAttribute('aria-pressed', String(this.picking === 'radial'))
    const length = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0, azimuth = a && b ? (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360 : 0
    $('#radarCut').textContent = on && length ? `${(length / 1000).toFixed(0)} ${L('КМ', 'KM')} · ${azimuth.toFixed(0)}°` : L('НЕТ', 'NONE')
    $('#xsInfo').textContent = this.picking === 'a' ? L('Щёлкните или коснитесь карты: начало разреза A', 'Click or tap the map: the section’s start A')
      : this.picking === 'b' ? L('Теперь конец разреза B', 'Now the section’s end B')
        : this.picking === 'radial' ? L('Щёлкните или коснитесь карты: разрез пойдёт от радара через эту точку до края области', 'Click or tap the map: the section will run from the radar through that point to the domain’s edge')
          : length ? L(`Линия A → B: ${(length / 1000).toFixed(1)} км, направление ${this.azimuthText(azimuth)}`, `Line A → B: ${(length / 1000).toFixed(1)} km, heading ${this.azimuthText(azimuth)}`) : L('Линии пока нет', 'No line yet')
    this.root.classList.toggle('is-section', on)
  }

  private setTilt(tilt: number) { if (!this.ppi) return; this.ppi.tilt = tilt; if (VOLUME.includes(this.product)) this.setProduct('Z'); this.markTilt(); this.refresh(true) }

  private setProduct(product: Product) {
    this.product = product
    // The section shows the same kind of product as the map unless chosen otherwise (the composite: reflectivity).
    this.xs.field = VOLUME.includes(product) ? 'Z' : product as XsField
    press(this.root.querySelectorAll<HTMLButtonElement>('[data-product]'), b => b.dataset.product === product)
    this.root.querySelector<HTMLElement>('#radarProduct')!.textContent = PRODUCTS[product].title
    this.root.querySelector<HTMLElement>('#radarProductLabel')!.textContent = PRODUCTS[product].label
    this.showHelp(); this.showPalette(); this.markSection()
    this.markTilt(); this.applyBins(); this.lastComposite = 0; this.refresh(true)
  }

  private showHelp() {
    const product = this.product
    this.root.querySelector<HTMLElement>('#radarHelp')!.textContent = (product === 'SRV'
      ? L(`То же, что V, но за вычетом движения грозы (по Банкерсу: ${Math.hypot(...this.motion).toFixed(0)} м/с на ${((Math.atan2(this.motion[0], this.motion[1]) * 180 / Math.PI + 360) % 360).toFixed(0)}°). Мезоциклон — пара «зелёное рядом с красным» поперёк луча на высоте 1–6 км.`, `The same as V, but with the storm’s motion taken out (Bunkers: ${Math.hypot(...this.motion).toFixed(0)} m/s towards ${((Math.atan2(this.motion[0], this.motion[1]) * 180 / Math.PI + 360) % 360).toFixed(0)}°). A mesocyclone is a “green next to red” pair across the beam at 1–6 km.`)
      : HELP[product]) + (this.xs.on ? ` ${XS_HELP}` : '')
  }

  /** The chosen palette of the map's kind: its colour bar, ticks and the palette list. */
  private showPalette() {
    const kind = this.kind(), k = KINDS[kind], palette = this.palettes.chosen(kind), map = this.product === 'MAP'
    this.root.querySelector<HTMLElement>('#radarColorbar')!.hidden = map; this.root.querySelector<HTMLElement>('#radarPhenomena')!.hidden = !map
    this.root.querySelector<HTMLElement>('#radarUnits')!.textContent = k.units
    this.root.querySelector<HTMLElement>('#paletteLabel')!.textContent = `${L('Палитра', 'Palette')} · ${k.label}`
    const range = extent(palette)
    this.root.querySelector<HTMLElement>('#radarLegend')!.style.background = cssGradient(palette, range)
    const values = ticks(range), at = (v: number) => (v - range[0]) / (range[1] - range[0]) * 100
    this.root.querySelector<HTMLElement>('#radarTicks')!.innerHTML = values.map(v => `<span style="position:absolute;left:${at(v)}%;transform:translateX(-${at(v)}%)">${fmt(v, k.digits)}</span>`).join('')
    const select = this.root.querySelector<HTMLSelectElement>('#paletteSelect')!, all = this.palettes.all(kind)
    const options = (list: Palette[]) => list.map(p => `<option value="${p.id}">${p.name.replace(/[<>&"]/g, c => `&#${c.charCodeAt(0)};`)}</option>`).join('')
    const own = all.filter(p => !p.builtin)
    select.innerHTML = `<optgroup label="${L('Готовые', 'Built-in')}">${options(all.filter(p => p.builtin))}</optgroup>${own.length ? `<optgroup label="${L('Свои', 'Your own')}">${options(own)}</optgroup>` : ''}`
    select.value = palette.id
    const del = this.root.querySelector<HTMLButtonElement>('#paletteDelete')!
    del.hidden = !!palette.builtin; del.textContent = DELETE; this.deleteArmed = 0
    this.paint(); this.paintSection(); this.draw()
  }

  /** The tilts of the chosen product: the velocity's where the radar scans it apart (DMRL-C), the reflectivity's otherwise. */
  private productTilts() { const p = RADARS[this.radar]; return this.product === 'V' || this.product === 'SRV' ? p.velocityTilts ?? p.tilts : p.tilts }

  private markTilt() {
    const tilts = this.productTilts(), box = this.root.querySelector<HTMLElement>('#radarTilts')!, html = tilts.map(t => `<button data-tilt="${t}">${t.toFixed(1)}°</button>`).join('')
    if (box.innerHTML !== html) box.innerHTML = html
    if (this.ppi && !tilts.includes(this.ppi.tilt)) { const was = this.ppi.tilt; this.ppi.tilt = tilts.reduce((best, x) => Math.abs(x - was) < Math.abs(best - was) ? x : best) }
    const t = this.ppi?.tilt ?? tilts[0], all = VOLUME.includes(this.product)
    press(this.root.querySelectorAll<HTMLButtonElement>('[data-tilt]'), b => !all && Number(b.dataset.tilt) === t)
    this.root.querySelector<HTMLElement>('#radarTilt')!.textContent = all ? L('ВСЕ', 'ALL') : `${t.toFixed(1)}°`
  }

  /** The radial bins of the chosen beam width (or smooth pixels) on the scan. */
  private applyBins() {
    if (!this.ppi) return
    const p = RADARS[this.radar]
    const gate = this.product === 'V' || this.product === 'SRV' ? p.velocityGate ?? p.gate : p.gate
    this.ppi.bins = this.grid.beam ? { gate: Math.max(gate, PIXEL), beam: p.step } : null; this.ppi.layout(); this.lastComposite = 0
  }

  private showGrid() {
    const g = this.grid
    press(this.root.querySelectorAll<HTMLButtonElement>('[data-seg="beam"] button'), b => Number(b.dataset.value) === g.beam)
    press(this.root.querySelectorAll<HTMLButtonElement>('[data-seg="radials"] button'), b => Number(b.dataset.value) === g.radials)
    press(this.root.querySelectorAll<HTMLButtonElement>('[data-seg="rings"] button'), b => Number(b.dataset.value) === g.rings)
    press(this.root.querySelectorAll<HTMLButtonElement>('[data-seg="compass"] button'), b => (b.dataset.value === '1') === g.compass)
    this.root.querySelector<HTMLInputElement>('#gridLabels')!.checked = g.labels
  }

  private saveGrid() { try { localStorage.setItem(GRID_STORE, JSON.stringify(this.grid)) } catch { /* not kept */ } this.showGrid(); this.draw() }

  /** The values of the map's product (the PPI raster). */
  private values(): Float32Array | null {
    const ppi = this.ppi
    if (!ppi) return null
    if (this.product === 'V' && this.folding) return this.folded(ppi.velocity, 'map')
    return { Z: ppi.dbz, V: ppi.velocity, SRV: ppi.velocity, CR: ppi.compositeDbz, ZDR: ppi.zdr, RHO: ppi.rho, KDP: ppi.kdp, VIL: ppi.vil, ET: ppi.echoTop, MESH: ppi.mesh, VGO: ppi.vgo, MAP: ppi.compositeDbz }[this.product]
  }

  /** The values of the section's field. */
  private xsValues(): Float32Array | null {
    const s = this.cut
    if (s && this.xs.field === 'V' && this.folding) return this.folded(s.velocity, 'cut')
    return s ? { Z: s.dbz, V: s.velocity, SRV: s.velocity, ZDR: s.zdr, RHO: s.rho, KDP: s.kdp }[this.xs.field] : null
  }

  /** `values` folded at the chosen Nyquist velocity into the map's or the section's buffer. */
  private folded(values: Float32Array, into: 'map' | 'cut') {
    let out = into === 'map' ? this.foldedMap : this.foldedCut
    if (out.length !== values.length) { out = new Float32Array(values.length); if (into === 'map') this.foldedMap = out; else this.foldedCut = out }
    const n = RADARS[this.radar].nyquist
    for (let i = 0; i < values.length; i++) out[i] = fold(values[i], n)
    return out
  }

  /** The colour lookup of the chosen palette of a kind. */
  private lut(kind: PaletteKind) {
    const p = this.palettes.chosen(kind)
    let l = this.luts.get(p)
    if (!l) { l = lookup(p); this.luts.set(p, l) }
    return l
  }

  /** Colours `values` of `kind` into `data` (RGBA, pixel i at offset of(i)) through its palette; reflectivity at the noise floor stays empty. */
  private colour(values: Float32Array, kind: PaletteKind, data: Uint8ClampedArray, of: (i: number) => number) {
    const lut = this.lut(kind), floor = kind === 'Z'
    for (let i = 0; i < values.length; i++) {
      const v = values[i], o = of(i), k = floor && v <= DBZ_FLOOR + 1 ? -1 : lutIndex(kind, v)
      if (k < 0) { data[o + 3] = 0; continue }
      data[o] = lut[k * 4]; data[o + 1] = lut[k * 4 + 1]; data[o + 2] = lut[k * 4 + 2]; data[o + 3] = lut[k * 4 + 3]
    }
  }

  /** The product raster in its palette (no echo: transparent). */
  private paint() {
    if (!this.ppi || !this.image) return
    if (this.product === 'MAP') {
      const data = this.image.data, codes = this.ppi.codes
      for (let i = 0; i < codes.length; i++) data.set(PHEN_RGBA.get(codes[i]) ?? [0, 0, 0, 0], i * 4)
      this.rasterCtx.putImageData(this.image, 0, 0); return
    }
    const values = this.values()
    if (!values) return
    this.colour(values, this.kind(), this.image.data, i => i * 4)
    this.rasterCtx.putImageData(this.image, 0, 0)
  }

  /** The section raster: points across, rows from the top of the section down. */
  private paintSection() {
    const s = this.cut, values = this.xsValues()
    if (!s || !values) return
    if (this.xsRaster.width !== s.gates || this.xsRaster.height !== s.rows) { this.xsRaster.width = s.gates; this.xsRaster.height = s.rows }
    const image = this.xsCtx.createImageData(s.gates, s.rows)
    this.colour(values, this.xsKind(), image.data, i => ((s.rows - 1 - Math.floor(i / s.gates)) * s.gates + i % s.gates) * 4)
    this.xsCtx.putImageData(image, 0, 0)
  }

  /**
   * The canvas sized to its box, and where the map and the section go: the whole canvas for the map alone; with the
   * section, side by side on a wide screen, the section under the map otherwise.
   */
  private layout() {
    const box = this.canvas.parentElement!.getBoundingClientRect(), ratio = devicePixelRatio || 1, cw = Math.max(200, box.width), ch = Math.max(150, box.height)
    if (this.canvas.width !== Math.round(cw * ratio) || this.canvas.height !== Math.round(ch * ratio)) { this.canvas.width = Math.round(cw * ratio); this.canvas.height = Math.round(ch * ratio); this.canvas.style.width = `${cw}px`; this.canvas.style.height = `${ch}px` }
    if (!this.xs.on) return { ratio, map: { x: 0, y: 0, w: cw, h: ch }, sec: null }
    if (cw > ch * 1.5) { const w = Math.round(cw * .45); return { ratio, map: { x: 0, y: 0, w, h: ch }, sec: { x: w, y: 0, w: cw - w, h: ch } } }
    const h = Math.round(ch * .5)
    return { ratio, map: { x: 0, y: 0, w: cw, h }, sec: { x: 0, y: h, w: cw, h: ch - h } }
  }

  /** The section plot rectangle in CSS pixels (null while the section is hidden). */
  private sectionBox() {
    const l = this.layout(), s = l.sec
    return s && { left: s.x + 52, top: s.y + 24, right: s.x + s.w - 20, bottom: s.y + s.h - 34, ratio: l.ratio }
  }

  /** The point of the section under the pointer: distance from A and height, m. */
  private toSection(e: { clientX: number; clientY: number }) {
    const s = this.cut, b = this.sectionBox()
    if (!s || !b) return null
    const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top
    if (x < b.left || x > b.right || y < b.top || y > b.bottom) return null
    return { d: (x - b.left) / (b.right - b.left) * s.length, h: (b.bottom - y) / (b.bottom - b.top) * s.rows * XS_DZ }
  }

  /** A value of a kind for the cursor readout. */
  private describe(v: number, kind: PaletteKind, inbound = '') {
    if (Number.isNaN(v) || (kind === 'Z' && v < 5)) return NO_ECHO
    if (kind === 'Z') return `${v.toFixed(0)} dBZ`
    if (kind === 'V') return `${v > 0 ? '+' : ''}${v.toFixed(1)} ${L('м/с', 'm/s')}${inbound && ` ${v > 0 ? L('(от радара)', '(outbound)') : L('(к радару)', '(inbound)')}`}`
    if (kind === 'ZDR') return `${v > 0 ? '+' : ''}${v.toFixed(2)} ${L('дБ', 'dB')}`
    if (kind === 'RHO') return v.toFixed(3)
    if (kind === 'VIL') return v < 1 ? NO_ECHO : `${v.toFixed(0)} ${L('кг/м²', 'kg/m²')}`
    if (kind === 'ET') return v <= 0 ? NO_ECHO : `${v.toFixed(1)} ${L('км', 'km')}`
    if (kind === 'MESH') return v < 1 ? L('нет града', 'no hail') : `${v.toFixed(0)} ${L('мм', 'mm')}`
    return `${v.toFixed(2)} ${L('°/км', '°/km')}`
  }

  /** Where the map cursor falls on the line, m from A, if it is within 2 km of it. */
  private onLine(p: Point | null) {
    const { a, b } = this.xs
    if (!p || !a || !b || !this.cut) return null
    const ex = b.x - a.x, ey = b.y - a.y, length = Math.hypot(ex, ey), t = ((p.x - a.x) * ex + (p.y - a.y) * ey) / (length * length)
    if (t < 0 || t > 1) return null
    return Math.hypot(a.x + ex * t - p.x, a.y + ey * t - p.y) < 2000 ? t * length : null
  }

  private drawSection() {
    const s = this.cut, ctx = this.ctx, b = this.sectionBox()
    if (!b) return
    const pal = instrumentPalette(this.root)
    ctx.fillStyle = pal.bar; ctx.fillRect(b.left, b.top, b.right - b.left, b.bottom - b.top)
    ctx.font = `11px ${MONO}`; ctx.lineWidth = 1
    if (!s) { ctx.fillStyle = pal.label; ctx.fillText(this.picking ? L('Отметьте точки на карте', 'Mark the points on the map') : L('Проведите линию разреза на карте', 'Draw a section line on the map'), b.left + 10, b.top + 20); ctx.strokeStyle = pal.gridStrong; ctx.strokeRect(b.left, b.top, b.right - b.left, b.bottom - b.top); return }
    const length = s.length, top = s.rows * XS_DZ, X = (d: number) => b.left + d / length * (b.right - b.left), Y = (h: number) => b.bottom - h / top * (b.bottom - b.top)
    const at = (g: number) => (g + .5) / s.gates * length
    ctx.imageSmoothingEnabled = false; ctx.drawImage(this.xsRaster, b.left, b.top, b.right - b.left, b.bottom - b.top)
    // Grid: distance from A every 5 km (10 on a long line), height every 2 km.
    ctx.strokeStyle = pal.grid; ctx.fillStyle = pal.label
    const every = length > 60_000 ? 10 : 5
    for (let km = 0; km * 1000 <= length; km += every) { ctx.beginPath(); ctx.moveTo(X(km * 1000), b.top); ctx.lineTo(X(km * 1000), b.bottom); ctx.stroke(); ctx.fillText(`${km}`, X(km * 1000) - 4, b.bottom + 14) }
    for (let km = 0; km * 1000 <= top; km += 2) { ctx.beginPath(); ctx.moveTo(b.left, Y(km * 1000)); ctx.lineTo(b.right, Y(km * 1000)); ctx.stroke(); ctx.fillText(`${km}`, b.left - 22, Y(km * 1000) + 3) }
    ctx.fillText('A', b.left - 4, b.bottom + 27); ctx.fillText('B', b.right - 4, b.bottom + 27); ctx.fillText(L('от A, км', 'from A, km'), b.right - 80, b.bottom + 27)
    ctx.save(); ctx.translate(b.left - 38, b.top + 70); ctx.rotate(-Math.PI / 2); ctx.fillText(L('высота, км', 'height, km'), 0, 0); ctx.restore()
    ctx.save(); ctx.beginPath(); ctx.rect(b.left, b.top, b.right - b.left, b.bottom - b.top); ctx.clip()
    // The beams of the volume scan where they cross the line (arcs, unless the line goes through the radar).
    ctx.strokeStyle = 'rgba(232, 240, 242, .22)'
    for (const beam of s.beams) { ctx.beginPath(); for (let g = 0; g < s.gates; g++) { const x = X(at(g)), y = Y(beam[g]); if (g) ctx.lineTo(x, y); else ctx.moveTo(x, y) } ctx.stroke() }
    // The isotherms, dashed, labelled at their first point.
    ctx.lineWidth = 1.5; ctx.setLineDash([7, 5])
    for (const [line, colour, name] of [[s.iso0, ISO_0, '0 °C'], [s.iso20, ISO_20, '−20 °C']] as const) {
      ctx.strokeStyle = colour; ctx.beginPath()
      let first = -1
      for (let g = 0, pen = false; g < s.gates; g++) { const h = line[g]; if (Number.isNaN(h)) { pen = false; continue } if (first < 0) first = g; if (pen) ctx.lineTo(X(at(g)), Y(h)); else ctx.moveTo(X(at(g)), Y(h)); pen = true }
      ctx.stroke()
      if (first >= 0) { ctx.fillStyle = colour; ctx.fillText(name, X(at(first)) + 4, Y(line[first]) - 5) }
    }
    ctx.setLineDash([]); ctx.lineWidth = 1
    ctx.restore()
    ctx.strokeStyle = pal.gridStrong; ctx.strokeRect(b.left, b.top, b.right - b.left, b.bottom - b.top)
    // The caption, shorter on a narrow screen.
    const caption = [`A → B · ${(length / 1000).toFixed(1)} ${L('км', 'km')}`, XS_FIELDS[this.xs.field].name, `${L('масштаб по вертикали', 'vertical scale')} ×${((length / (b.right - b.left)) / (top / (b.bottom - b.top))).toFixed(1)}`]
    while (caption.length > 1 && ctx.measureText(caption.join(' · ')).width > b.right - b.left) caption.pop()
    ctx.fillStyle = pal.label; ctx.fillText(caption.join(' · '), b.left + 6, b.top - 8)
    // The cursor: on the section itself, or where the map's cursor falls on the line.
    const hv = this.xsHover, d = hv ? hv.d : this.onLine(this.hover)
    if (d === null) return
    ctx.strokeStyle = '#2f7d86'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(X(d), b.top); ctx.lineTo(X(d), b.bottom)
    if (hv) { ctx.moveTo(b.left, Y(hv.h)); ctx.lineTo(b.right, Y(hv.h)) }
    ctx.stroke(); ctx.setLineDash([])
  }

  /** Detections on the screen and in the list: mesocyclones, and the weaker circulations if asked for. */
  private shown() { return this.detections.filter(d => this.showWeak || d.strength !== 'circulation') }

  /**
   * The detections in the side panel, with a check against the model itself: the strongest updraft helicity (2-5 km)
   * within 5 km, which the radar cannot see but the model knows.
   */
  /** The VAD winds as a table: height, direction the wind comes from and speed. */
  private listVad() {
    const out = this.root.querySelector<HTMLElement>('#radarVadList')!
    if (!this.vad.length) { out.innerHTML = `<span class="t-caption">${L('нет: по кольцу мало эха', 'none: too little echo around the ring')}</span>`; return }
    out.innerHTML = `<span class="t-caption">${L('кольцо', 'ring')} ${(this.vad[0].range / 1000).toFixed(0)} ${L('км', 'km')}</span>` + this.vad.map(w => {
      const from = (Math.atan2(-w.u, -w.v) * 180 / Math.PI + 360) % 360
      return `<div><b>${(w.height / 1000).toFixed(1)} ${L('км', 'km')}</b> ${from.toFixed(0).padStart(3, '0')}° · ${Math.hypot(w.u, w.v).toFixed(0)} ${L('м/с', 'm/s')} <span class="t-caption">RMS ${w.rms.toFixed(1)}</span></div>`
    }).join('')
  }

  private listMda() {
    const ppi = this.ppi!, m = ppi.model, { nx, ny, dx, dy, width, depth } = m.grid, [ox, oy] = m.frameOffset(), out = this.root.querySelector<HTMLElement>('#radarMdaList')!
    const shown = this.shown(), hidden = this.detections.length - shown.length
    if (!shown.length) { out.innerHTML = `<span class="t-caption">${hidden ? L(`мезоциклонов нет; слабых циркуляций: ${hidden}`, `no mesocyclones; weak circulations: ${hidden}`) : L('вращения не найдено', 'no rotation found')}</span>`; return }
    out.innerHTML = shown.map(d => {
      let uh = 0
      // Model columns over the ground point (the domain may have moved; distances are periodic).
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (Math.hypot(wrap(x * dx + ox - d.x, width), wrap(y * dy + oy - d.y, depth)) < 5000) uh = Math.max(uh, m.uhColumn[x + nx * y])
      const age = Math.floor((m.time - d.born) / 60)
      return `<div class="mda mda--${d.strength}"><div class="mda__head"><span class="mda__id">M${d.id}</span><span class="mda__name">${MESO_STRENGTH[d.strength].name}</span></div>`
        + `<dl class="kv">${readings([['Vrot', L(`${d.vrot.toFixed(1)} м/с · у основания ${d.lowVrot.toFixed(1)}`, `${d.vrot.toFixed(1)} m/s · at the base ${d.lowVrot.toFixed(1)}`)], ['Ø', `${(d.diameter / 1000).toFixed(1)} ${L('км', 'km')}`], [L('ΔV луч–луч', 'ΔV beam–beam'), L(`${d.gateDv.toFixed(0)} м/с · TVS от ${TDA_LOW_DV} у земли и ${TDA_MAX_DV} в столбе`, `${d.gateDv.toFixed(0)} m/s · a TVS from ${TDA_LOW_DV} at the ground and ${TDA_MAX_DV} in the column`)], [L('слой', 'layer'), L(`${(d.base / 1000).toFixed(1)}–${(d.top / 1000).toFixed(1)} км · ${d.tilts} наклонов`, `${(d.base / 1000).toFixed(1)}–${(d.top / 1000).toFixed(1)} km · ${d.tilts} tilts`)], [L('где', 'where'), `${this.azimuthText(d.azimuth)} / ${(d.range / 1000).toFixed(0)} ${L('км', 'km')} · ${age ? `${age} ${L('мин', 'min')}` : L('новый', 'new')}`]])}</dl>`
        + (d.tvs ? `<div class="mda__hook">${d.tvs.kind === 'TVS' ? L('<b>TVS</b> — вихревая сигнатура смерча', '<b>TVS</b> — tornadic vortex signature') : L('<b>ETVS</b> — приподнятая вихревая сигнатура', '<b>ETVS</b> — elevated vortex signature')}: ${L(`ΔV между соседними лучами ${d.tvs.lowDv.toFixed(0)} м/с у основания, до ${d.tvs.maxDv.toFixed(0)}; ${(d.tvs.base / 1000).toFixed(1)}–${(d.tvs.top / 1000).toFixed(1)} км. Сам смерч сетка не разрешает — это признак, как на настоящем радаре`, `ΔV between neighbouring beams ${d.tvs.lowDv.toFixed(0)} m/s at the base, up to ${d.tvs.maxDv.toFixed(0)}; ${(d.tvs.base / 1000).toFixed(1)}–${(d.tvs.top / 1000).toFixed(1)} km. The grid does not resolve the tornado itself — a sign, as on a real radar`)}</div>` : '')
        + (d.hook ? `<div class="mda__hook">${L('<b>КРЮК</b> — эхо обвивает вращение на 0,5°, вырез притока справа от движения', '<b>HOOK</b> — the echo wraps around the rotation at 0.5°, an inflow notch to the right of the motion')}</div>` : '')
        + `<div class="mda__model">${L('в модели рядом', 'in the model nearby')}: UH ${uh.toFixed(0)} ${L('м²/с²', 'm²/s²')}</div></div>`
    }).join('')
  }

  private azimuthText(azimuth: number) { return `${azimuth.toFixed(0)}°${this.grid.compass ? ` (${point(azimuth)})` : ''}` }

  /** Screen rectangle of the domain inside the map's part of the canvas (aspect kept). */
  private frame() {
    const ppi = this.ppi!, l = this.layout(), a = l.map, pad = l.sec ? 24 : 40
    const scale = Math.min((a.w - pad) / ppi.w, (a.h - pad) / ppi.h)
    return { x: a.x + (a.w - ppi.w * scale) / 2, y: a.y + (a.h - ppi.h * scale) / 2, scale, ratio: l.ratio }
  }

  /** The ground point under the pointer (null off the map; with `clamp`, the nearest point of the map). */
  private toGround(e: { clientX: number; clientY: number }, clamp = false) {
    if (!this.ppi) return null
    const f = this.frame(), r = this.canvas.getBoundingClientRect()
    let px = (e.clientX - r.left - f.x) / f.scale, py = (e.clientY - r.top - f.y) / f.scale
    if (clamp) { px = Math.min(this.ppi.w, Math.max(0, px)); py = Math.min(this.ppi.h, Math.max(0, py)) }
    else if (px < 0 || py < 0 || px >= this.ppi.w || py >= this.ppi.h) return null
    const { width, depth } = this.ppi.model.grid
    return { x: px / this.ppi.w * width, y: depth - py / this.ppi.h * depth }
  }

  /** The screen position (CSS pixels in the canvas) of a ground point. */
  private toScreen(p: Point) {
    const ppi = this.ppi!, f = this.frame(), { width, depth } = ppi.model.grid
    return [f.x + p.x / width * ppi.w * f.scale, f.y + (depth - p.y) / depth * ppi.h * f.scale] as const
  }

  /** The end of the shown line under a pointer (client coordinates), if any. */
  private handleAt(clientX: number, clientY: number) {
    const { on, a, b } = this.xs
    if (!on || !a || !b || !this.ppi || this.root.hidden) return null
    const r = this.canvas.getBoundingClientRect(), x = clientX - r.left, y = clientY - r.top
    const near = (p: Point) => { const [sx, sy] = this.toScreen(p); return Math.hypot(sx - x, sy - y) }
    const da = near(a), db = near(b)
    return Math.min(da, db) > HANDLE ? null : da <= db ? 'a' as const : 'b' as const
  }

  private pointerDown(e: PointerEvent) {
    const g = this.toGround(e)
    if (!this.ppi) return
    if (this.picking) { if (g) this.tap(g); return }
    const end = this.handleAt(e.clientX, e.clientY)
    if (!g && !end) return
    const kind = end ?? (e.shiftKey ? 'new' : 'press')
    this.drag = { kind, from: g ?? this.toGround(e, true)!, sx: e.clientX, sy: e.clientY }
    if (kind === 'press') return
    this.canvas.setPointerCapture(e.pointerId)
    if (kind === 'new') { this.xs.a = g; this.xs.b = g }
  }

  private pointerMove(e: PointerEvent) {
    const d = this.drag
    if (d && d.kind !== 'press') {
      const g = this.toGround(e, true)
      if (!g) return
      if (d.kind === 'a') this.xs.a = g; else this.xs.b = g
      this.hover = g; this.xsHover = null
      this.cutSection(); this.markSection(); this.draw()
      return
    }
    this.xsHover = this.toSection(e); this.hover = this.xsHover ? null : this.toGround(e); this.draw()
  }

  private pointerUp(e: PointerEvent) {
    const d = this.drag
    this.drag = null
    if (!d || !this.ppi) return
    const moved = Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 6
    if (d.kind === 'press') {
      // A click: the radar moves there.
      if (moved) return
      this.ppi.site = d.from; this.ppi.layout(); this.lastComposite = 0; this.scanTime = -1; this.refresh(true)
      return
    }
    if (d.kind === 'new' && !moved) { this.radialThrough(d.from); return }
    const { a, b } = this.xs
    if (a && b && Math.hypot(b.x - a.x, b.y - a.y) < XS_MIN) { this.radialThrough(b); return }
    this.setLine(a!, b!)
  }

  /** The map: the product, the grid, the section's line with its ends, the detections. */
  private drawMap() {
    const ppi = this.ppi!, { width } = ppi.model.grid, f = this.frame(), ctx = this.ctx
    const pal = instrumentPalette(this.root), box = { x: f.x, y: f.y, w: ppi.w * f.scale, h: ppi.h * f.scale }
    ctx.fillStyle = pal.bar; ctx.fillRect(box.x, box.y, box.w, box.h)
    ctx.imageSmoothingEnabled = false; ctx.drawImage(this.raster, box.x, box.y, box.w, box.h)
    ctx.save(); ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip()
    const [sx, sy] = this.toScreen(ppi.site), kmPx = box.w / (width / 1000)
    this.drawGrid(sx, sy, kmPx, box)
    ctx.restore()
    ctx.strokeStyle = pal.gridStrong; ctx.strokeRect(box.x, box.y, box.w, box.h)
    ctx.fillStyle = '#e8f0f2'; ctx.beginPath(); ctx.arc(sx, sy, 3.5, 0, Math.PI * 2); ctx.fill()
    ctx.font = `11px ${MONO}`
    if (!this.grid.labels) ctx.fillText('N ▲', box.x + box.w - 34, box.y + 16)
    // VAD winds: an arrow from the radar per height, 500 m on the map per m/s, coloured from low (warm) to high (cool).
    if (this.showVad && this.ppi) {
      const site = this.ppi.site, top = Math.max(1, ...this.vad.map(w => w.height))
      for (const w of this.vad) {
        const [ex, ey] = this.toScreen({ x: site.x + w.u * 500, y: site.y + w.v * 500 }), a = Math.atan2(ey - sy, ex - sx)
        ctx.strokeStyle = ctx.fillStyle = `hsl(${(30 + 200 * w.height / top).toFixed(0)} 90% 60%)`; ctx.lineWidth = 2
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - 8 * Math.cos(a - .4), ey - 8 * Math.sin(a - .4)); ctx.lineTo(ex - 8 * Math.cos(a + .4), ey - 8 * Math.sin(a + .4)); ctx.closePath(); ctx.fill()
        ctx.fillText(`${(w.height / 1000).toFixed(1)}`, ex + 4, ey - 4)
      }
    }
    // MDA detections: a circle of the circulation's diameter (at least 3 km, to stay visible), coloured by strength.
    if (this.showMda) for (const d of this.shown()) {
      const [cx, cy] = this.toScreen(d), r = Math.max(1.5, d.diameter / 2000) * kmPx, color = pal.meso[d.strength]
      ctx.strokeStyle = color; ctx.lineWidth = d.strength === 'circulation' ? 1.5 : 2.5; ctx.setLineDash(d.strength === 'circulation' ? [4, 3] : [])
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = color; ctx.fillText(`M${d.id}`, cx + r * .75 + 3, cy - r * .75 - 3)
      if (d.tvs) {
        // The TVS mark as on NWS radar displays: an inverted triangle at the circulation, red, an elevated one hollow.
        const t = 9
        ctx.beginPath(); ctx.moveTo(cx - t, cy - t * .8); ctx.lineTo(cx + t, cy - t * .8); ctx.lineTo(cx, cy + t * .9); ctx.closePath()
        ctx.lineWidth = 2.5; ctx.strokeStyle = '#ff3b3b'; ctx.fillStyle = '#ff3b3b'
        if (d.tvs.kind === 'TVS') ctx.fill(); else ctx.stroke()
        ctx.fillText(d.tvs.kind, cx + t + 4, cy + 4)
      }
      if (!d.hook) continue
      // The hook: the arc of echo wrapped around the circulation (azimuths clockwise from north; canvas angles from east).
      const h = d.hook, a0 = (h.from - 90) * Math.PI / 180, a1 = (h.from + h.span - 90) * Math.PI / 180
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.arc(cx, cy, h.radius / 1000 * kmPx, a0, a1); ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = '#ffffff'; ctx.fillText(L('КРЮК', 'HOOK'), cx - r * .75 - 40, cy + r * .75 + 12)
    }
    ctx.lineWidth = 1
    this.drawLine(kmPx)
  }

  /** The section's line on the map: A → B with a tick every 5 km, round ends to drag, the section cursor's point. */
  private drawLine(kmPx: number) {
    const ctx = this.ctx, { a, b, on } = this.xs
    const end = (p: Point, name: string) => {
      const [x, y] = this.toScreen(p)
      ctx.fillStyle = 'rgba(11, 16, 19, .85)'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      ctx.fillStyle = '#ffffff'; ctx.font = `bold 10px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(name, x, y + .5)
      ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic'; ctx.font = `11px ${MONO}`
    }
    if (this.picking === 'b' && a) { end(a, 'A'); return }
    if (!(on || this.drag?.kind === 'new') || !a || !b) return
    const [ax, ay] = this.toScreen(a), [bx, by] = this.toScreen(b), length = Math.hypot(b.x - a.x, b.y - a.y)
    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(11, 16, 19, .7)'; ctx.lineWidth = 4.5; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
    if (length > 0) {
      const ux = (bx - ax) / Math.hypot(bx - ax, by - ay), uy = (by - ay) / Math.hypot(bx - ax, by - ay)
      ctx.lineWidth = 1.5; ctx.beginPath()
      for (let km = 5; km * 1000 < length; km += 5) { const x = ax + ux * km * kmPx, y = ay + uy * km * kmPx; ctx.moveTo(x - uy * 5, y + ux * 5); ctx.lineTo(x + uy * 5, y - ux * 5) }
      ctx.stroke()
    }
    ctx.lineCap = 'butt'
    end(a, 'A'); end(b, 'B')
    // The point of the line under the section's cursor.
    if (this.xsHover && length > 0) {
      const t = Math.min(1, Math.max(0, this.xsHover.d / length)), [x, y] = this.toScreen({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
      ctx.strokeStyle = '#2f7d86'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke()
    }
    ctx.lineWidth = 1
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
    const l = this.layout(), ctx = this.ctx
    ctx.setTransform(l.ratio, 0, 0, l.ratio, 0, 0)
    ctx.fillStyle = instrumentPalette(this.root).bg; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    this.drawMap()
    if (this.xs.on) this.drawSection()
    this.readout()
  }

  /** The cursor readout: the point of the section under it, or the map's. */
  private readout() {
    const ppi = this.ppi!, out = this.root.querySelector<HTMLElement>('#radarReadout')!, s = this.cut, hv = this.xsHover
    if (hv && s) {
      const g = Math.min(s.gates - 1, Math.floor(hv.d / s.length * s.gates)), k = Math.min(s.rows - 1, Math.floor(hv.h / XS_DZ)), i = k * s.gates + g, values = this.xsValues(), field = this.xs.field
      out.innerHTML = readings([[L('От A', 'From A'), `${(hv.d / 1000).toFixed(1)} ${L('км', 'km')}`], [L('Высота', 'Height'), `${(hv.h / 1000).toFixed(2)} ${L('км', 'km')}`], [L('До радара', 'To the radar'), `${(s.range[g] / 1000).toFixed(1)} ${L('км', 'km')}`],
        [L('Отражаемость', 'Reflectivity'), s.dbz[i] < 5 ? NO_ECHO : `${s.dbz[i].toFixed(0)} dBZ`], ...(field === 'Z' || !values ? [] : [[XS_FIELDS[field].reading, this.describe(values[i], this.xsKind(), 'in')] as [string, string]])])
      return
    }
    const values = this.values()
    if (!this.hover || !values) { out.innerHTML = readings([[L('курсор', 'cursor'), L('вне экрана', 'off the screen')]]); return }
    const { width, depth } = ppi.model.grid
    const b = ppi.beamAt(this.hover.x, this.hover.y), px = Math.min(ppi.w - 1, Math.floor(this.hover.x / width * ppi.w)), py = Math.min(ppi.h - 1, Math.floor((depth - this.hover.y) / depth * ppi.h)), i = px + py * ppi.w
    const kind = this.kind(), name = { Z: L('Отражаемость', 'Reflectivity'), V: L('Скорость', 'Velocity'), ZDR: 'ZDR', RHO: 'ρhv', KDP: 'KDP', VIL: 'VIL', ET: L('Высота эха', 'Echo top'), MESH: 'MESH' }[kind], volume = VOLUME.includes(this.product)
    out.innerHTML = readings([[L('Азимут', 'Azimuth'), this.azimuthText(b.azimuth)], [L('Дальность', 'Range'), `${(b.range / 1000).toFixed(1)} ${L('км', 'km')}`], ...(volume ? [] : [[L('Высота луча', 'Beam height'), `${(b.height / 1000).toFixed(2)} ${L('км', 'km')}`] as [string, string]]),
      ...(kind === 'Z' ? [] : [[volume ? L('Сильнейшее эхо', 'Strongest echo') : L('Отражаемость', 'Reflectivity'), (volume ? ppi.compositeDbz : ppi.dbz)[i] < 5 ? NO_ECHO : `${(volume ? ppi.compositeDbz : ppi.dbz)[i].toFixed(0)} dBZ`] as [string, string]]),
      // VIL density (VIL over the echo top): from ~3.5 g/m³ large hail is likely (Amburn & Wolf 1997).
      // Folded: what the wind really is there, to learn to see folding (a real radar would need dealiasing for it).
      ...(this.product === 'V' && this.folding && Math.abs(ppi.velocity[i]) > RADARS[this.radar].nyquist ? [[L('Без складывания', 'Unfolded'), this.describe(ppi.velocity[i], 'V')] as [string, string]] : []),
      ...(this.product === 'MAP' ? [[L('Явление', 'Phenomenon'), PHENOMENA.find(p => p.code === ppi.codes[i])?.name ?? '—'], [L('ВГО', 'Cloud top'), ppi.vgo[i] > 0 ? `${ppi.vgo[i].toFixed(1)} ${L('км', 'km')}` : NO_ECHO], ...(this.levels && ppi.vgo[i] > 0 && ppi.zh3[i] > 18 ? [[`Y = H·lgZ3 (${L('порог', 'threshold')} ${(this.levels.h22 * 1.2).toFixed(1)})`, (ppi.vgo[i] * (ppi.zh3[i] - 18) / 10).toFixed(1)]] : [])] as [string, string][] : []),
      ...(this.product === 'VGO' || this.product === 'MAP' ? ([['Z1 (0,6–1 км)', ppi.z1[i]], ['Z2 (2–4 км)', ppi.z2[i]], [`Z(H2 = ${(ppi.levelH2 / 1000).toFixed(1)} ${L('км', 'km')})`, ppi.zh2[i]], [`Z(H3 = ${(ppi.levelH3 / 1000).toFixed(1)} ${L('км', 'km')})`, ppi.zh3[i]], [L('Zmax выше 1 км', 'Zmax above 1 km'), ppi.zmax[i]]] as [string, number][]).map(([k, d]) => [L(k, k.replace(',', '.').replace('км', 'km')), d < 5 ? NO_ECHO : `${d.toFixed(0)} dBZ`] as [string, string]) : []),
      ...(this.product === 'VIL' && ppi.vil[i] >= 1 && ppi.echoTop[i] > 0 ? [[L('Плотность VIL', 'VIL density'), `${(ppi.vil[i] / ppi.echoTop[i]).toFixed(1)} ${L('г/м³', 'g/m³')}`] as [string, string]] : []), [name, this.product === 'ET' && ppi.echoTopped[i] ? L(`≥ ${this.describe(values[i], kind)}: верх не виден, выше верхнего наклона`, `≥ ${this.describe(values[i], kind)}: the top is not seen, above the highest tilt`) : this.describe(values[i], kind, 'in')]])
  }

  // ---- The palette editor: a copy of the chosen palette as rows "value · colour · what follows", previewed live.

  private edit() {
    const p = this.palettes.chosen(this.kind())
    this.editing = { id: p.builtin ? undefined : p.id, name: p.builtin ? `${p.name} — ${L('своя', 'own')}` : p.name, kind: p.kind, stops: p.stops.map(s => ({ ...s })) }
    const $ = <T extends Element = HTMLElement>(s: string) => this.root.querySelector<T>(s)!
    $('#palKind').textContent = KINDS[p.kind].label; $('#palUnits').textContent = KINDS[p.kind].units || L('без единиц', 'no units')
    $('#palBelow').textContent = KINDS[p.kind].clampBelow ? L('Скорость ниже первой точки — цветом первой.', 'Velocities below the first point take its colour.') : L('Ниже первой точки эха не видно.', 'Below the first point no echo is shown.')
    $<HTMLInputElement>('#palName').value = this.editing.name
    this.editorRows()
    $<HTMLDialogElement>('#paletteEditor').showModal()
  }

  private editorRows() {
    const e = this.editing!, step = KINDS[e.kind].digits ? 10 ** -KINDS[e.kind].digits : 1
    e.stops.sort((a, b) => a.value - b.value)
    this.root.querySelector<HTMLElement>('#palRows')!.innerHTML = e.stops.map((s, i) => `<div class="pal-row" data-row="${i}">
      <input class="input" type="number" step="${step}" value="${s.value}" data-field="value" aria-label="${L('Значение', 'Value')}">
      <input class="pal-color" type="color" value="${toHex(s.color)}" data-field="color" aria-label="${L('Цвет', 'Colour')}"${s.color ? '' : ' disabled'}>
      <span class="select"><select data-field="mode" aria-label="${L('Что дальше', 'What next')}"><option value="smooth"${!s.solid && s.color ? ' selected' : ''}>${L('плавно', 'smooth')}</option><option value="solid"${s.solid && s.color ? ' selected' : ''}>${L('ступень', 'step')}</option><option value="none"${s.color ? '' : ' selected'}>${L('пусто', 'empty')}</option></select></span>
      <button type="button" class="btn btn--quiet btn--xs" data-remove="${i}" title="${L('Убрать точку', 'Remove the point')}">×</button></div>`).join('')
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
    this.palettes.put(e); this.luts.clear()
    this.note(L(`Палитра «${e.name.trim() || 'Своя'}» сохранена в этом браузере`, `Palette “${e.name.trim() || 'Own'}” saved in this browser`))
    this.showPalette()
  }

  private importPal(input: HTMLInputElement) {
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    file.text().then(text => {
      const parsed = parsePal(text, this.kind(), file.name.replace(/\.[^.]+$/, ''))
      const saved = this.palettes.put(parsed); this.luts.clear()
      this.note(saved.kind === this.kind() ? L(`Палитра «${saved.name}» загружена: ${saved.stops.length} точек`, `Palette “${saved.name}” loaded: ${saved.stops.length} points`) : L(`Палитра «${saved.name}» загружена для продукта ${KINDS[saved.kind].label} — она появится там`, `Palette “${saved.name}” loaded for the ${KINDS[saved.kind].label} product — it will appear there`))
      this.showPalette()
    }).catch((err: Error) => this.note(`${L('Не удалось прочитать файл', 'Could not read the file')}: ${err.message}`))
  }

  private deletePalette() {
    const p = this.palettes.chosen(this.kind()), button = this.root.querySelector<HTMLButtonElement>('#paletteDelete')!
    if (p.builtin) return
    // A second click within 4 s deletes (no browser dialog over the instrument).
    if (performance.now() - this.deleteArmed > 4000) { this.deleteArmed = performance.now(); button.textContent = L('Точно удалить?', 'Really delete?'); setTimeout(() => { if (performance.now() - this.deleteArmed >= 4000) button.textContent = DELETE }, 4100); return }
    this.palettes.remove(p.id); this.luts.clear(); this.note(L(`Палитра «${p.name}» удалена`, `Palette “${p.name}” deleted`)); this.showPalette()
  }

  private note(text: string) { this.root.querySelector<HTMLElement>('#paletteNote')!.textContent = text }
}

