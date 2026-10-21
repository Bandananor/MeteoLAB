// The instrument screens (radar, Skew-T, weather station) share one shell from the design system (styles/layout.css
// .instrument): a bar with the instrument's name and readings, the screen, and a side panel of sections. They are
// always dark (data-theme="dark" on their root, whatever the page's theme) and lie over the simulator.
import { L } from './i18n'
import { mediaStamp, stampPngBlob } from './export/stamp'
import type { MesoStrength } from './core'

/** Builds a hidden instrument screen in `host`; `screen` goes over its canvas, `side` is the side panel's markup. */
export function instrumentScreen(host: HTMLElement, kind: string, name: string, fields: string, side: string, screen = '') {
  const root = document.createElement('div')
  root.className = `instrument instrument-overlay ${kind}`; root.dataset.theme = 'dark'; root.hidden = true
  root.innerHTML = `
    <header class="ibar"><span class="ibar__name">${name}</span><span class="ibar__sep"></span><span class="ibar__fields">${fields}</span><button class="btn ibar__snap" title="${L('Сохранить экран прибора картинкой PNG', 'Save the instrument’s screen as a PNG image')}">${L('Снимок', 'Snapshot')}</button><button class="btn ibar__close" title="${L('Вернуться к 3D (Esc)', 'Back to 3D (Esc)')}">${L('Закрыть', 'Close')} <span class="kbd">Esc</span></button></header>
    <div class="instrument__body"><div class="instrument__screen"><canvas></canvas>${screen}</div><aside class="instrument__side">${side}</aside></div>`
  host.appendChild(root)
  root.querySelector('.ibar__snap')!.addEventListener('click', () => snapshot(root, kind.replace(/-app$/, '')))
  return root
}

/** The instrument's canvas as a PNG, on the screen's background (a canvas may leave it transparent), named by the time. */
function snapshot(root: HTMLElement, name: string) {
  const canvas = root.querySelector<HTMLCanvasElement>('.instrument__screen > canvas')!, out = document.createElement('canvas')
  out.width = canvas.width; out.height = canvas.height
  const ctx = out.getContext('2d')!
  ctx.fillStyle = instrumentPalette(root).bg; ctx.fillRect(0, 0, out.width, out.height); ctx.drawImage(canvas, 0, 0)
  out.toBlob(async shot => {
    if (!shot) return
    const blob = await stampPngBlob(shot, mediaStamp(L(`Экран прибора «${name}»`, `The “${name}” instrument’s screen`)))
    const a = document.createElement('a'), now = new Date(), two = (n: number) => String(n).padStart(2, '0')
    a.href = URL.createObjectURL(blob); a.download = `meteolab-${name}-${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}.png`; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }, 'image/png')
}

/** A section of the side panel. */
export const section = (title: string, body: string, id = '') => `<section class="psec"${id ? ` id="${id}"` : ''}><h3 class="psec__title">${title}</h3>${body}</section>`
/** The help at the bottom of the side panel. */
export const help = (text: string, id = '') => `<details class="group" open><summary><span class="group__title">${L('Справка', 'Help')}</span></summary><div class="group__body"><p class="help"${id ? ` id="${id}"` : ''}>${text}</p></div></details>`
/** Two large numbers side by side. */
export const numbers = (items: [label: string, value: string, unit: string][]) =>
  `<div class="metrics">${items.map(([label, value, unit]) => `<div class="metric"><span class="label">${label}</span><span class="metric__value"><span class="metric__num">${value}</span><span class="unit">${unit}</span></span></div>`).join('')}</div>`
/** A list of readings. */
export const readings = (items: [string, string][]) => items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
/** Marks the pressed button of a group. */
export const press = (buttons: Iterable<HTMLElement>, pressed: (b: HTMLElement) => boolean) => { for (const b of buttons) b.setAttribute('aria-pressed', String(pressed(b))) }

export interface InstrumentPalette { bg: string; bar: string; grid: string; gridStrong: string; label: string; text: string; meso: Record<MesoStrength, string> }
let palette: InstrumentPalette | null = null
/** The canvases' colours (styles/tokens.css --instrument-*, --meso-*): the same in both themes, read once. */
export function instrumentPalette(root: HTMLElement): InstrumentPalette {
  if (palette) return palette
  const css = getComputedStyle(root), v = (name: string) => css.getPropertyValue(name).trim()
  palette = {
    bg: v('--instrument-bg'), bar: v('--instrument-bar'), grid: v('--instrument-grid'), gridStrong: v('--instrument-grid-strong'), label: v('--instrument-label'), text: v('--text'),
    meso: { circulation: v('--meso-circulation'), weak: v('--meso-weak'), moderate: v('--meso-moderate'), strong: v('--meso-strong') },
  }
  return palette
}
