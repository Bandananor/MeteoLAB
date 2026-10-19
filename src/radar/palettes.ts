import { L } from '../i18n'
// Radar colour palettes: the built-in ones of every product, the user's own (kept in the browser), and the .pal text
// format the hobby radar programs (GRLevelX and its followers) use and their users share: one stop per line,
// "Color: value R G B [R G B]" (a gradient from this stop, to the second colour or to the next stop's colour),
// "SolidColor: value R G B" (one colour up to the next stop), Color4 / SolidColor4 with an alpha, "Product:", "Units:",
// "Scale:" and "Offset:" (file value = value x Scale + Offset), comments after ";".

/** What a palette colours: reflectivity (Z, CR, the section), radial velocity (V, SRV), ZDR, rho_hv, KDP. */
export type PaletteKind = 'Z' | 'V' | 'ZDR' | 'RHO' | 'KDP'
export type RGB = readonly [number, number, number]
/** A stop: from `value` up, `color` (null: transparent); `solid` holds it to the next stop, otherwise it blends to `to` or to the next stop's colour. */
export interface Stop { value: number; color: RGB | null; to?: RGB | null; solid?: boolean }
export interface Palette { id: string; name: string; kind: PaletteKind; stops: Stop[]; builtin?: boolean }

/**
 * Each kind's units, the range of its colour lookup (wide enough for imported palettes), the .pal product codes it
 * accepts (the first is written on export) and what it shows below the first stop: nothing, or the first colour
 * (velocity: every echo has some speed).
 */
export const KINDS: Record<PaletteKind, { label: string; units: string; palUnits: string; min: number; max: number; codes: string[]; clampBelow: boolean; digits: number }> = {
  Z: { label: L('Отражаемость (Z, CR)', 'Reflectivity (Z, CR)'), units: 'dBZ', palUnits: 'DBZ', min: -30, max: 90, codes: ['BR', 'CR', 'REF', 'DBZ', 'Z'], clampBelow: false, digits: 0 },
  V: { label: L('Скорость (V, SRV)', 'Velocity (V, SRV)'), units: L('м/с', 'm/s'), palUnits: 'MPS', min: -90, max: 90, codes: ['BV', 'SRV', 'VEL', 'V', 'SR'], clampBelow: true, digits: 0 },
  ZDR: { label: 'ZDR', units: L('дБ', 'dB'), palUnits: 'DB', min: -6, max: 10, codes: ['ZDR', 'DR'], clampBelow: false, digits: 1 },
  RHO: { label: 'ρhv (RHO, CC)', units: '', palUnits: 'NONE', min: 0, max: 1.1, codes: ['CC', 'RHO', 'RHOHV', 'PHV'], clampBelow: false, digits: 2 },
  KDP: { label: 'KDP', units: L('°/км', '°/km'), palUnits: 'DEG/KM', min: -4, max: 12, codes: ['KDP', 'KD'], clampBelow: false, digits: 1 },
}

const hex = (h: string): RGB => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16)) as unknown as RGB
const steps = (pairs: [number, string][]): Stop[] => pairs.map(([value, c]) => ({ value, color: hex(c), solid: true }))
const smooth = (pairs: [number, string][]): Stop[] => pairs.map(([value, c]) => ({ value, color: hex(c) }))
/** Viridis (perceptually uniform, readable with colour blindness) spread from a to b. */
const VIRIDIS = ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725']
const viridis = (a: number, b: number, top?: string): Stop[] => [...VIRIDIS, ...(top ? [top] : [])].map((c, i, all) => ({ value: a + (b - a) * i / (all.length - 1), color: hex(c) }))

