// The video recording of the 3D view (2.9, the user's idea 19.10.2026): frame by frame on the recording's own clock
// (plan.ts), encoded by the browser's H.264 encoder (WebCodecs) and written as MP4 (mp4.ts). The settings are kept
// in this browser.
import type { Atmosphere } from '../atmosphere'
import { elapsed, timeOfDay } from '../clock'
import { DT } from '../core'
import { decimal, L } from '../i18n'
import { avcCodec, type Sample, writeMp4 } from './mp4'
import { mediaStamp } from '../export/stamp'
import { type Caption, drawCaptions } from './captions'
import { bitrate, frameCount, frameStamp, frameTime, ORBIT_SPEED, type RecordCamera, type RecordSettings, screenSize, SIZES, stepsTo } from './plan'

const KEY = 'meteolab-video'
/** A key frame every this many seconds of video (seeking in a player, cutting in an editor). */
const KEY_EVERY = 2
/** Encoded frames waiting in the encoder before the next is drawn (memory on a 4K recording). */
const QUEUE = 3

interface Choice { seconds: number; fps: number; speed: number; size: string; shape: 'wide' | 'vertical' | 'screen'; camera: RecordCamera; captions: 'off' | 'on' }
const DEFAULTS: Choice = { seconds: 10, fps: 30, speed: 60, size: '1080p', shape: 'wide', camera: 'still', captions: 'off' }
const OPTIONS = {
  seconds: [5, 10, 20, 30, 60],
  fps: [30, 60],
  speed: [10, 30, 60, 180, 300],
  size: SIZES.map(s => s[0]),
  shape: ['wide', 'vertical', 'screen'],
  camera: ['still', 'orbit', 'ground'],
  captions: ['off', 'on'],
} as const

function load(): Choice {
  try { const c = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (c) return { ...DEFAULTS, ...c } } catch { /* storage unavailable */ }
  return { ...DEFAULTS }
}
const save = (c: Choice) => { try { localStorage.setItem(KEY, JSON.stringify(c)) } catch { /* kept for this visit only */ } }

