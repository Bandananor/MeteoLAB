// Light and dark themes (styles/tokens.css): the system setting («Авто») until a theme is chosen, then the choice,
// remembered in localStorage. index.html applies the remembered theme before the first paint; this module switches it
// and gives the canvas charts their token colours.

export type Theme = 'light' | 'dark'
/** What the theme switch offers: a fixed theme, or the system's. */
export type ThemeChoice = Theme | 'auto'
const THEME_KEY = 'meteolab-theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

/** The theme shown now. */
export function currentTheme(): Theme {
  const set = document.documentElement.dataset.theme
  if (set === 'light' || set === 'dark') return set
  return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

/** The switch's position now. */
export function themeChoice(): ThemeChoice {
  const set = document.documentElement.dataset.theme
  return set === 'light' || set === 'dark' ? set : 'auto'
}

/** Shows a theme (or the system's) and remembers the choice; the charts are redrawn with the new colours. */
export function applyTheme(choice: ThemeChoice) {
  if (choice === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = choice
  try { if (choice === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, choice) } catch { /* private mode: for this visit only */ }
  palette = null
  dispatchEvent(new Event('themechange'))
}

/** The phone menu's single item: light and dark in turn. */
export const toggleTheme = () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark')

// A system change shows only while nothing is chosen; the charts follow either way.
if (typeof matchMedia === 'function') matchMedia(DARK_QUERY).addEventListener('change', () => { palette = null; dispatchEvent(new Event('themechange')) })

/** Monospace font for the canvases (the same as --font-mono). */
export const MONO = "'JetBrains Mono', ui-monospace, monospace"
/** The weather stations' letters and colours, in the order placed: the masts in the 3D view and their lines on the meteogram. */
export const STATION_LETTERS = ['A', 'B', 'C', 'D'], STATION_COLORS = ['#ffb347', '#6fb4ff', '#e879c6', '#a3e05a']

export interface ChartPalette { grid: string; axis: string; label: string; text: string; text2: string; accent: string; warn: string; danger: string }
let palette: ChartPalette | null = null

/** The chart colours of the current theme (styles/tokens.css --chart-*), read once per theme. */
export function chartPalette(): ChartPalette {
  if (palette) return palette
  const css = getComputedStyle(document.documentElement), v = (name: string) => css.getPropertyValue(name).trim()
  palette = { grid: v('--chart-grid'), axis: v('--chart-axis'), label: v('--chart-label'), text: v('--text'), text2: v('--text-2'), accent: v('--accent'), warn: v('--warn'), danger: v('--danger') }
  return palette
}
