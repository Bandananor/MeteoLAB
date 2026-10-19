import { afterEach, describe, expect, it } from 'vitest'
import { decimal, L, lang, otherLanguagePath, preferredLang, setLang } from './i18n'

describe('interface language', () => {
  afterEach(() => setLang('ru'))

  it('is Russian without a page (tests, scripts) and picks the pair by the language', () => {
    expect(lang()).toBe('ru')
    expect(L('гроза', 'storm')).toBe('гроза'); expect(decimal(1.25, 1)).toBe('1,3')
    setLang('en')
    expect(L('гроза', 'storm')).toBe('storm'); expect(decimal(1.25, 1)).toBe('1.3')
  })

  it('maps a page to the same page in the other language, under the site’s base', () => {
    expect(otherLanguagePath('/MeteoLAB/guide/meteo/', '/MeteoLAB/')).toBe('/MeteoLAB/en/guide/meteo/')
    expect(otherLanguagePath('/MeteoLAB/en/guide/meteo/', '/MeteoLAB/')).toBe('/MeteoLAB/guide/meteo/')
    expect(otherLanguagePath('/MeteoLAB/', '/MeteoLAB/')).toBe('/MeteoLAB/en/')
    expect(otherLanguagePath('/en/simulator/', '/')).toBe('/simulator/')
  })

  it('guesses Russian for Russian and neighbouring browsers, English for the rest', () => {
    expect(preferredLang(['ru-RU', 'en'])).toBe('ru'); expect(preferredLang(['uk'])).toBe('ru'); expect(preferredLang(['kk-KZ'])).toBe('ru')
    expect(preferredLang(['en-US'])).toBe('en'); expect(preferredLang(['de-DE', 'fr'])).toBe('en')
  })
})
