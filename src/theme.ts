// Light and dark themes (tokens.css): the system setting until the theme switch is used, then the choice, remembered
// in localStorage. index.html applies the remembered theme before the first paint; this module switches it and gives
// the canvas charts their token colours.

export type Theme = 'light' | 'dark'
const THEME_KEY = 'meteolab-theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

/** The theme shown now. */
export function currentTheme(): Theme {
  const set = document.documentElement.dataset.theme
  if (set === 'light' || set === 'dark') return set
  return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

/** Shows a theme and remembers it; the charts are redrawn with the new colours. */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  try { localStorage.setItem(THEME_KEY, theme) } catch { /* private mode: for this visit only */ }
  palette = null
  dispatchEvent(new Event('themechange'))
}

export const toggleTheme = () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark')

// A system change shows only while nothing is chosen; the charts follow either way.
if (typeof matchMedia === 'function') matchMedia(DARK_QUERY).addEventListener('change', () => { palette = null; dispatchEvent(new Event('themechange')) })

/** Monospace font for the canvases (the same as --font-mono). */
export const MONO = "'JetBrains Mono', ui-monospace, monospace"

export interface ChartPalette { grid: string; axis: string; label: string; text: string; text2: string; accent: string; warn: string; danger: string }
let palette: ChartPalette | null = null

/** The chart colours of the current theme (tokens.css --chart-*), read once per theme. */
export function chartPalette(): ChartPalette {
  if (palette) return palette
  const css = getComputedStyle(document.documentElement), v = (name: string) => css.getPropertyValue(name).trim()
  palette = { grid: v('--chart-grid'), axis: v('--chart-axis'), label: v('--chart-label'), text: v('--text'), text2: v('--text-2'), accent: v('--accent'), warn: v('--warn'), danger: v('--danger') }
  return palette
}
