import { L } from './i18n'
// The phone layout (release 2.0): the 3D view fills the screen with a few large numbers and the storm mode over it, a
// bar at the bottom holds what a thumb needs (scenarios, pause, restart, speed, data, instruments), and the two side
// columns of the desktop page become sheets that slide up over the bar. The page itself is the same; CSS rearranges it
// (styles/app.css, the .layout-phone block). This module adds the overlay, the bar, the sheet headers and the
// instruments menu, and chooses the layout: the class "layout-phone" on <html>, asked at the first visit (the screen
// width only suggests it) and switched by hand, remembered in localStorage — a wrong guess from the width (a small
// laptop window, a large tablet) is then one tap away from fixed.

import { elapsedShort } from './clock'

/** The screen width the phone layout is suggested for. */
export const PHONE_QUERY = '(max-width: 760px)'
export type Layout = 'phone' | 'desktop'
const LAYOUT_KEY = 'meteolab-layout', GESTURE_KEY = 'meteolab-gestures-seen', GUIDE_KEY = 'meteolab-guide-offered'
const PHONE_CLASS = 'layout-phone'

/** Whether the page shows the phone layout now. */
export const isPhone = () => typeof document !== 'undefined' && document.documentElement.classList.contains(PHONE_CLASS)
/** The layout the screen suggests. */
export const suggestedLayout = (): Layout => typeof matchMedia === 'function' && matchMedia(PHONE_QUERY).matches ? 'phone' : 'desktop'
/** The layout chosen before (null at the first visit, or where the browser keeps nothing). */
export function savedLayout(): Layout | null {
  try { const v = localStorage.getItem(LAYOUT_KEY); return v === 'phone' || v === 'desktop' ? v : null } catch { return null }
}
/** Shows a layout and remembers the choice; the canvases follow their new size. */
export function applyLayout(layout: Layout, remember = true) {
  document.documentElement.classList.toggle(PHONE_CLASS, layout === 'phone')
  // The design system's phone frame (styles/layout.css .phone) on the page's root.
  document.querySelector('.app')?.classList.toggle('phone', layout === 'phone')
  if (remember) try { localStorage.setItem(LAYOUT_KEY, layout) } catch { /* private mode: for this visit only */ }
  dispatchEvent(new Event('layoutchange'))
  dispatchEvent(new Event('resize'))
}

/** The first visit: which layout. The one the screen suggests comes first and is marked; Esc or a tap beside the
 *  window choose it too. */
/** `then` runs once the layout is chosen (the next first-visit question waits for this one). */
export function askLayout(then?: () => void) {
  const suggested = suggestedLayout(), dialog = document.createElement('dialog')
  const card = (layout: Layout) => {
    const phone = layout === 'phone', recommended = layout === suggested
    const pic = phone ? '<span class="layout-pic layout-pic--phone"><i></i><i class="v"></i><i></i></span>'
      : '<span class="layout-pic layout-pic--desktop"><i></i><span class="layout-pic__cols"><i></i><i class="v"></i><i></i></span></span>'
    return `<button class="choice${recommended ? ' is-recommended' : ''}" data-layout="${layout}"><span class="choice__pic">${pic}</span><span style="display:flex;flex-direction:column;gap:5px;min-width:0">`
      + `<span class="choice__name">${phone ? L('Телефон', 'Phone') : L('Компьютер', 'Computer')}${recommended ? `<span class="choice__tag">${L('подходит этому экрану', 'fits this screen')}</span>` : ''}</span>`
      + `<span class="choice__desc">${phone ? L('3D во весь экран, крупные цифры, панель под палец', '3D on the whole screen, large numbers, a panel for the thumb') : L('Три колонки: обстановка, 3D, данные', 'Three columns: setting, 3D, data')}</span></span></button>`
  }
  dialog.className = 'modal modal--wide'
  dialog.innerHTML = `<h2 class="modal__title" style="font-size:24px;line-height:30px">${L('Как показывать MeteoLab?', 'How should MeteoLab look?')}</h2>
    <div class="choice-list">${card(suggested)}${card(suggested === 'phone' ? 'desktop' : 'phone')}</div>
    <p class="modal__text" style="color:var(--text-3)">${L('Выбор запомнится. Переключить можно в любой момент — в шапке или в меню «Приборы» на телефоне.', 'The choice is remembered. Switch any time — in the header, or in the “Instruments” menu on a phone.')}</p>`
  const choose = (layout: Layout) => { applyLayout(layout); dialog.close(); dialog.remove(); then?.() }
  dialog.addEventListener('click', e => {
    const layout = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-layout]')?.dataset.layout as Layout | undefined
    if (layout) choose(layout)
    else if (e.target === dialog) choose(suggested)  // the backdrop: a click outside the window's box
  })
  dialog.addEventListener('cancel', e => { e.preventDefault(); choose(suggested) })
  document.body.appendChild(dialog)
  dialog.showModal()
}
/**
 * At the first visit to the simulator (after the layout question): an offer of the guide to the interface (guide/).
 * «Хорошо, посмотрю» opens it, «Я знаю, что делаю» or Esc closes the window; either way it is not asked again.
 */
