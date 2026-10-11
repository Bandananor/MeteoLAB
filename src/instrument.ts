// The instrument screens (radar, Skew-T, weather station) share one shell from the design system (styles/layout.css
// .instrument): a bar with the instrument's name and readings, the screen, and a side panel of sections. They are
// always dark (data-theme="dark" on their root, whatever the page's theme) and lie over the simulator.
import type { MesoStrength } from './core'

/** Builds a hidden instrument screen in `host`; `screen` goes over its canvas, `side` is the side panel's markup. */
export function instrumentScreen(host: HTMLElement, kind: string, name: string, fields: string, side: string, screen = '') {
  const root = document.createElement('div')
  root.className = `instrument instrument-overlay ${kind}`; root.dataset.theme = 'dark'; root.hidden = true
  root.innerHTML = `
    <header class="ibar"><span class="ibar__name">${name}</span><span class="ibar__sep"></span><span class="ibar__fields">${fields}</span><button class="btn ibar__close" title="Вернуться к 3D (Esc)">Закрыть <span class="kbd">Esc</span></button></header>
    <div class="instrument__body"><div class="instrument__screen"><canvas></canvas>${screen}</div><aside class="instrument__side">${side}</aside></div>`
  host.appendChild(root)
  return root
}

/** A section of the side panel. */
export const section = (title: string, body: string, id = '') => `<section class="psec"${id ? ` id="${id}"` : ''}><h3 class="psec__title">${title}</h3>${body}</section>`
/** The help at the bottom of the side panel. */
export const help = (text: string, id = '') => `<details class="group" open><summary><span class="group__title">Справка</span></summary><div class="group__body"><p class="help"${id ? ` id="${id}"` : ''}>${text}</p></div></details>`
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
