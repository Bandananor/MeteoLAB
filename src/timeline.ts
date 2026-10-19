// The storm's course over model time: the instability of the live sounding (SB CAPE and CIN, src/core/live.ts), strongest
// updraught, rotation (UH 2-5 km), rain at the ground and the flash rate (2.3), sampled every 30 model seconds for the
// whole domain and drawn as five small stacked plots in the side panel. Under the rotation
// plot, the stretches when the updraught core itself rotated (the model's mesocyclone criterion, MESO_CORE_ZETA) are
// shaded, dark once that held MESO_PERSISTENCE: UH alone also counts the vortex pairs of weak-shear storms.
import { L } from './i18n'
import { MESO_PERSISTENCE } from './core'
import { minuteMark } from './clock'
import { chartPalette } from './theme'

/** One sample: model time (s), the values the plots show and how long (s) the core rotation had held then. */
export interface TimelinePoint { t: number; cape: number; cin: number; updraft: number; uh: number; rain: number; rainTotal: number; rotationHeld: number; /** Flashes in the last model minute. */ flashes: number }

type Key = 'cape' | 'cin' | 'updraft' | 'uh' | 'rain' | 'flashes'
/** One plot; `second` draws another value on the same axis (CIN under CAPE). */
interface Series { key: Key; label: string; unit: string; color: string; floor: number; rotation?: boolean; second?: { key: Key; label: string; color: string } }

const SERIES: Series[] = [
  { key: 'cape', label: L('CAPE / CIN от земли', 'Surface CAPE / CIN'), unit: L('Дж/кг', 'J/kg'), color: '#c97a2a', floor: 500, second: { key: 'cin', label: 'CIN', color: '#4d86b3' } },
  { key: 'updraft', label: L('Восходящий поток', 'Updraught'), unit: L('м/с', 'm/s'), color: '#c4553a', floor: 10 },
  { key: 'uh', label: L('UH 2–5 км', 'UH 2–5 km'), unit: L('м²/с²', 'm²/s²'), color: '#7b3fa0', floor: 200, rotation: true },
  { key: 'rain', label: L('Дождь', 'Rain'), unit: L('мм/ч', 'mm/h'), color: '#3f6fa3', floor: 10 },
  { key: 'flashes', label: L('Молнии', 'Lightning'), unit: L('вспышек/мин', 'flashes/min'), color: '#8a6cd8', floor: 10 },
]

/** Samples every SAMPLE seconds of model time; a restart (time going back) starts a new record. */
export const SAMPLE = 30

export class Timeline {
  readonly points: TimelinePoint[] = []

  /** Adds the current state if a sample is due; returns true when it did (the plots need redrawing). */
  record(point: TimelinePoint) {
    const last = this.points[this.points.length - 1]
    if (last && point.t < last.t) this.points.length = 0
    if (last && point.t - last.t < SAMPLE && this.points.length) return false
    this.points.push(point)
    return true
  }

  /** Drops the points after model time t (a rewind). */
  truncate(t: number) { while (this.points.length && this.points[this.points.length - 1].t > t) this.points.pop() }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const c = chartPalette(), pts = this.points, rows = SERIES.length, rowH = h / rows, left = 4, right = w - 4
    // At least 30 minutes on the time axis, then the whole run.
    const span = Math.max(1800, pts.length ? pts[pts.length - 1].t : 0), X = (t: number) => left + (right - left) * t / span
    SERIES.forEach((s, r) => {
      const top = r * rowH + 19, bottom = (r + 1) * rowH - 14, values = pts.map(p => p[s.key]), second = s.second ? pts.map(p => p[s.second!.key]) : []
      const max = niceMax(Math.max(s.floor, ...values, ...second)), Y = (v: number) => bottom - (bottom - top) * Math.min(1, v / max)
      ctx.strokeStyle = c.grid; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(left, bottom + .5); ctx.lineTo(right, bottom + .5); ctx.stroke()
      // Minute ticks every 10 min.
      ctx.fillStyle = c.label
      for (let m = 10; m * 60 <= span; m += 10) { const x = X(m * 60); ctx.beginPath(); ctx.moveTo(x, bottom); ctx.lineTo(x, bottom + 3); ctx.stroke(); if (r === rows - 1) ctx.fillText(minuteMark(m), x - 6, bottom + 12) }
      const now = values.length ? values[values.length - 1] : 0, peak = values.length ? Math.max(...values) : 0
      ctx.fillStyle = c.text2; ctx.fillText(`${s.label}, ${s.unit}`, left, top - 6)
      ctx.fillStyle = c.text
      const readout = s.second ? `${format(now)} / ${format(second[second.length - 1] ?? 0)}` : `${format(now)} (${L('макс.', 'max')} ${format(peak)})`
      ctx.fillText(readout, right - ctx.measureText(readout).width, top - 6)
      ctx.fillStyle = c.label; ctx.fillText(String(max), left + 1, top + 10)
      if (s.rotation) {
        // Shade each sample interval by the core rotation at its end: light while it holds, dark once a mesocyclone.
        for (let i = 1; i < pts.length; i++) {
          const held = pts[i].rotationHeld
          if (held <= 0) continue
          ctx.fillStyle = held >= MESO_PERSISTENCE ? '#cdb8dc' : '#e2d8ea'
          ctx.fillRect(X(pts[i - 1].t), top, X(pts[i].t) - X(pts[i - 1].t) + .5, bottom - top)
        }
        if (pts.some(p => p.rotationHeld >= MESO_PERSISTENCE)) { ctx.fillStyle = '#8a6ea0'; const label = L('мезоциклон', 'mesocyclone'); ctx.fillText(label, right - ctx.measureText(label).width, top + 10) }
      }
      if (pts.length < 2) return
      const curve = (key: Key, color: string) => {
        ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.beginPath()
        pts.forEach((p, i) => { const x = X(p.t), y = Y(p[key]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y) })
        ctx.stroke()
      }
      if (s.second) curve(s.second.key, s.second.color)
      curve(s.key, s.color)
    })
  }
}

const format = (v: number) => v >= 100 ? v.toFixed(0) : v.toFixed(1)

/** The next multiple of half a power of ten at or above v (50.3 -> 55, 340 -> 350): a tight axis. */
function niceMax(v: number) {
  const step = 10 ** Math.floor(Math.log10(v)) / 2
  return Math.ceil(v / step) * step
}
