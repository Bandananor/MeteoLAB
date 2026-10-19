// Camera settings for the full screen without the interface (a tester's request 19.10.2026): the exposure, as the
// camera's in stops, goes to the renderer's tone mapping (before the film curve, so the highlights roll off as they
// do); brightness, contrast and saturation are a grade over the finished frame (a CSS filter on the canvas, and the
// same filter on a snapshot). Kept per viewer in the browser; the view goes back to neutral outside the full screen.

import { L } from './i18n'

export interface CameraGrade {
  /** Exposure compensation, stops (EV): +1 is twice the light. */ exposure: number
  /** Brightness, contrast and saturation of the finished frame, % (100 = as rendered). */ brightness: number; contrast: number; saturation: number
}

export const NEUTRAL_GRADE: CameraGrade = { exposure: 0, brightness: 100, contrast: 100, saturation: 100 }

/** The settings' sliders: key, label, range, step and unit. */
export const GRADE_SLIDERS: readonly { key: keyof CameraGrade; label: string; min: number; max: number; step: number; unit: string }[] = [
  { key: 'exposure', label: L('Экспозиция', 'Exposure'), min: -2, max: 2, step: .1, unit: 'EV' },
  { key: 'brightness', label: L('Яркость', 'Brightness'), min: 50, max: 150, step: 1, unit: '%' },
  { key: 'contrast', label: L('Контраст', 'Contrast'), min: 50, max: 150, step: 1, unit: '%' },
  { key: 'saturation', label: L('Насыщенность', 'Saturation'), min: 0, max: 200, step: 1, unit: '%' },
]

/** The CSS filter of the grade over the finished frame ('none' when neutral). */
export function gradeFilter(g: CameraGrade) {
  const parts = ([['brightness', g.brightness], ['contrast', g.contrast], ['saturate', g.saturation]] as const).filter(([, v]) => v !== 100)
  return parts.length ? parts.map(([f, v]) => `${f}(${v}%)`).join(' ') : 'none'
}

const KEY = 'meteolab-camera'
/** The saved settings, neutral where missing or unreadable (private windows, blocked storage). */
export function loadGrade(): CameraGrade {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<CameraGrade>, g = { ...NEUTRAL_GRADE }
    for (const s of GRADE_SLIDERS) { const v = saved[s.key]; if (typeof v === 'number' && v >= s.min && v <= s.max) g[s.key] = v }
    return g
  } catch { return { ...NEUTRAL_GRADE } }
}
export function saveGrade(g: CameraGrade) { try { localStorage.setItem(KEY, JSON.stringify(g)) } catch { /* kept for this visit only */ } }
