// Launching a precise run from the interface (roadmap C2 step 4): the grid spacing, the length and the frames' interval,
// an estimate of the memory and the frames before it starts, the run in its own worker with helper threads while the
// live run is paused, its progress with a pause and a stop; at the end the frames are played back on the page and both
// the frames and the final state can be saved as files. One run is kept in the browser's storage until the next.
// "More" (for advanced users): any spacing, length and frame interval, the threads, the seed and the domain.
import { domainGrid, DT, SPACING_MIN, type SimConfig } from '../core'
import { decimal, L, lang } from '../i18n'
import { MAX_THREADS } from '../simulation'
import { PRECISE_DIR, PRECISE_FILE, type PreciseReply, type PreciseRequest } from './precise.worker'

/**
 * Two kinds of run: a storm on a finer grid than the live one ('fine'), and the mesoscale mode ('meso', roadmap-2.x
 * 2.11): squall lines and MCSs live 3-6 h, longer than the live run is worth waiting for, so on the same 2 km or finer
 * (1 km resolves a squall line's inner structure better: Bryan, Wyngaard & Fritsch 2003) and for hours.
 */
type Mode = 'fine' | 'meso'
const OPTIONS = {
  fine: { spacing: [.5, .25], minutes: [20, 40, 60, 90, 120], every: [15, 30, 60] },
  meso: { spacing: [2, 1.5, 1], minutes: [60, 120, 180, 240, 360], every: [60, 120, 300] },
} as const
type Segment = keyof typeof OPTIONS.fine
const DEFAULTS: Record<Mode, Record<Segment, number>> = { fine: { spacing: .5, minutes: 40, every: 30 }, meso: { spacing: 2, minutes: 180, every: 120 } }
type Domain = 'current' | 'standard' | 'large' | 'meso'
type Choice = { spacing: number; minutes: number; every: number; threads: number; seed: number | null; domain: Domain }
/** Bounds of the advanced fields: spacing (km), model minutes, seconds between frames. */
const LIMITS = {
  fine: { spacing: [SPACING_MIN, 1.2], minutes: [5, 240], every: [DT, 600] },
  meso: { spacing: [1, 4], minutes: [10, 360], every: [DT, 900] },
} as const
const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v))
/** Bytes a node of the shared fields and of one frame (measured on the 500 m classic supercell: 134 MB, ~1 MB a frame). */
const FIELD_BYTES = 390, FRAME_BYTES = 3
/** Phones get no grid finer than 500 m (250 m is ~670 MB of fields), in the mesoscale mode none finer than 2 km (1 km: ~540 MB). */
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
const PHONE_MIN: Record<Mode, number> = { fine: .5, meso: 2 }
const km = (v: number) => v >= 1 ? `${decimal(v, v % 1 ? 1 : 0)} ${L('км', 'km')}` : `${v * 1000} ${L('м', 'm')}`

export interface PreciseHost {
  /** The settings going on (the run takes them with the chosen spacing). */
  config: () => SimConfig
  /** Called with true when the run starts (the live run pauses), false when it ends. */
  onRunning: (running: boolean) => void
  /** Plays frames back on the page (as "Play back a precise run…" does with a file). */
  play: (frames: Blob) => Promise<void>
}

/** Threads for the run: the page's limit, one without cross-origin isolation (no shared memory). */
function threads() {
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') return 1
  return Math.max(1, Math.min(MAX_THREADS, (navigator.hardwareConcurrency || 1) - 1))
}

/** The last run's frames in the browser's storage, if any. */
async function storedFrames(): Promise<File | null> {
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(PRECISE_DIR)
    const file = await (await dir.getFileHandle(PRECISE_FILE)).getFile()
    return file.size > 0 ? file : null
  } catch { return null }
}

