// The large-scale advection's editor (2.6) in the left column: ready-made changes, the list of changes by layer and a
// chart of what they do to the surface parcel's CAPE and CIN over the hours (without the sun and the storms).
import { type AdvectionChange, advectedProfile, createGrid, Environment, environmentProfile, parcelIndices, type SimConfig } from './core'
import { chartPalette, MONO } from './theme'

/** Ready-made changes: a name, what it is, the changes. */
export const ADVECTION_PRESETS: { name: string; title: string; changes: AdvectionChange[] }[] = [
  { name: 'Приток влаги', title: 'Южный ветер приносит влажный воздух: +2 г/кг водяного пара в нижних 1,5 км за 3 часа (с начала расчёта). CAPE растёт, основание облаков опускается. Быстро, но бывает: так возвращается влага с низкоуровневым струйным течением', changes: [{ quantity: 'moisture', bottom: 0, top: 1.5, amount: 2, start: 0, hours: 3 }] },
  { name: 'Холод наверху (ложбина)', title: 'Подходит высотная ложбина: на 5–9 км холодает на 3 K за 2 часа — ускорено, в природе так за 6–12 ч. Профиль становится круче, CAPE растёт, вершины гроз выше. Подъём воздуха перед ложбиной модель не учитывает', changes: [{ quantity: 'temperature', bottom: 5, top: 9, amount: -3, start: 0, hours: 2 }] },
  { name: 'Тёплый воздух над слоем', title: 'Тёплая адвекция на 2–3,5 км, над слоем перемешивания: +3 K за 2 часа. Задерживающий слой крепнет, CIN растёт — конвекция может так и не начаться. Ниже, внутри слоя перемешивания, тёплый воздух подействовал бы наоборот: слой прогрелся бы весь, как от солнца', changes: [{ quantity: 'temperature', bottom: 2, top: 3.5, amount: 3, start: 0, hours: 2 }] },
  { name: 'Сухой воздух в середине', title: 'Сухой воздух на 3–6 км: −1,5 г/кг за 2 часа. Вовлечение сухого воздуха может усиливать нисходящие потоки (DCAPE растёт), но осадков становится меньше. Пара не станет меньше нуля: на 6 км его всего ~0,5 г/кг', changes: [{ quantity: 'moisture', bottom: 3, top: 6, amount: -1.5, start: 0, hours: 2 }] },
]
const NEW_CHANGE: AdvectionChange = { quantity: 'temperature', bottom: 0, top: 1.5, amount: 1, start: 0, hours: 2 }
/** At most this many changes (share.ts accepts 12). */
const MAX = 8
/** The chart's points: at most this many over the hours. */
const POINTS = 25

/** The group's body: the ready-made changes, the list, the chart. */
export const advectionMarkup = () => `
  <div class="adv__presets">${ADVECTION_PRESETS.map((p, k) => `<button class="btn btn--xs" type="button" data-adv-preset="${k}" title="${p.title}">${p.name}</button>`).join('')}</div>
  <div id="advList"></div>
  <div class="side__row"><button class="btn btn--xs" type="button" id="advAdd">Добавить изменение</button><button class="btn btn--xs btn--quiet" type="button" id="advClear">Убрать все</button></div>
  <canvas class="adv__chart" id="advChart" aria-label="CAPE и CIN частицы от земли по часам с этой адвекцией"></canvas>
  <p class="t-caption" id="advNote"></p>`

const num = (v: number) => String(v).replace('-', '−')

/** The editor over the markup above: shows a list, calls onChange with a new one (the run then starts again). */
export class AdvectionEditor {
  private changes: AdvectionChange[] = []
  private config: SimConfig | null = null
  onChange: (changes: AdvectionChange[]) => void = () => {}
  private readonly list = document.querySelector<HTMLElement>('#advList')!

