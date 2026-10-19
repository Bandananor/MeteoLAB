// The site pages around the simulator (the home page and «О модели»): fonts, the design system's styles, the theme
// switch in the header and, on a narrow screen, the header menu.
import '@fontsource/onest/400.css'
import '@fontsource/onest/500.css'
import '@fontsource/onest/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '../styles/tokens.css'
import '../styles/base.css'
import '../styles/components.css'
import '../styles/layout.css'
import './site.css'
import { applyTheme, themeChoice, type ThemeChoice, toggleTheme } from '../theme'
import { lang, otherLanguagePath, rememberLang } from '../i18n'

const showChoice = () => document.querySelectorAll<HTMLButtonElement>('[data-theme-set]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeSet === themeChoice())))
document.addEventListener('click', e => {
  const target = e.target as HTMLElement, set = target.closest<HTMLButtonElement>('[data-theme-set]')
  if (set) applyTheme(set.dataset.themeSet as ThemeChoice)
  if (target.closest('[data-theme-toggle]')) toggleTheme()
  // The same page in the other language, remembered so the home page no longer guesses.
  if (target.closest('[data-lang-switch]')) {
    e.preventDefault(); rememberLang(lang() === 'en' ? 'ru' : 'en')
    location.href = otherLanguagePath(location.pathname, import.meta.env.BASE_URL) + location.hash
  }
  // The header menu (narrow screens): the toggle opens it, anything else closes it.
  const menu = document.querySelector<HTMLElement>('#siteMenu'), toggle = target.closest('[data-menu-toggle]')
  if (menu) { menu.hidden = toggle ? !menu.hidden : true; document.querySelector('[data-menu-toggle]')?.setAttribute('aria-expanded', String(!menu.hidden)) }
})
addEventListener('keydown', e => { if (e.key === 'Escape') { const menu = document.querySelector<HTMLElement>('#siteMenu'); if (menu) menu.hidden = true } })
addEventListener('themechange', showChoice); showChoice()