const saveBlob = (name: string, blob: Blob) => {
  const url = URL.createObjectURL(blob), a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
const mb = (bytes: number) => `${decimal(bytes / 2 ** 20, bytes < 10 * 2 ** 20 ? 1 : 0)} ${L('МБ', 'MB')}`
const minutesText = (s: number) => s < 5400 ? `${Math.max(1, Math.round(s / 60))} ${L('мин', 'min')}` : `${decimal(s / 3600, 1)} ${L('ч', 'h')}`

export class PreciseDialog {
  private readonly dialog: HTMLDialogElement
  private readonly host: PreciseHost
  private choice: Choice = { ...DEFAULTS.fine, threads: threads(), seed: null, domain: 'current' }
  /** The kind of run the choices are now for (its own options and bounds; switching it sets its defaults). */
  private mode: Mode | null = null
  private worker: Worker | null = null
  private paused = false
  /** What the finished run left: its frames (a file in the storage or a blob) and its final state. */
  private result: { frames: Blob; state: ArrayBuffer; name: string } | null = null

  constructor(host: PreciseHost) {
    this.host = host
    const seg = (name: Segment, label: string) => `<span class="label">${label}</span><div class="seg seg--block" data-precise="${name}"></div>`
    document.body.insertAdjacentHTML('beforeend', `<dialog class="modal modal--wide video-dialog" id="preciseDialog"><form method="dialog" style="display:contents">
      <h2 class="modal__title">${L('Точный прогон', 'Precise run')}</h2>
      <p class="modal__text" id="preciseIntro"></p>
      <div class="video-settings">
        ${seg('spacing', L('Шаг сетки', 'Grid spacing'))}
        ${seg('minutes', L('Время модели', 'Model time'))}
        ${seg('every', L('Кадр каждые', 'A frame every'))}
      </div>
      <details class="precise-more"><summary>${L('Дополнительно', 'More')}</summary><div class="precise-more__grid">
        <label class="field"><span class="label" id="preciseSpacingLabel"></span><input class="input" type="number" id="preciseSpacingIn" step="0.05"></label>
        <label class="field"><span class="label" id="preciseMinutesLabel"></span><input class="input" type="number" id="preciseMinutesIn" step="5"></label>
        <label class="field"><span class="label">${L(`Кадр каждые, с (кратно шагу ${DT} с)`, `A frame every, s (a multiple of the ${DT} s step)`)}</span><input class="input" type="number" id="preciseEveryIn" min="${DT}" step="${DT}"></label>
        <label class="field"><span class="label">${L(`Потоков (1–${threads()})`, `Threads (1–${threads()})`)}</span><input class="input" type="number" id="preciseThreadsIn" min="1" max="${threads()}" step="1"></label>
        <label class="field"><span class="label">${L('Зерно (пусто — как у опыта)', 'Seed (empty — the run’s own)')}</span><input class="input" type="number" id="preciseSeedIn" step="1" placeholder="—"></label>
        <label class="field"><span class="label">${L('Область', 'Domain')}</span><span class="select"><select id="preciseDomainIn"><option value="current">${L('как у опыта', 'the run’s own')}</option><option value="standard">${L('стандартная 48 × 36 км', 'standard 48 × 36 km')}</option><option value="large">${L('большая 96 × 72 км (вчетверо больше узлов)', 'large 96 × 72 km (four times the nodes)')}</option><option value="meso">${L('мезомасштаб 192 × 144 км (шаг 1–4 км, до 6 ч)', 'mesoscale 192 × 144 km (1-4 km spacing, up to 6 h)')}</option></select></span></label>
      </div><p class="modal__text">${L('Шаг модели остаётся 3 с: на 250 м он устойчив (проверено). Тот же опыт с тем же зерном даёт тот же прогон при любом числе потоков. Меньше потоков — медленнее, но ноутбук свободнее.', 'The model step stays 3 s: it is stable at 250 m (checked). The same run with the same seed gives the same result at any number of threads. Fewer threads — slower, but the laptop stays freer.')}</p></details>
      <p class="modal__text" id="preciseSummary"></p>
      <div class="video-progress" id="preciseProgress" hidden><progress id="preciseBar" max="1" value="0"></progress><span class="t-caption" id="preciseStatus"></span></div>
      <p class="modal__text video-error" id="preciseError" role="alert" hidden></p>
      <div class="modal__actions">
        <button type="button" class="btn btn--quiet" id="preciseClose">${L('Закрыть', 'Close')}</button>
        <button type="button" class="btn" id="preciseLast" hidden>${L('Проиграть прошлый', 'Play the last one')}</button>
        <button type="button" class="btn" id="precisePause" hidden>${L('Пауза', 'Pause')}</button>
        <button type="button" class="btn" id="preciseStop" hidden>${L('Остановить', 'Stop')}</button>
        <button type="button" class="btn" id="preciseFrames" hidden title="${L('Кадры прогона (.mlframes): их открывает «Опыт» → «Проиграть точный прогон…»', 'The run’s frames (.mlframes): “Run” → “Play back a precise run…” opens them')}">${L('Кадры', 'Frames')}</button>
        <button type="button" class="btn" id="preciseState" hidden title="${L('Состояние в конце (.meteolab): открыв его, можно считать дальше на этой сетке', 'The state at the end (.meteolab): open it to go on computing on this grid')}">.meteolab</button>
        <button type="button" class="btn btn--primary" id="precisePlay" hidden>${L('Проиграть', 'Play back')}</button>
        <button type="button" class="btn btn--primary" id="preciseStart">${L('Запустить', 'Run')}</button>
      </div>
    </form></dialog>`)
    this.dialog = document.querySelector<HTMLDialogElement>('#preciseDialog')!
    this.dialog.querySelectorAll<HTMLElement>('[data-precise]').forEach(s => s.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]')
      if (!b || this.worker || b.disabled) return
      this.choice[s.dataset.precise as Segment] = Number(b.dataset.value)
      this.show()
    }))
    const field = (id: string, set: (v: string) => void) => this.$<HTMLInputElement>(id).addEventListener('change', e => { if (!this.worker) { set((e.target as HTMLInputElement).value); this.show() } })
    const limits = () => LIMITS[this.mode ?? 'fine']
    field('#preciseSpacingIn', v => { if (v) this.choice.spacing = Math.round(clamp(Number(v), limits().spacing) * 1000) / 1000 })
    field('#preciseMinutesIn', v => { if (v) this.choice.minutes = Math.round(clamp(Number(v), limits().minutes)) })
    field('#preciseEveryIn', v => { if (v) this.choice.every = Math.round(clamp(Number(v), limits().every) / DT) * DT })
    field('#preciseThreadsIn', v => { if (v) this.choice.threads = Math.round(clamp(Number(v), [1, threads()])) })
    field('#preciseSeedIn', v => { this.choice.seed = v === '' ? null : Math.trunc(Number(v)) })
    field('#preciseDomainIn', v => { this.choice.domain = v as Domain })
    this.$('#preciseStart').addEventListener('click', () => this.start())
    this.$('#precisePause').addEventListener('click', () => this.pause(!this.paused))
    this.$('#preciseStop').addEventListener('click', () => this.send({ type: 'stop' }))
    this.$('#preciseClose').addEventListener('click', () => this.dialog.close())
    this.$('#precisePlay').addEventListener('click', () => { if (this.result) void this.playBack(this.result.frames) })
    this.$('#preciseLast').addEventListener('click', async () => { const f = await storedFrames(); if (f) void this.playBack(f) })
    this.$('#preciseFrames').addEventListener('click', () => { if (this.result) saveBlob(`${this.result.name}.mlframes`, this.result.frames) })
    this.$('#preciseState').addEventListener('click', () => { if (this.result) saveBlob(`${this.result.name}.meteolab`, new Blob([this.result.state])) })
    // Closing the page loses a run going on.
    addEventListener('beforeunload', e => { if (this.worker) e.preventDefault() })
  }

  private $<T extends HTMLElement = HTMLElement>(s: string) { return this.dialog.querySelector<T>(s)! }
  private send(message: PreciseRequest) { this.worker?.postMessage(message) }

  async open() {
    this.show(); this.dialog.showModal()
    if (!this.worker && !this.result) this.$('#preciseLast').hidden = !(await storedFrames())
  }

  /** The settings of the run: the ones going on with the choices laid over. */
  private runConfig(): SimConfig {
    const c: SimConfig = { ...structuredClone(this.host.config()), spacing: this.choice.spacing }
    if (this.choice.seed !== null) c.seed = this.choice.seed
    if (this.choice.domain !== 'current') { c.domain = this.choice.domain; delete c.domainSize }
    return c
  }

  /** The choices, the estimate and which buttons show. */
  private show() {
    const domain = this.choice.domain === 'current' ? this.host.config().domain : this.choice.domain, mode: Mode = domain === 'meso' ? 'meso' : 'fine'
    if (mode !== this.mode) this.setMode(mode)
    if (COARSE && this.choice.spacing < PHONE_MIN[mode]) this.choice.spacing = PHONE_MIN[mode]
    const values: [string, string][] = [['#preciseSpacingIn', String(this.choice.spacing)], ['#preciseMinutesIn', String(this.choice.minutes)], ['#preciseEveryIn', String(this.choice.every)], ['#preciseThreadsIn', String(this.choice.threads)], ['#preciseSeedIn', this.choice.seed === null ? '' : String(this.choice.seed)], ['#preciseDomainIn', this.choice.domain]]
    for (const [id, v] of values) { const input = this.$<HTMLInputElement>(id); if (document.activeElement !== input) input.value = v; input.disabled = !!this.worker }
    this.dialog.querySelectorAll<HTMLElement>('[data-precise]').forEach(s => s.querySelectorAll<HTMLButtonElement>('button').forEach(b => {
      const v = Number(b.dataset.value), key = s.dataset.precise as Segment
      b.setAttribute('aria-pressed', String(this.choice[key] === v))
      b.disabled = !!this.worker || (key === 'spacing' && COARSE && v < PHONE_MIN[mode])
    }))
    const c = this.runConfig(), g = domainGrid(c.domain, c.top, c.domainSize, c.spacing), nodes = g.nx * g.ny * g.nz
    // The device's memory (GB, Chrome only, at most 8): fields above half of it are a risk.
    const device = (navigator as { deviceMemory?: number }).deviceMemory, tight = device !== undefined && nodes * FIELD_BYTES > device * 2 ** 30 / 2
    const frames = Math.floor(this.choice.minutes * 60 / this.choice.every) + 1
    this.$('#preciseSummary').textContent = L(
      `Сетка ${g.nx} × ${g.ny} × ${g.nz} = ${decimal(nodes / 1e6, 2)} млн узлов · поля ~${mb(nodes * FIELD_BYTES)} памяти · кадров ${frames}, ~${mb(nodes * FRAME_BYTES * frames)} · потоков ${this.choice.threads}, зерно ${c.seed}. Время счёта — по первым шагам.${COARSE ? ` На телефоне — не мельче ${km(PHONE_MIN[mode])}.` : ''}${tight ? ` Полям нужно больше половины памяти устройства (~${device} ГБ): вкладка может упасть.` : ''}`,
      `Grid ${g.nx} × ${g.ny} × ${g.nz} = ${decimal(nodes / 1e6, 2)} M nodes · fields ~${mb(nodes * FIELD_BYTES)} of memory · ${frames} frames ~${mb(nodes * FRAME_BYTES * frames)} · ${this.choice.threads} threads, seed ${c.seed}. The computing time — from the first steps.${COARSE ? ` On a phone — no finer than ${km(PHONE_MIN[mode])}.` : ''}${tight ? ` The fields need over half the device’s memory (~${device} GB): the tab may crash.` : ''}`)
    const busy = !!this.worker, done = !!this.result && !busy
    this.$('#preciseStart').hidden = busy || done
    this.$('#precisePause').hidden = this.$('#preciseStop').hidden = !busy
    this.$('#precisePlay').hidden = this.$('#preciseFrames').hidden = this.$('#preciseState').hidden = !done
    if (busy || done) this.$('#preciseLast').hidden = true
    this.$('#preciseClose').textContent = busy ? L('Свернуть', 'Hide') : L('Закрыть', 'Close')
  }

  /** The options, bounds and texts of a kind of run, and its defaults for the spacing, the length and the frames. */
  private setMode(mode: Mode) {
    this.mode = mode; Object.assign(this.choice, DEFAULTS[mode])
    const text = { spacing: km, minutes: (v: number) => v < 120 ? `${v} ${L('мин', 'min')}` : `${v / 60} ${L('ч', 'h')}`, every: (v: number) => v < 60 ? `${v} ${L('с', 's')}` : `${v / 60} ${L('мин', 'min')}` }
    this.dialog.querySelectorAll<HTMLElement>('[data-precise]').forEach(s => {
      const key = s.dataset.precise as Segment
      s.innerHTML = OPTIONS[mode][key].map(v => `<button type="button" data-value="${v}">${text[key](v)}</button>`).join('')
    })
    const { spacing, minutes, every } = LIMITS[mode], range = ([lo, hi]: readonly [number, number]) => `${decimal(lo, lo < 1 ? 2 : 0)}–${decimal(hi, hi % 1 ? 1 : 0)}`
    Object.assign(this.$<HTMLInputElement>('#preciseSpacingIn'), { min: String(spacing[0]), max: String(spacing[1]) })
    Object.assign(this.$<HTMLInputElement>('#preciseMinutesIn'), { min: String(minutes[0]), max: String(minutes[1]) })
    this.$<HTMLInputElement>('#preciseEveryIn').max = String(every[1])
    this.$('#preciseSpacingLabel').textContent = `${L('Шаг сетки, км', 'Grid spacing, km')} (${range(spacing)})`
    this.$('#preciseMinutesLabel').textContent = `${L('Время модели, мин', 'Model time, min')} (${range(minutes)})`
    this.$('#preciseIntro').textContent = mode === 'fine'
      ? L('Этот опыт на мелкой сетке: тот же размер области, шаг сетки меньше. Считается в фоне на всех ядрах, живой расчёт стоит; потом кадры проигрываются здесь со всеми приборами. Вкладка должна оставаться открытой — длинные прогоны удобнее в Node (npm run precise).', 'This run on a fine grid: the same domain, a finer spacing. It is computed in the background on every core while the live run waits; then the frames play back here with every instrument. Keep the tab open — long runs are easier in Node (npm run precise).')
      : L('Мезомасштаб заранее: линия шквалов и МКС живут 3–6 ч — дольше, чем стоит ждать живого расчёта. Та же область на 2 км или мельче (на 1 км внутреннее устройство линии разрешено лучше) считается в фоне на всех ядрах, живой расчёт стоит; потом кадры проигрываются здесь со всеми приборами. Вкладка должна оставаться открытой — многочасовые прогоны удобнее в Node (npm run precise).', 'The mesoscale ahead of time: squall lines and MCSs live 3-6 h — longer than the live run is worth waiting for. The same domain on 2 km or finer (1 km resolves a line’s inner structure better) is computed in the background on every core while the live run waits; then the frames play back here with every instrument. Keep the tab open — runs of hours are easier in Node (npm run precise).')
  }

  private start() {
    if (this.worker) return
    const config = this.runConfig(), { minutes, every } = this.choice
    this.result = null; this.paused = false
    this.$('#preciseError').hidden = true; this.$('#preciseProgress').hidden = false
    this.$<HTMLProgressElement>('#preciseBar').value = 0; this.$('#preciseStatus').textContent = L('Подготовка…', 'Preparing…')
    const worker = this.worker = new Worker(new URL('./precise.worker.ts', import.meta.url), { type: 'module' })
    this.host.onRunning(true); this.show()
    const name = `meteolab-precise-${Math.round(this.choice.spacing * 1000)}m-${minutes}min-seed${config.seed}`
    let stored = true
    worker.addEventListener('message', ({ data }: MessageEvent<PreciseReply>) => {
      if (data.type === 'started') stored = data.stored
      else if (data.type === 'progress') {
        const left = data.msPerStep / 1000 * (minutes * 60 - data.time) / DT
        this.$<HTMLProgressElement>('#preciseBar').value = data.time / (minutes * 60)
        this.$('#preciseStatus').textContent = this.paused ? L('Пауза', 'Paused') : L(
          `${decimal(data.time / 60, 1)} из ${minutes} мин модели · ~${minutesText(left)} осталось · ${Math.round(data.msPerStep)} мс на шаг · поток ${Math.round(data.updraft)} м/с · кадров ${data.frames}, ${mb(data.bytes)}${stored ? '' : ' (в памяти)'}`,
          `${decimal(data.time / 60, 1)} of ${minutes} model min · ~${minutesText(left)} left · ${Math.round(data.msPerStep)} ms a step · updraught ${Math.round(data.updraft)} m/s · ${data.frames} frames, ${mb(data.bytes)}${stored ? '' : ' (in memory)'}`)
      } else if (data.type === 'done') void this.finish(data, name)
      else { this.$('#preciseError').textContent = `${L('Ошибка', 'Error')}: ${data.message}`; this.$('#preciseError').hidden = false; this.end() }
    })
    worker.addEventListener('error', e => { this.$('#preciseError').textContent = `${L('Ошибка', 'Error')}: ${e.message}`; this.$('#preciseError').hidden = false; this.end() })
    this.send({ type: 'start', config, minutes, every, threads: this.choice.threads, lang: lang() })
  }

  private async finish(data: Extract<PreciseReply, { type: 'done' }>, name: string) {
    const frames = data.frames ?? await storedFrames()
    this.end()
    if (!frames) { this.$('#preciseError').textContent = L('Кадры не найдены в хранилище браузера', 'The frames were not found in the browser’s storage'); this.$('#preciseError').hidden = false; return }
    this.result = { frames, state: data.state, name }
    this.$<HTMLProgressElement>('#preciseBar').value = 1
    this.$('#preciseStatus').textContent = L(`${data.stopped ? 'Остановлен' : 'Готово'}: ${decimal(data.time / 60, 1)} мин модели, кадры ${mb(frames.size)}`, `${data.stopped ? 'Stopped' : 'Done'}: ${decimal(data.time / 60, 1)} model min, frames ${mb(frames.size)}`)
    this.show()
    if (!this.dialog.open) this.dialog.showModal()
  }

  /** The worker goes (its helpers with it), the live run may go on. */
  private end() {
    this.worker?.terminate(); this.worker = null
    this.host.onRunning(false); this.show()
  }

  private pause(on: boolean) {
    this.paused = on; this.send({ type: on ? 'pause' : 'resume' })
    this.$('#precisePause').textContent = on ? L('Продолжить', 'Resume') : L('Пауза', 'Pause')
    if (on) this.$('#preciseStatus').textContent = L('Пауза', 'Paused')
  }

  private async playBack(frames: Blob) {
    this.dialog.close()
    await this.host.play(frames)
  }
}