  constructor() {
    document.querySelectorAll<HTMLButtonElement>('[data-adv-preset]').forEach(b => b.addEventListener('click', () => {
      const p = ADVECTION_PRESETS[Number(b.dataset.advPreset)]
      this.commit([...this.changes, ...p.changes.map(c => ({ ...c }))].slice(-MAX))
    }))
    document.querySelector('#advAdd')!.addEventListener('click', () => this.commit([...this.changes, { ...NEW_CHANGE }].slice(-MAX)))
    document.querySelector('#advClear')!.addEventListener('click', () => this.commit([]))
    this.list.addEventListener('change', e => {
      const input = (e.target as HTMLElement).closest<HTMLInputElement | HTMLSelectElement>('[data-adv]')
      if (!input) return
      const k = Number(input.dataset.adv), key = input.dataset.field as keyof AdvectionChange, next = this.changes.map(c => ({ ...c }))
      if (key === 'quantity') next[k].quantity = input.value as AdvectionChange['quantity']
      else { const v = Number(input.value.replace(',', '.').replace('−', '-')); if (!Number.isFinite(v)) { this.show(this.config!); return } (next[k] as unknown as Record<string, number>)[key] = v }
      this.commit(next.map(tidy))
    })
    this.list.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-adv-remove]')
      if (b) this.commit(this.changes.filter((_, k) => k !== Number(b.dataset.advRemove)))
    })
    addEventListener('themechange', () => this.chart())
    // Counted only while the group is open (25 parcels: ~0.1 s).
    this.list.closest('details')?.addEventListener('toggle', () => this.chart())
  }

  /** Shows the configuration's changes (a scenario, a link or a file chose them). */
  show(config: SimConfig) {
    this.config = config; this.changes = (config.largeScale ?? []).map(c => ({ ...c }))
    const row = (c: AdvectionChange, k: number) => {
      const field = (key: keyof AdvectionChange, label: string, step: number, min: number, max: number) => `<label class="adv__num"><span>${label}</span><input type="number" step="${step}" min="${min}" max="${max}" value="${c[key]}" data-adv="${k}" data-field="${key}"></label>`
      return `<div class="adv__row"><div class="adv__head"><span class="select"><select data-adv="${k}" data-field="quantity"><option value="temperature"${c.quantity === 'temperature' ? ' selected' : ''}>Температура, K</option><option value="moisture"${c.quantity === 'moisture' ? ' selected' : ''}>Водяной пар, г/кг</option></select></span><button class="btn btn--xs btn--quiet" type="button" data-adv-remove="${k}" title="Убрать это изменение">✕</button></div>
        <div class="adv__grid">${field('amount', c.quantity === 'temperature' ? 'на, K' : 'на, г/кг', .5, -10, 10)}${field('bottom', 'слой от, км', .5, 0, 16)}${field('top', 'до, км', .5, 0, 16)}${field('start', 'начало, ч', .5, 0, 24)}${field('hours', 'за, ч', .5, 0, 24)}</div>
        <span class="t-caption">${describe(c)}</span></div>`
    }
    this.list.innerHTML = this.changes.map(row).join('')
    this.chart()
  }

  private commit(changes: AdvectionChange[]) { this.changes = changes; this.onChange(changes.map(c => ({ ...c }))) }

  /** CAPE and CIN of the surface parcel by the hour with these changes (the environment of the sliders or the sounding). */
  private chart() {
    const c = document.querySelector<HTMLCanvasElement>('#advChart')!, note = document.querySelector<HTMLElement>('#advNote')!
    c.hidden = !this.changes.length || !this.config
    if (c.hidden) { note.textContent = 'Среда весь расчёт остаётся такой, как в начале. Адвекция — изменение температуры или влажности в слое за несколько часов, как его приносит ветер: например, «Приток влаги». Модель меняет только температуру и влагу: подъём воздуха и ветер остаются прежними.'; return }
    if (!this.list.closest('details')?.open) return
    const config = this.config!, grid = createGrid(), env = new Environment(config, grid, environmentProfile(config, grid.height))
    const end = Math.max(3, ...this.changes.map(x => Math.min(24, x.start + x.hours) + .5)), hours = Array.from({ length: POINTS }, (_, k) => end * k / (POINTS - 1))
    const sb = hours.map(h => parcelIndices(new Environment(config, grid, advectedProfile(env, this.changes, h * 3600)), grid.height).sb)
    const dpr = Math.min(devicePixelRatio, 2), w = c.clientWidth, h = c.clientHeight
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const ctx = c.getContext('2d')!, pal = chartPalette()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); ctx.font = `10px ${MONO}`
    const L = 30, R = w - 30, T = 8, B = h - 16, capeTop = Math.max(1000, ...sb.map(s => s.cape)) * 1.1, cinTop = Math.max(100, ...sb.map(s => s.cin)) * 1.1
    const X = (t: number) => L + t / end * (R - L), Yc = (v: number) => B - v / capeTop * (B - T), Yn = (v: number) => B - v / cinTop * (B - T)
    ctx.strokeStyle = pal.grid; ctx.lineWidth = 1; ctx.fillStyle = pal.label
    for (let t = 0; t <= end + 1e-6; t += end > 8 ? 2 : 1) { ctx.beginPath(); ctx.moveTo(X(t), T); ctx.lineTo(X(t), B); ctx.stroke(); ctx.fillText(`${t}ч`, X(t) - 6, h - 4) }
    ctx.fillStyle = pal.accent; ctx.fillText(`${(capeTop / 1100).toFixed(1).replace('.', ',')}к`, 0, T + 8); ctx.fillText('CAPE', 0, B)
    ctx.fillStyle = pal.warn; ctx.fillText(`${Math.round(cinTop / 1.1)}`, R + 4, T + 8); ctx.fillText('CIN', R + 4, B)
    const line = (color: string, y: (k: number) => number) => { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); hours.forEach((t, k) => k ? ctx.lineTo(X(t), y(k)) : ctx.moveTo(X(t), y(k))); ctx.stroke() }
    line(pal.accent, k => Yc(sb[k].cape)); line(pal.warn, k => Yn(sb[k].cin))
    const first = sb[0], last = sb[sb.length - 1], r = (v: number) => Math.round(v)
    note.textContent = `Частица от земли: CAPE ${r(first.cape)} → ${r(last.cape)} Дж/кг, CIN ${r(first.cin)} → ${r(last.cin)} Дж/кг к ${num(Math.round(end * 10) / 10).replace('.', ',')} ч. Без солнца и самих гроз: в расчёте к этому добавятся прогрев днём и отток.`
  }
}