export const BUILTIN: Palette[] = ([
  { id: 'z-nws', name: L('NWS (классическая)', 'NWS (classic)'), kind: 'Z', stops: steps([[5, '#04e9e7'], [10, '#019ff4'], [15, '#0300f4'], [20, '#02fd02'], [25, '#01c501'], [30, '#008e00'], [35, '#fdf802'], [40, '#e5bc00'], [45, '#fd9500'], [50, '#fd0000'], [55, '#d40000'], [60, '#bc0000'], [65, '#f800fd'], [70, '#9854c6'], [75, '#fdfdfd']]) },
  { id: 'z-dark', name: L('Тёмная плавная', 'Dark smooth'), kind: 'Z', stops: smooth([[5, '#27384a'], [15, '#3b6e96'], [20, '#2f9e5c'], [30, '#1a6b2c'], [35, '#e3d63a'], [45, '#ef8c1f'], [50, '#d9302b'], [60, '#8c0f30'], [65, '#e36ae0'], [70, '#9a62d8'], [75, '#ffffff']]) },
  { id: 'z-cvd', name: L('Для дальтоников (viridis)', 'Colour-blind friendly (viridis)'), kind: 'Z', stops: viridis(5, 65, '#ffffff') },
  { id: 'v-classic', name: L('Зелёный / красный', 'Green / red'), kind: 'V', stops: steps([[-40, '#00ffa6'], [-35, '#00e676'], [-30, '#00c85a'], [-25, '#00a845'], [-20, '#008c37'], [-15, '#00702b'], [-10, '#005521'], [-5, '#3d4f42'], [0, '#5a4646'], [5, '#701f1f'], [10, '#8c2424'], [15, '#aa2b2b'], [20, '#c83434'], [25, '#e54242'], [30, '#ff6060'], [35, '#ffa0a0']]) },
  { id: 'v-smooth', name: L('Плавная', 'Smooth'), kind: 'V', stops: smooth([[-40, '#b4ffd8'], [-25, '#13d36a'], [-10, '#0b6b34'], [-1, '#4a5a50'], [1, '#5c4646'], [10, '#8a1f24'], [25, '#e8393f'], [40, '#ffc4c4']]) },
  { id: 'v-cvd', name: L('Для дальтоников (синий / оранжевый)', 'Colour-blind friendly (blue / orange)'), kind: 'V', stops: smooth([[-40, '#c6dbef'], [-25, '#4292c6'], [-10, '#08306b'], [-1, '#4d4d4d'], [1, '#4d4d4d'], [10, '#7f2704'], [25, '#f16913'], [40, '#fdd0a2']]) },
  { id: 'zdr-classic', name: L('Классическая', 'Classic'), kind: 'ZDR', stops: smooth([[-2, '#3b3b8f'], [0, '#9b9b9b'], [.5, '#4ca7d8'], [1, '#2aa64a'], [1.5, '#a8d82a'], [2, '#f2e33a'], [3, '#f39b2a'], [4, '#e0302a'], [5, '#d22ad8'], [6, '#ffffff']]) },
  { id: 'zdr-cvd', name: L('Для дальтоников (viridis)', 'Colour-blind friendly (viridis)'), kind: 'ZDR', stops: viridis(-1, 5, '#ffffff') },
  { id: 'rho-classic', name: L('Классическая', 'Classic'), kind: 'RHO', stops: smooth([[.7, '#1b1b70'], [.8, '#3a6ad8'], [.85, '#2ab0c8'], [.9, '#46be4a'], [.93, '#dcd82a'], [.95, '#f0a02a'], [.97, '#e0302a'], [.99, '#a0206a'], [1, '#f2d2f2'], [1.05, '#ffffff']]) },
  { id: 'rho-cvd', name: L('Для дальтоников (viridis)', 'Colour-blind friendly (viridis)'), kind: 'RHO', stops: viridis(.7, 1, '#ffffff') },
  { id: 'kdp-classic', name: L('Классическая', 'Classic'), kind: 'KDP', stops: smooth([[-1, '#555555'], [0, '#9b9b9b'], [.5, '#4ca7d8'], [1, '#2aa64a'], [2, '#f2e33a'], [3, '#f39b2a'], [4, '#e0302a'], [6, '#d22ad8']]) },
  { id: 'kdp-cvd', name: L('Для дальтоников (viridis)', 'Colour-blind friendly (viridis)'), kind: 'KDP', stops: viridis(-.5, 5) },
] as Palette[]).map(p => ({ ...p, builtin: true }))

const sorted = (stops: readonly Stop[]) => [...stops].sort((a, b) => a.value - b.value)

/** The colour of value v (null: transparent), [r, g, b, alpha 0-255]. */
export function colorAt(palette: Palette, v: number): [number, number, number, number] | null {
  const stops = sorted(palette.stops)
  if (!stops.length || Number.isNaN(v)) return null
  let k = -1
  while (k + 1 < stops.length && stops[k + 1].value <= v) k++
  if (k < 0) { if (!KINDS[palette.kind].clampBelow || !stops[0].color) return null; return [...stops[0].color, 255] }
  const s = stops[k], next = stops[k + 1]
  if (!s.color) return null
  const target = s.to !== undefined ? s.to : next?.color
  if (s.solid || !next || !target) return [...s.color, 255]
  const f = (v - s.value) / (next.value - s.value)
  return [0, 1, 2].map(j => Math.round(s.color![j] + (target[j] - s.color![j]) * f)).concat(255) as [number, number, number, number]
}