export function askGuide() {
  try { if (localStorage.getItem(GUIDE_KEY)) return } catch { /* ask */ }
  const dialog = document.createElement('dialog')
  dialog.className = 'modal guide-offer'
  dialog.innerHTML = `<h2 class="modal__title">${L('Сложно? Посмотрите наш гайд', 'Complicated? Have a look at our guide')}</h2>
    <p class="modal__text">${L('Где какие кнопки, как менять параметры погоды, как пользоваться радаром и Skew-T — коротко и по шагам. Гайд всегда под рукой: кнопка «Справка» в шапке (на телефоне — в меню «Приборы»).', 'Where the buttons are, how to change the weather, how to use the radar and the Skew-T — short and step by step. The guide is always at hand: the “Guide” button in the header (on a phone — in the “Instruments” menu).')}</p>
    <div class="modal__actions"><button class="btn btn--danger" data-guide="no">${L('Я знаю, что делаю', 'I know what I’m doing')}</button><button class="btn btn--primary" data-guide="yes">${L('Хорошо, посмотрю', 'OK, I’ll look')}</button></div>`
  const done = (open: boolean) => {
    try { localStorage.setItem(GUIDE_KEY, '1') } catch { /* asked again next time */ }
    dialog.close(); dialog.remove()
    if (open) location.href = '../guide/'
  }
  dialog.addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-guide]'); if (b) done(b.dataset.guide === 'yes') })
  dialog.addEventListener('cancel', e => { e.preventDefault(); done(false) })
  document.body.appendChild(dialog)
  dialog.showModal()
  dialog.querySelector<HTMLButtonElement>('[data-guide="yes"]')!.focus()
}

/** Physics threads on a phone unless the address asks otherwise: fewer, so it does not overheat. */
export const PHONE_THREADS = 3
/** Speed steps of the speed button, in turn. */
const SPEEDS = [4, 8, 16, 30, 60]

export interface HudState { time: number; /** Local solar time of day, hh:mm. */ local: string; updraft: number; rain: number; uh: number; mesocyclone: boolean; regime: string; running: boolean; speed: number
  /** The story's stage now (a synoptic situation, 2.6), or '' without one. */
  story: string
  /** The tallest cloud's genus (Cb cap, …) and the rain in words, under the mode; '' when neither. */
  sky: string }

/** What the bar opens: the two sheets (the page's side columns) and the instruments menu; one at a time. */
type Panel = 'scenarios' | 'data' | 'tools'

export class Hud {
  private readonly bar: HTMLElement; private readonly menu: HTMLDivElement; private readonly scrim: HTMLDivElement
  private readonly sheets: Record<Exclude<Panel, 'tools'>, HTMLElement>
  private open: Panel | null = null; private shown = ''
  private readonly setSpeed: (speed: number) => void