/** The layer the right way up and the numbers within the editor's ranges. */
function tidy(c: AdvectionChange): AdvectionChange {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)), bottom = clamp(Math.min(c.bottom, c.top), 0, 16), top = clamp(Math.max(c.bottom, c.top), 0, 16)
  return { quantity: c.quantity, bottom, top, amount: clamp(c.amount, -10, 10), start: clamp(c.start, 0, 24), hours: clamp(c.hours, 0, 24) }
}

/** One line in words: «+2 K на 1–2 км с 0 до 2 ч». */
function describe(c: AdvectionChange) {
  const sign = c.amount > 0 ? '+' : c.amount < 0 ? '−' : '', f = (v: number) => String(v).replace('.', ','), unit = c.quantity === 'temperature' ? 'K' : 'г/кг'
  const what = c.quantity === 'temperature' ? (c.amount >= 0 ? 'теплее' : 'холоднее') : (c.amount >= 0 ? 'влажнее' : 'суше')
  const rate = c.hours > 0 ? `, ${f(Math.round(Math.abs(c.amount) / c.hours * 100) / 100)} ${unit}/ч` : ' сразу'
  return `${what}: ${sign}${f(Math.abs(c.amount))} ${unit} на ${f(c.bottom)}–${f(c.top)} км, с ${f(c.start)} до ${f(c.start + c.hours)} ч${rate}`
}
