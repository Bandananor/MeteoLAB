// The storm's course over model time: the instability of the live sounding (SB CAPE and CIN, src/core/live.ts), strongest
// updraught, rotation (UH 2-5 km) and rain at the ground, sampled every 30 model seconds for the whole domain and drawn
// as four small stacked plots in the side panel. Under the rotation
// plot, the stretches when the updraught core itself rotated (the model's mesocyclone criterion, MESO_CORE_ZETA) are
// shaded, dark once that held MESO_PERSISTENCE: UH alone also counts the vortex pairs of weak-shear storms.
import { MESO_PERSISTENCE } from './core'

/** One sample: model time (s), the values the plots show and how long (s) the core rotation had held then. */
export interface TimelinePoint { t: number; cape: number; cin: number; updraft: number; uh: number; rain: number; rainTotal: number; rotationHeld: number }

type Key = 'cape' | 'cin' | 'updraft' | 'uh' | 'rain'
/** One plot; `second` draws another value on the same axis (CIN under CAPE). */
interface Series { key: Key; label: string; unit: string; color: string; floor: number; rotation?: boolean; second?: { key: Key; label: string; color: string } }

const SERIES: Series[] = [
  { key: 'cape', label: 'Неустойчивость (SB, среда сейчас)', unit: 'Дж/кг', color: '#c97a2a', floor: 500, second: { key: 'cin', label: 'CIN', color: '#4d86b3' } },
  { key: 'updraft', label: 'Макс. восходящий поток', unit: 'м/с', color: '#c4553a', floor: 10 },
  { key: 'uh', label: 'Вращение потока, UH 2–5 км', unit: 'м²/с²', color: '#7b3fa0', floor: 200, rotation: true },
  { key: 'rain', label: 'Интенсивность дождя', unit: 'мм/ч', color: '#3f6fa3', floor: 10 },
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

  draw(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const pts = this.points, rows = SERIES.length, rowH = h / rows, left = 4, right = w - 4
    // At least 30 minutes on the time axis, then the whole run.
    const span = Math.max(1800, pts.length ? pts[pts.length - 1].t : 0), X = (t: number) => left + (right - left) * t / span
    SERIES.forEach((s, r) => {
      const top = r * rowH + 12, bottom = (r + 1) * rowH - 10, values = pts.map(p => p[s.key]), second = s.second ? pts.map(p => p[s.second!.key]) : []
      const max = niceMax(Math.max(s.floor, ...values, ...second)), Y = (v: number) => bottom - (bottom - top) * Math.min(1, v / max)
      ctx.strokeStyle = '#d2dade'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(left, bottom + .5); ctx.lineTo(right, bottom + .5); ctx.stroke()
      // Minute ticks every 10 min.
      ctx.fillStyle = '#8a9aa2'
      for (let m = 10; m * 60 <= span; m += 10) { const x = X(m * 60); ctx.beginPath(); ctx.moveTo(x, bottom); ctx.lineTo(x, bottom + 3); ctx.stroke(); if (r === rows - 1) ctx.fillText(`${m}′`, x - 6, bottom + 9) }
      const now = values.length ? values[values.length - 1] : 0, peak = values.length ? Math.max(...values) : 0
      ctx.fillStyle = '#5f7079'; ctx.fillText(`${s.label}, ${s.unit}`, left, top - 3)
      ctx.fillStyle = '#253943'
      const extra = s.key === 'rain' && pts.length ? `  сумма ${pts[pts.length - 1].rainTotal.toFixed(1)} мм` : ''
      const readout = s.second ? `CAPE ${format(now)} / ${s.second.label} ${format(second[second.length - 1] ?? 0)}` : `${format(now)} (макс. ${format(peak)})${extra}`
      ctx.fillText(readout, right - ctx.measureText(readout).width, top - 3)
      ctx.fillStyle = '#8a9aa2'; ctx.fillText(String(max), left + 1, top + 7)
      if (s.rotation) {
        // Shade each sample interval by the core rotation at its end: light while it holds, dark once a mesocyclone.
        for (let i = 1; i < pts.length; i++) {
          const held = pts[i].rotationHeld
          if (held <= 0) continue
          ctx.fillStyle = held >= MESO_PERSISTENCE ? '#cdb8dc' : '#e2d8ea'
          ctx.fillRect(X(pts[i - 1].t), top, X(pts[i].t) - X(pts[i - 1].t) + .5, bottom - top)
        }
        if (pts.some(p => p.rotationHeld >= MESO_PERSISTENCE)) { ctx.fillStyle = '#8a6ea0'; const label = 'мезоциклон'; ctx.fillText(label, right - ctx.measureText(label).width, top + 7) }
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
