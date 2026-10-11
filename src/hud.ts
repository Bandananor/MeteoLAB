// The phone layout (release 2.0): on a narrow screen the 3D view fills the screen, a few large numbers sit over it, a
// bar at the bottom holds what a thumb needs (scenarios, pause, restart, speed, data, instruments), and the two side
// panels become sheets that slide up. Everything else is the desktop page itself, rearranged by CSS (style.css,
// "phone"); this module only adds the overlay, the bar and the sheets' switches.

/** Where the phone layout starts (CSS uses the same width). */
export const PHONE_QUERY = '(max-width: 760px)'
export const isPhone = () => typeof matchMedia === 'function' && matchMedia(PHONE_QUERY).matches
/** Physics threads on a phone unless the address asks otherwise: fewer, so it does not overheat. */
export const PHONE_THREADS = 3
/** Speed steps of the speed button. */
const SPEEDS = [4, 8, 16, 30]

export interface HudState { time: number; updraft: number; rain: number; uh: number; mesocyclone: boolean; regime: string; running: boolean; speed: number }

type Sheet = 'controls' | 'data' | null

export class Hud {
  private readonly root: HTMLDivElement; private readonly bar: HTMLElement; private readonly tools: HTMLDivElement
  private sheet: Sheet = null; private shown = ''
  private readonly setSpeed: (speed: number) => void

  /** `setSpeed` changes the speed setting (the page's slider). */
  constructor(viewport: HTMLElement, app: HTMLElement, setSpeed: (speed: number) => void) {
    this.setSpeed = setSpeed
    this.root = document.createElement('div'); this.root.className = 'hud'
    this.root.innerHTML = `
      <div><span>T+</span><b data-hud="time">00:00</b></div>
      <div><span>поток, м/с</span><b data-hud="updraft">0</b></div>
      <div><span>дождь, мм/ч</span><b data-hud="rain">0</b></div>
      <div><span>вращение UH</span><b data-hud="uh">0</b></div>
      <p data-hud="regime">—</p>`
    viewport.appendChild(this.root)
    this.bar = document.createElement('nav'); this.bar.className = 'hud-bar'; this.bar.setAttribute('aria-label', 'Управление')
    this.bar.innerHTML = `
      <button data-act="scenarios"><i>☰</i>Сценарии</button>
      <button data-act="pause"><i data-hud="pauseIcon">❚❚</i><span data-hud="pauseText">Пауза</span></button>
      <button data-act="restart"><i>↻</i>Заново</button>
      <button data-act="speed"><i data-hud="speed">×8</i>Скорость</button>
      <button data-act="data"><i>▤</i>Данные</button>
      <button data-act="tools"><i>◉</i>Приборы</button>`
    app.appendChild(this.bar)
    this.tools = document.createElement('div'); this.tools.className = 'hud-tools'; this.tools.hidden = true
    this.tools.innerHTML = '<button data-tool="#radarOpen">◉ Радар</button><button data-tool="#skewOpen">⟋ Skew-T</button><button data-tool="#stationOpen">⌂ Станция</button>'
    app.appendChild(this.tools)
    // A close handle on top of each sheet (hidden on a desktop).
    for (const panel of document.querySelectorAll<HTMLElement>('.controls, .diagnostics')) {
      const close = document.createElement('button'); close.className = 'sheet-close'; close.textContent = 'Свернуть ▾'
      close.addEventListener('click', () => this.open(null)); panel.prepend(close)
    }
    this.bar.addEventListener('click', e => {
      const act = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]')?.dataset.act
      if (act !== 'tools') this.tools.hidden = true
      if (act === 'scenarios') this.open(this.sheet === 'controls' ? null : 'controls')
      else if (act === 'data') this.open(this.sheet === 'data' ? null : 'data')
      else if (act === 'pause') document.querySelector<HTMLButtonElement>('#pause')!.click()
      else if (act === 'restart') { this.open(null); document.querySelector<HTMLButtonElement>('#restart')!.click() }
      else if (act === 'speed') { const now = Number((this.bar.querySelector('[data-hud="speed"]')!.textContent ?? '×8').slice(1)); this.setSpeed(SPEEDS[(SPEEDS.indexOf(now) + 1) % SPEEDS.length] ?? 8) }
      else if (act === 'tools') this.tools.hidden = !this.tools.hidden
    })
    this.tools.addEventListener('click', e => {
      const tool = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tool]')?.dataset.tool
      if (!tool) return
      this.tools.hidden = true; this.open(null); document.querySelector<HTMLButtonElement>(tool)!.click()
    })
    // A scenario chosen on the sheet: back to the view.
    document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => { if (isPhone()) this.open(null) }))
  }

  private open(sheet: Sheet) {
    this.sheet = sheet
    document.body.classList.toggle('sheet-controls', sheet === 'controls'); document.body.classList.toggle('sheet-data', sheet === 'data')
    if (sheet === 'controls') document.querySelector('.controls')!.scrollTop = 0
  }

  /** Called every frame; touches the page only when something shown changed. */
  update(s: HudState) {
    const sec = Math.floor(s.time), time = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
    const key = [time, s.updraft.toFixed(0), s.rain.toFixed(0), s.uh.toFixed(0), s.mesocyclone, s.regime, s.running, s.speed].join('|')
    if (key === this.shown) return
    this.shown = key
    const set = (name: string, text: string) => { for (const el of document.querySelectorAll(`[data-hud="${name}"]`)) el.textContent = text }
    set('time', time); set('updraft', s.updraft.toFixed(0)); set('rain', s.rain.toFixed(0)); set('uh', s.uh.toFixed(0))
    set('regime', s.mesocyclone ? `${s.regime} · мезоциклон` : s.regime)
    this.root.classList.toggle('meso', s.mesocyclone)
    set('pauseIcon', s.running ? '❚❚' : '▶'); set('pauseText', s.running ? 'Пауза' : 'Пуск'); set('speed', `×${s.speed}`)
  }
}
