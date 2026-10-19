// The interface's language (2.7.1): Russian at the site's root, English under /en/ (the same bundle; the English
// pages are their own HTML files). A text is written as a pair L('русский', 'English') where it is used, so a change
// to one stays next to the other. The physics' worker learns the language from its first message (setLang); in
// tests and scripts, with no page, it is Russian.

export type Lang = 'ru' | 'en'

let current: Lang = typeof document !== 'undefined' && /\/en\//.test(location.pathname) ? 'en' : 'ru'

/** The language now. */
export const lang = () => current
/** Sets the language (the worker, from the page's; tests). */
export function setLang(l: Lang) { current = l }
/** The text in the language now. */
export const L = (ru: string, en: string) => current === 'en' ? en : ru

/** A number with the language's decimal separator (a comma in Russian, as the texts write it). */
export const decimal = (v: number, digits: number) => current === 'en' ? v.toFixed(digits) : v.toFixed(digits).replace('.', ',')

/** The same page in the other language: /MeteoLAB/guide/ ⇄ /MeteoLAB/en/guide/ (with the query and the hash). */
export function otherLanguagePath(path: string, base: string) {
  const rest = path.startsWith(base) ? path.slice(base.length) : path.replace(/^\//, '')
  return rest.startsWith('en/') ? base + rest.slice(3) : `${base}en/${rest}`
}

const CHOICE = 'meteolab-lang'
/** Remembers the visitor's choice of language (so the home page no longer guesses it). */
export function rememberLang(l: Lang) { try { localStorage.setItem(CHOICE, l) } catch { /* guessed again next time */ } }
/**
 * The language a first visit to the home page should get: the remembered choice, else Russian for browsers set to
 * Russian or a neighbouring language (Ukrainian, Belarusian, Kazakh), English for the rest.
 */
export function preferredLang(languages: readonly string[]): Lang {
  try { const saved = localStorage.getItem(CHOICE); if (saved === 'ru' || saved === 'en') return saved } catch { /* guess */ }
  return languages.some(l => /^(ru|uk|be|kk)\b/i.test(l)) ? 'ru' : 'en'
}