/** Entries of a colour lookup over its kind's range. */
export const LUT_SIZE = 1024

/** RGBA lookup of LUT_SIZE entries over KINDS[kind].min..max (alpha 0: transparent). */
export function lookup(palette: Palette) {
  const { min, max } = KINDS[palette.kind], out = new Uint8ClampedArray(LUT_SIZE * 4)
  for (let k = 0; k < LUT_SIZE; k++) { const c = colorAt(palette, min + (max - min) * (k + .5) / LUT_SIZE); if (c) out.set(c, k * 4) }
  return out
}

/** Index into a lookup of `kind` for value v, or -1 for NaN. */
export function lutIndex(kind: PaletteKind, v: number) {
  if (Number.isNaN(v)) return -1
  const { min, max } = KINDS[kind]
  return Math.max(0, Math.min(LUT_SIZE - 1, Math.floor((v - min) / (max - min) * LUT_SIZE)))
}

/** The range the palette's stops cover (for its colour bar). */
export function extent(palette: Palette): [number, number] {
  const values = palette.stops.map(s => s.value), { min, max } = KINDS[palette.kind]
  if (values.length < 2) return [min, max]
  return [Math.min(...values), Math.max(...values)]
}

/** A CSS gradient of the palette over [a, b] (steps stay sharp: two colours at each step's edge). */
export function cssGradient(palette: Palette, [a, b] = extent(palette)) {
  const parts: string[] = [], n = 120, css = (c: ReturnType<typeof colorAt>) => c ? `rgb(${c[0]} ${c[1]} ${c[2]})` : 'transparent'
  for (let k = 0; k <= n; k++) { const v = a + (b - a) * k / n; parts.push(`${css(colorAt(palette, Math.min(v, b - 1e-9 * Math.abs(b - a))))} ${(k / n * 100).toFixed(2)}%`) }
  return `linear-gradient(90deg, ${parts.join(', ')})`
}

/** Tick values for a colour bar over [a, b]: the finest "nice" step (1, 2, 2.5, 5 x 10^n) giving at most 7 ticks. */
export function ticks([a, b]: [number, number]) {
  const base = 10 ** (Math.floor(Math.log10(b - a)) - 1)
  for (const step of [1, 2, 2.5, 5, 10, 20, 25, 50, 100].map(m => m * base)) {
    const out: number[] = []
    for (let k = Math.ceil(a / step - 1e-9); k * step <= b + 1e-9; k++) out.push(+(k * step).toPrecision(12))
    if (out.length <= 7) return out
  }
  return [a, b]
}

/** Reads a .pal file; throws an Error with a message for the user if it has no colours. `kind` is the fallback product. */
export function parsePal(text: string, fallback: PaletteKind, name = L('Импорт', 'Import')): Omit<Palette, 'id'> {
  let kind: PaletteKind = fallback, scale = 1, offset = 0, units = ''
  const raw: { value: number; color: RGB | null; to?: RGB | null; solid: boolean }[] = []
  const rgb = (n: number[], alpha: boolean): RGB | null => alpha && n[3] === 0 ? null : [n[0], n[1], n[2]].map(c => Math.max(0, Math.min(255, Math.round(c)))) as unknown as RGB
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/[;#].*$/, '').trim(), m = /^([A-Za-z0-9]+)\s*:\s*(.*)$/.exec(clean)
    if (!m) continue
    const key = m[1].toLowerCase(), rest = m[2].trim(), n = rest.split(/[\s,]+/).map(Number)
    if (key === 'product') { const code = rest.toUpperCase(); kind = (Object.keys(KINDS) as PaletteKind[]).find(k => KINDS[k].codes.includes(code)) ?? kind }
    else if (key === 'units') units = rest.toUpperCase()
    else if (key === 'scale' && n[0] > 0) scale = n[0]
    else if (key === 'offset' && Number.isFinite(n[0])) offset = n[0]
    else if (key === 'color' || key === 'color4' || key === 'solidcolor' || key === 'solidcolor4') {
      const alpha = key.endsWith('4'), width = alpha ? 4 : 3
      if (n.length < 1 + width || n.slice(0, 1 + width).some(x => !Number.isFinite(x))) continue
      const second = n.length >= 1 + 2 * width && n.slice(1 + width, 1 + 2 * width).every(Number.isFinite) ? rgb(n.slice(1 + width), alpha) : undefined
      raw.push({ value: n[0], color: rgb(n.slice(1), alpha), ...(second !== undefined ? { to: second } : {}), solid: key.startsWith('solid') })
    }
  }
  if (!raw.length) throw new Error(L('В файле нет строк Color: или SolidColor:', 'The file has no Color: or SolidColor: lines'))
  // Velocity in knots or mph without a Scale line: to m/s.
  const unit = kind === 'V' && scale === 1 ? (units === 'KTS' || units === 'KT' ? 1 / .514444 : units === 'MPH' ? 1 / .44704 : 1) : 1
  const stops = raw.map(s => ({ ...s, value: (s.value - offset) / (scale * unit) }))
  return { name, kind, stops: sorted(stops) }
}