  /** `setSpeed` changes the speed setting (the page's slider). */
  constructor(viewport: HTMLElement, app: HTMLElement, setSpeed: (speed: number) => void) {
    this.setSpeed = setSpeed
    // Over the 3D view: four numbers, the storm mode, and at the first visit the gestures.
    const overlay = document.createElement('div'); overlay.className = 'm-only'
    overlay.innerHTML = `
      <div class="ov-nums">
        <div class="ov-num"><span class="ov-num__label">T+ · <span data-hud="local">—</span></span><span class="ov-num__value" data-hud="time">0:00</span></div>
        <div class="ov-num"><span class="ov-num__label">${L('поток, м/с', 'updraught, m/s')}</span><span class="ov-num__value" data-hud="updraft">0</span></div>
        <div class="ov-num"><span class="ov-num__label">${L('дождь, мм/ч', 'rain, mm/h')}</span><span class="ov-num__value" data-hud="rain">0</span></div>
        <div class="ov-num"><span class="ov-num__label">UH</span><span class="ov-num__value" data-hud="uh">0</span></div>
      </div>
      <div class="ov-modeline"><span class="ov-mode"><span><span data-hud="regime">—</span><small class="ov-mode__sky" data-hud="sky"></small></span></span><p class="ov-story" data-hud="story" hidden></p><p class="ov-story" data-hud="notice" hidden></p></div>`
    viewport.appendChild(overlay)
    let seen = false
    try { seen = localStorage.getItem(GESTURE_KEY) === '1' } catch { /* show it */ }
    if (!seen) {
      const hint = document.createElement('div'); hint.className = 'ov-bottom m-only'
      hint.innerHTML = `<div class="ov-gesture"><span style="flex:1">${L('Палец — вращение · щипок — масштаб · двойной тап — термик', 'Finger — rotate · pinch — zoom · double tap — thermal')}</span><button aria-label="${L('Скрыть', 'Hide')}">×</button></div>`
      hint.querySelector('button')!.addEventListener('click', () => { hint.remove(); try { localStorage.setItem(GESTURE_KEY, '1') } catch { /* this visit only */ } })
      viewport.appendChild(hint)
    }
    this.bar = document.createElement('nav'); this.bar.className = 'bottombar m-only'; this.bar.setAttribute('aria-label', L('Управление', 'Controls'))
    const item = (act: string, glyph: string, label: string, expandable = false) =>
      `<button data-act="${act}"${expandable ? ' aria-expanded="false"' : ''}><span class="bottombar__glyph"${act === 'pause' || act === 'speed' ? ` data-hud="${act}"` : ''}>${glyph}</span><span class="bottombar__label"${act === 'pause' ? ' data-hud="pauseText"' : ''}>${label}</span></button>`
    this.bar.innerHTML = item('scenarios', '☰', L('Сценарии', 'Scenarios'), true) + item('pause', '❚❚', L('Пауза', 'Pause')) + item('restart', '↻', L('Заново', 'Restart')) +
      item('speed', '×8', L('Скорость', 'Speed')) + item('data', '▤', L('Данные', 'Data'), true) + item('tools', '◉', L('Приборы', 'Instruments'), true)
    this.bar.querySelector('[data-act="speed"]')!.setAttribute('title', SPEEDS.map(s => `×${s}`).join(' → '))
    app.appendChild(this.bar)
    this.scrim = document.createElement('div'); this.scrim.className = 'sheet-scrim m-only'; this.scrim.hidden = true
    this.scrim.addEventListener('click', () => this.show(null))
    app.appendChild(this.scrim)
    this.menu = document.createElement('div'); this.menu.className = 'menu-anchor m-only'; this.menu.hidden = true
    this.menu.innerHTML = `<div class="menu menu--touch" role="menu">
      <button class="menu__item" role="menuitem" data-tool="#radarOpen"><span class="menu__glyph">◉</span>${L('Радар', 'Radar')}</button>
      <button class="menu__item" role="menuitem" data-tool="#skewOpen"><span class="menu__glyph">⟋</span>Skew-T</button>
      <button class="menu__item" role="menuitem" data-tool="#zonesOpen"><span class="menu__glyph">▦</span>${L('Зоны', 'Zones')}</button>
      <button class="menu__item" role="menuitem" data-tool="#detectorOpen"><span class="menu__glyph">ϟ</span>${L('Молнии', 'Lightning')}</button>
      <button class="menu__item" role="menuitem" data-tool="#analysisOpen"><span class="menu__glyph">≋</span>${L('Анализ', 'Analysis')}</button>
      <button class="menu__item" role="menuitem" data-tool="#satelliteOpen"><span class="menu__glyph">◐</span>${L('Спутник', 'Satellite')}</button>
      <button class="menu__item" role="menuitem" data-tool="#stationOpen"><span class="menu__glyph">⌂</span>${L('Станция', 'Station')}</button>
      <button class="menu__item" role="menuitem" data-tool="#compareOpen"><span class="menu__glyph">⇄</span>${L('Сравнение', 'Compare')}</button>
      <button class="menu__item" role="menuitem" data-tool="#ensembleOpen"><span class="menu__glyph">≋</span>${L('Ансамбль', 'Ensemble')}</button>
      <button class="menu__item" role="menuitem" data-tool="#regimeOpen"><span class="menu__glyph">▦</span>${L('Карта режимов', 'Regime map')}</button>
      <div class="menu__sep"></div>
      <button class="menu__item" role="menuitem" data-tool="#groundToggle"><span class="menu__glyph">⛰</span>${L('Вид с земли', 'View from the ground')}</button>
      <button class="menu__item" role="menuitem" data-tool="#snapshotButton"><span class="menu__glyph">◫</span>${L('Снимок', 'Snapshot')}</button>
      <button class="menu__item" role="menuitem" data-tool="#videoButton"><span class="menu__glyph">▶</span>${L('Видео', 'Video')}</button>
      <button class="menu__item" role="menuitem" data-tool="#immersiveToggle"><span class="menu__glyph">⛶</span>${L('Во весь экран', 'Full screen')}</button>
      <div class="menu__sep"></div>
      <button class="menu__item" role="menuitem" data-tool="#layoutToggle"><span class="menu__glyph">▭</span>${L('Компьютерный вид', 'Computer layout')}</button>
      <a class="menu__item" role="menuitem" href="../guide/" target="_blank" rel="noopener"><span class="menu__glyph">?</span>${L('Как пользоваться', 'How to use it')}</a>
      <a class="menu__item" role="menuitem" href="https://t.me/MeteoLabBnor" target="_blank" rel="noopener"><span class="menu__glyph">✈</span>${L('Канал проекта', 'Project channel')}</a>
      <a class="menu__item" role="menuitem" href="#" data-lang-switch><span class="menu__glyph">⇄</span>${L('English version', 'Русская версия')}</a>
      <div class="menu__sep"></div>
      <div class="menu__group"><span class="label">${L('Качество картинки', 'Picture quality')}</span><div class="seg seg--text seg--block seg--touch" role="group" aria-label="${L('Качество картинки', 'Picture quality')}"><button data-quality-set="auto">${L('Авто', 'Auto')}</button><button data-quality-set="low">${L('Низкое', 'Low')}</button><button data-quality-set="medium">${L('Среднее', 'Medium')}</button><button data-quality-set="high">${L('Высокое', 'High')}</button></div></div>
      <div class="menu__group"><span class="label">${L('Тема', 'Theme')}</span><div class="seg seg--text seg--block seg--touch" role="group" aria-label="${L('Тема', 'Theme')}"><button data-theme-set="auto">${L('Авто', 'Auto')}</button><button data-theme-set="light">${L('Светлая', 'Light')}</button><button data-theme-set="dark">${L('Тёмная', 'Dark')}</button></div></div>
    </div>`
    app.appendChild(this.menu)
    // The side columns become the sheets: a handle, a title and «Свернуть» on top (hidden on a desktop).
    const left = document.querySelector<HTMLElement>('.side--left')!, right = document.querySelector<HTMLElement>('.side--right')!
    this.sheets = { scenarios: left, data: right }
    for (const [panel, title] of [[left, L('Сценарии', 'Scenarios')], [right, L('Данные', 'Data')]] as const) {
      const head = document.createElement('div'); head.className = 'sheet-top m-only'
      head.innerHTML = `<span class="sheet__handle"></span><div class="sheet__head"><h2 class="sheet__title">${title}</h2><button class="btn btn--quiet btn--touch">${L('Свернуть', 'Hide')}</button></div>`
      head.querySelector('button')!.addEventListener('click', () => this.show(null))
      panel.prepend(head)
    }
    this.bar.addEventListener('click', e => {
      const act = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]')?.dataset.act
      if (act === 'scenarios' || act === 'data' || act === 'tools') this.show(this.open === act ? null : act)
      else if (act === 'pause') { this.show(null); document.querySelector<HTMLButtonElement>('#pause')!.click() }
      else if (act === 'restart') { this.show(null); document.querySelector<HTMLButtonElement>('#restart')!.click() }
      else if (act === 'speed') { const now = Number((this.bar.querySelector('[data-hud="speed"]')!.textContent ?? '×8').slice(1)); this.setSpeed(SPEEDS[(SPEEDS.indexOf(now) + 1) % SPEEDS.length] ?? 8) }
    })
    this.menu.addEventListener('click', e => {
      // The guide is a link (a new tab): the menu just closes.
      if ((e.target as HTMLElement).closest('a')) { this.show(null); return }
      const tool = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tool]')?.dataset.tool
      if (!tool) return
      this.show(null); document.querySelector<HTMLButtonElement>(tool)!.click()
    })
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.open) this.show(null) })
    addEventListener('layoutchange', () => this.show(null))
    // A run started from outside the bar (the sounding dialog): back to the view.
    addEventListener('closesheet', () => this.show(null))
    // A scenario chosen on the sheet: back to the view.
    document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => { if (isPhone()) this.show(null) }))
  }

  /** Opens one sheet or the menu (or closes all): its bar button pressed, the scrim under a sheet. */
  private show(panel: Panel | null) {
    this.open = panel
    for (const [name, sheet] of Object.entries(this.sheets)) sheet.classList.toggle('is-open', name === panel)
    this.menu.hidden = panel !== 'tools'
    this.scrim.hidden = panel !== 'scenarios' && panel !== 'data'
    this.bar.querySelectorAll<HTMLButtonElement>('[aria-expanded]').forEach(b => b.setAttribute('aria-expanded', String(b.dataset.act === panel)))
    if (panel === 'scenarios' || panel === 'data') this.sheets[panel].querySelector('.side__scroll, .diag')?.scrollTo(0, 0)
  }

  /** Called every frame; touches the page only when something shown changed. */
  update(s: HudState) {
    const time = elapsedShort(s.time)
    const key = [time, s.local, s.updraft.toFixed(0), s.rain.toFixed(0), s.uh.toFixed(0), s.mesocyclone, s.regime, s.running, s.speed, s.story, s.sky].join('|')
    if (key === this.shown) return
    this.shown = key
    const set = (name: string, text: string) => { for (const el of document.querySelectorAll(`[data-hud="${name}"]`)) el.textContent = text }
    set('time', time); set('local', s.local); set('updraft', s.updraft.toFixed(0)); set('rain', s.rain.toFixed(0)); set('uh', s.uh.toFixed(0))
    set('regime', s.regime); set('story', s.story); set('sky', s.sky)
    for (const el of document.querySelectorAll<HTMLElement>('[data-hud="story"]')) el.hidden = !s.story
    document.querySelector('.ov-mode')!.classList.toggle('is-meso', s.mesocyclone)
    set('pause', s.running ? '❚❚' : '▶'); set('pauseText', s.running ? L('Пауза', 'Pause') : L('Пуск', 'Run')); set('speed', `×${s.speed}`)
  }
}