/** Model time for a span of seconds: 30 с, 5 мин, 1 ч 10 мин. */
function span(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)} ${L('с', 's')}`
  const m = Math.round(seconds / 60)
  return m < 60 ? `${m} ${L('мин', 'min')}` : `${Math.floor(m / 60)} ${L('ч', 'h')}${m % 60 ? ` ${m % 60} ${L('мин', 'min')}` : ''}`
}
/** Another task, without the timers' throttling in a background tab (setTimeout waits a second there). */
const nextTask = () => new Promise<void>(resolve => { const c = new MessageChannel(); c.port1.onmessage = () => resolve(); c.port2.postMessage(0) })

/** The H.264 profiles to try, the High first: some encoders (phones' hardware) take only Main or Baseline. */
const profiles = (codec: string) => ['6400', '4d00', '4200'].map(p => codec.replace('6400', p))

export class VideoRecorder {
  private readonly dialog: HTMLDialogElement
  private choice = load()
  private busy = false; private stopping: 'save' | 'cancel' | null = null
  /** The run (main.ts makes a new one on every restart), the run's starting hour, standing on the ground. */
  private readonly sim: () => Atmosphere; private readonly hour: () => number; private readonly standOnGround: () => void
  /** The captions of the frame being drawn (main.ts: the scenario, the time, what the storm is doing). */
  private readonly caption: () => Caption
  constructor(sim: () => Atmosphere, hour: () => number, standOnGround: () => void, caption: () => Caption) {
    this.sim = sim; this.hour = hour; this.standOnGround = standOnGround; this.caption = caption
    const seg = (name: keyof typeof OPTIONS, label: string, text: (v: string) => string) => `<span class="label">${label}</span><div class="seg seg--block" data-video="${name}">${OPTIONS[name].map(v => `<button type="button" data-value="${v}">${text(String(v))}</button>`).join('')}</div>`
    document.body.insertAdjacentHTML('beforeend', `<dialog class="modal modal--wide video-dialog" id="videoDialog"><form method="dialog" style="display:contents">
      <h2 class="modal__title">${L('Видео', 'Video')}</h2>
      <p class="modal__text">${L('Не запись экрана: расчёт встаёт, и каждый кадр модель проходит своё время, а вид рисуется в выбранном размере и высоком качестве — сколько бы ни занимал кадр. Поэтому видео идёт ровно на любом устройстве. Молнии в видео — в настоящем времени, как на экране.', 'Not a screen capture: the run pauses, the model steps through each frame’s time and the view is drawn at the chosen size and the high quality however long a frame takes. So the video plays evenly on any device. Lightning in the video runs in real time, as on the screen.')}</p>
      <div class="video-settings">
        ${seg('seconds', L('Длительность видео', 'Video length'), v => `${v} ${L('с', 's')}`)}
        ${seg('speed', L('Время модели за секунду видео', 'Model time per second of video'), v => span(Number(v)))}
        ${seg('fps', L('Кадров в секунду', 'Frames per second'), v => v)}
        ${seg('size', L('Размер', 'Size'), v => v)}
        ${seg('shape', L('Форма кадра', 'Frame shape'), v => v === 'wide' ? '16:9' : v === 'vertical' ? L('9:16 — для роликов', '9:16 — for shorts') : L('как экран', 'as the screen'))}
        ${seg('camera', L('Камера', 'Camera'), v => ({ still: L('как сейчас', 'as now'), orbit: L('облёт', 'orbit'), ground: L('с земли', 'from the ground') })[v as RecordCamera])}
        ${seg('captions', L('Подписи на кадре', 'Captions on the frame'), v => v === 'on' ? L('сценарий, время, что происходит', 'scenario, time, what happens') : L('нет', 'none'))}
      </div>
      <p class="modal__text" id="videoSummary"></p>
      <div class="video-progress" id="videoProgress" hidden><progress id="videoBar" max="1" value="0"></progress><span class="t-caption" id="videoStatus"></span></div>
      <p class="modal__text video-error" id="videoError" role="alert" hidden></p>
      <div class="modal__actions"><button type="button" class="btn btn--quiet" id="videoCancel">${L('Отмена', 'Cancel')}</button><button type="button" class="btn btn--primary" id="videoStart">${L('Записать', 'Record')}</button></div>
    </form></dialog>`)
    this.dialog = document.querySelector<HTMLDialogElement>('#videoDialog')!
    this.dialog.querySelectorAll<HTMLElement>('[data-video]').forEach(s => s.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]')
      if (!b || this.busy) return
      const key = s.dataset.video as keyof Choice, v = b.dataset.value!
      ;(this.choice as unknown as Record<string, unknown>)[key] = typeof DEFAULTS[key] === 'number' ? Number(v) : v
      save(this.choice); this.show()
    }))
    this.$('#videoStart').addEventListener('click', () => { if (this.busy) this.stopping = 'save'; else void this.record() })
    this.$('#videoCancel').addEventListener('click', () => { if (this.busy) this.stopping = 'cancel'; else this.dialog.close() })
    // Esc while recording stops it without saving; the dialog closes once the run is back.
    this.dialog.addEventListener('cancel', e => { if (this.busy) { e.preventDefault(); this.stopping = 'cancel' } })
  }

  private $<T extends HTMLElement = HTMLElement>(s: string) { return this.dialog.querySelector<T>(s)! }

  open() { if (!this.busy) { this.$('#videoError').hidden = true; this.$('#videoProgress').hidden = true } this.show(); this.dialog.showModal() }

  /** The settings as chosen: the picture's size from the size and shape. */
  private settings(): RecordSettings {
    const c = this.choice, [, w, h] = SIZES.find(s => s[0] === c.size) ?? SIZES[1], view = this.sim()
    const [width, height] = c.shape === 'wide' ? [w, h] : c.shape === 'vertical' ? [h, w] : screenSize(view.viewWidth, view.viewHeight, w)
    return { seconds: c.seconds, fps: c.fps, speed: c.speed, width, height, camera: c.camera }
  }

  private show() {
    const c = this.choice, s = this.settings(), sim = this.sim(), model = s.seconds * s.speed
    this.dialog.querySelectorAll<HTMLElement>('[data-video]').forEach(seg => seg.querySelectorAll<HTMLButtonElement>('button').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.value === String(c[seg.dataset.video as keyof Choice]))); b.disabled = this.busy
    }))
    const mb = bitrate(s) * s.seconds / 8 / 1e6, slow = s.speed / s.fps < DT
    this.$('#videoSummary').textContent = L(
      `${s.seconds} с видео — ${span(model)} модели: с T+${elapsed(sim.time)} до T+${elapsed(sim.time + model)} (${timeOfDay(this.hour(), sim.time + model)} по местному). ${frameCount(s)} кадров ${s.width} × ${s.height}, ~${decimal(mb, mb < 10 ? 1 : 0)} МБ.${slow ? ' Замедленно: между шагами модели (3 с) кадры плавно смешивают соседние состояния.' : ''}${c.camera === 'orbit' ? ` Облёт — оборот за ${Math.round(360 / ORBIT_SPEED)} с видео.` : ''}`,
      `${s.seconds} s of video — ${span(model)} of the model: from T+${elapsed(sim.time)} to T+${elapsed(sim.time + model)} (${timeOfDay(this.hour(), sim.time + model)} local). ${frameCount(s)} frames ${s.width} × ${s.height}, ~${decimal(mb, mb < 10 ? 1 : 0)} MB.${slow ? ' Slowed down: between the model’s steps (3 s) the frames blend the neighbouring states smoothly.' : ''}${c.camera === 'orbit' ? ` Orbit — a turn per ${Math.round(360 / ORBIT_SPEED)} s of video.` : ''}`)
    this.$('#videoStart').textContent = this.busy ? L('Стоп и сохранить', 'Stop and save') : L('Записать', 'Record')
    this.$('#videoCancel').textContent = this.busy ? L('Отменить запись', 'Discard') : L('Закрыть', 'Close')
  }

  private fail(text: string) { const e = this.$('#videoError'); e.textContent = text; e.hidden = false }

  /** The encoder's settings the browser takes for this picture, or null. */
  private async encoderConfig(s: RecordSettings): Promise<VideoEncoderConfig | null> {
    const codec = avcCodec(s.width, s.height, s.fps)
    if (!codec) return null
    for (const c of profiles(codec)) {
      const config: VideoEncoderConfig = { codec: c, width: s.width, height: s.height, bitrate: bitrate(s), framerate: s.fps, avc: { format: 'avc' }, latencyMode: 'quality' }
      try { if ((await VideoEncoder.isConfigSupported(config)).supported) return config } catch { /* not this one */ }
    }
    return null
  }

  private async record() {
    this.$('#videoError').hidden = true
    if (typeof VideoEncoder === 'undefined') { this.fail(L('Этот браузер не умеет кодировать видео (нет WebCodecs). Подойдут Chrome, Edge, Safari 16.4+ или Firefox 130+.', 'This browser cannot encode video (no WebCodecs). Chrome, Edge, Safari 16.4+ or Firefox 130+ will do.')); return }
    const s = this.settings(), config = await this.encoderConfig(s)
    if (!config) { this.fail(L(`Кодировщик H.264 этого устройства не берёт ${s.width} × ${s.height} при ${s.fps} кадрах в секунду. Выберите размер меньше или 30 кадров.`, `This device’s H.264 encoder does not take ${s.width} × ${s.height} at ${s.fps} frames per second. Choose a smaller size or 30 frames.`)); return }
    const sim = this.sim(), samples: Sample[] = []
    // The version, the start and the link to the run, in the file's metadata (roadmap E4).
    const stamp = mediaStamp(L(`Видео модели с T+${elapsed(sim.time)}, ${s.speed}× скорости`, `The model's video from T+${elapsed(sim.time)}, ${s.speed}× speed`))
    let description: Uint8Array | null = null, failure: unknown = null
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); samples.push({ data, key: chunk.type === 'key' })
        const d = meta?.decoderConfig?.description
        if (d && !description) description = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) : new Uint8Array(d.slice(0))
      },
      error: e => { failure = e },
    })
    encoder.configure(config)
    this.busy = true; this.stopping = null; this.show()
    this.$('#videoProgress').hidden = false
    const bar = this.$<HTMLProgressElement>('#videoBar'), status = this.$('#videoStatus')
    const frames = frameCount(s), began = performance.now(), overlay = document.createElement('canvas')
    let done = 0
    try {
      await sim.startRecording()
      if (s.camera === 'ground' && !sim.fromGround) this.standOnGround()
      sim.recordSize({ width: s.width, height: s.height })
      const start = sim.time, clock = performance.now()
      for (let k = 0; k < frames && !this.stopping; k++) {
        const t = frameTime(start, k, s), n = stepsTo(t, sim.heldTime, DT)
        if (n) await sim.stepModel(n)
        sim.showAt(t)
        if (k && s.camera === 'orbit') sim.turnCamera(ORBIT_SPEED / s.fps)
        // The frame is read in the task it is drawn in (the drawing buffer is not kept).
        let picture: CanvasImageSource = sim.recordFrame(clock + k * 1000 / s.fps)
        // Captions go over a copy of the picture (the view's own canvas may be the WebGL one).
        if (this.choice.captions === 'on') {
          if (overlay.width !== s.width || overlay.height !== s.height) { overlay.width = s.width; overlay.height = s.height }
          const ctx = overlay.getContext('2d')!
          ctx.drawImage(picture, 0, 0, s.width, s.height); drawCaptions(ctx, s.width, s.height, this.caption()); picture = overlay
        }
        if (k === 0 && !sim.recordFits()) throw new Error(L(`видеокарта не рисует кадр ${s.width} × ${s.height} — выберите размер меньше`, `the GPU does not draw a ${s.width} × ${s.height} frame — choose a smaller size`))
        const frame = new VideoFrame(picture, { timestamp: frameStamp(k, s.fps), duration: frameStamp(1, s.fps) })
        encoder.encode(frame, { keyFrame: k % (KEY_EVERY * s.fps) === 0 }); frame.close()
        done = k + 1
        while (encoder.encodeQueueSize > QUEUE && !failure) await nextTask()
        if (failure) throw failure
        const spent = (performance.now() - began) / 1000, left = spent / done * (frames - done)
        bar.value = done / frames
        status.textContent = L(`Кадр ${done} из ${frames} · T+${elapsed(t)} · осталось ~${span(left)}`, `Frame ${done} of ${frames} · T+${elapsed(t)} · ~${span(left)} left`)
        await nextTask()
      }
      if (this.stopping === 'cancel' || !done) return
      status.textContent = L('Собираю файл…', 'Writing the file…')
      await encoder.flush()
      if (failure) throw failure
      if (!description) throw new Error(L('кодировщик не дал описания потока', 'the encoder gave no stream description'))
      const file = writeMp4(samples, description, s.width, s.height, s.fps, stamp), local = timeOfDay(this.hour(), sim.time).replace(':', '-')
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([file], { type: 'video/mp4' })); a.download = `meteolab-${local}.mp4`; a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000)
      status.textContent = L(`Готово: ${done} кадров, ${decimal(file.length / 1e6, 1)} МБ, за ${span((performance.now() - began) / 1000)}.`, `Done: ${done} frames, ${decimal(file.length / 1e6, 1)} MB, in ${span((performance.now() - began) / 1000)}.`)
    } catch (e) {
      this.fail(L(`Запись не удалась: ${e instanceof Error ? e.message : String(e)}`, `The recording failed: ${e instanceof Error ? e.message : String(e)}`))
    } finally {
      if (encoder.state !== 'closed') encoder.close()
      sim.recordSize(null); sim.stopRecording()
      const cancelled = this.stopping === 'cancel'
      this.busy = false; this.stopping = null; this.show()
      if (cancelled) this.dialog.close()
    }
  }
}