/** The palette as .pal text (values in the model's units: dBZ, m/s, dB, unitless, deg/km). */
export function toPal(palette: Palette) {
  const k = KINDS[palette.kind], c = (x: RGB) => x.join(' ')
  const lines = [`; MeteoLab — ${palette.name}`, `Product: ${k.codes[0]}`, `Units: ${k.palUnits}`]
  for (const s of sorted(palette.stops)) {
    if (!s.color) { lines.push(`Color4: ${s.value} 0 0 0 0`); continue }
    lines.push(s.solid ? `SolidColor: ${s.value} ${c(s.color)}` : `Color: ${s.value} ${c(s.color)}${s.to ? ` ${c(s.to)}` : ''}`)
  }
  return lines.join('\n') + '\n'
}

/** The user's palettes and the chosen one of every kind, in the browser. */
const STORE = 'meteolab-palettes'
interface Stored { user: Palette[]; chosen: Partial<Record<PaletteKind, string>> }

export class Palettes {
  private data: Stored = { user: [], chosen: {} }
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null
  constructor(storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage) {
    this.storage = storage
    try {
      const d = JSON.parse(this.storage?.getItem(STORE) ?? 'null')
      if (d && Array.isArray(d.user)) this.data = { user: d.user.filter(valid), chosen: d.chosen && typeof d.chosen === 'object' ? d.chosen : {} }
    } catch { /* a broken entry: start empty */ }
  }

  all(kind: PaletteKind) { return [...BUILTIN.filter(p => p.kind === kind), ...this.data.user.filter(p => p.kind === kind)] }
  get(id: string) { return BUILTIN.find(p => p.id === id) ?? this.data.user.find(p => p.id === id) }
  chosen(kind: PaletteKind) { const id = this.data.chosen[kind]; const p = id ? this.get(id) : undefined; return p?.kind === kind ? p : this.all(kind)[0] }
  choose(kind: PaletteKind, id: string) { this.data.chosen[kind] = id; this.save() }

  /** Adds or replaces a user palette (a built-in id gets a new one) and chooses it. */
  put(p: Omit<Palette, 'id' | 'builtin'> & { id?: string }) {
    const id = p.id && !BUILTIN.some(b => b.id === p.id) ? p.id : `user-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`
    const palette: Palette = { id, name: p.name.trim() || L('Своя', 'Own'), kind: p.kind, stops: sorted(p.stops) }
    this.data.user = [...this.data.user.filter(u => u.id !== id), palette]; this.data.chosen[p.kind] = id; this.save()
    return palette
  }

  remove(id: string) {
    const p = this.data.user.find(u => u.id === id)
    if (!p) return
    this.data.user = this.data.user.filter(u => u.id !== id)
    if (this.data.chosen[p.kind] === id) delete this.data.chosen[p.kind]
    this.save()
  }

  private save() { try { this.storage?.setItem(STORE, JSON.stringify(this.data)) } catch { /* storage full or blocked: keep in memory */ } }
}

const isRgb = (c: unknown) => Array.isArray(c) && c.length === 3 && c.every(x => typeof x === 'number' && x >= 0 && x <= 255)
/** A stored palette of the right shape (it comes back from the browser's storage, which anything could have written). */
function valid(p: unknown): p is Palette {
  const q = p as Palette
  return !!q && typeof q.id === 'string' && typeof q.name === 'string' && q.kind in KINDS && Array.isArray(q.stops) && q.stops.length > 0
    && q.stops.every(s => typeof s.value === 'number' && Number.isFinite(s.value) && (s.color === null || isRgb(s.color)) && (s.to === undefined || s.to === null || isRgb(s.to)))
}
