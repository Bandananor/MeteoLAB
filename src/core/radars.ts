import { L } from '../i18n'

/**
 * Radar profiles (roadmap E11, first step: the scan without new physics). Each radar samples the same model fields
 * (reflectivity still Rayleigh at every band, no attenuation yet) with its own scan: the elevation angles of its volume
 * scan (every volume product - composite, echo top, VIL, MESH - and the mesocyclone detection use them), the range gate and
 * the beam width of its radial bins, its Nyquist velocity (the folding option), and the ranges beyond which it gives no
 * reflectivity or no velocity. Sources: .claude/literature/radar-profiles.md (02.11.2026); `verified` says what was not
 * read in a primary document.
 */
export interface RadarProfile {
  name: string
  band: 'S' | 'C' | 'X'
  /** Wavelength, cm. */ wavelength: number
  /** 3 dB beam width, degrees. */ beam: number
  /** Azimuthal spacing of the radials, degrees (the WSR-88D's super-resolution: 0.5° with a 0.95° beam). */ step: number
  /** Range gate of the reflectivity, m. */ gate: number
  /** Elevation angles of the volume scan, degrees, ascending. */ tilts: readonly number[]
  /** Nyquist velocity of the low tilts, m/s (with dual or staggered PRF where the radar uses it). */ nyquist: number
  /** Range of the reflectivity and of the Doppler velocity, m. */ range: number; velocityRange: number
  /** Time of one volume scan, s. */ volume: number
  /** One line for the screen: what the radar is. */ note: string
  /** What the numbers rest on, and what is not verified. */ verified: string
}

export type RadarId = 'wsr88d' | 'dmrl' | 'dwd' | 'x'

export const RADARS: Record<RadarId, RadarProfile> = {
  wsr88d: {
    name: 'WSR-88D', band: 'S', wavelength: 10, beam: .95, step: .5, gate: 250,
    tilts: [.5, .9, 1.3, 1.8, 2.4, 3.1, 4, 5.1, 6.4, 8, 10, 12.5, 15.6, 19.5], nyquist: 28, range: 460_000, velocityRange: 300_000, volume: 270,
    note: L('NEXRAD, США: S-диапазон, VCP 12/212 (14 наклонов за ~4,5 мин), строб 250 м', 'NEXRAD, USA: S band, VCP 12/212 (14 tilts in ~4.5 min), 250 m gates'),
    verified: L('наклоны VCP 12/212 и время — документация NWS (WDTD); луч 0,95°, дальности и Найквист 25–34 м/с — по вторичным источникам', 'VCP 12/212 tilts and time — NWS documentation (WDTD); 0.95° beam, ranges and Nyquist 25–34 m/s — secondary sources'),
  },
  dmrl: {
    name: L('ДМРЛ-С', 'DMRL-C'), band: 'C', wavelength: 5.33, beam: 1, step: 1, gate: 500,
    tilts: [.1, .3, .7, 1.1, 1.6, 2.2, 2.9, 3.8, 4.8, 6, 7.5], nyquist: 42, range: 250_000, velocityRange: 125_000, volume: 600,
    note: L('Росгидромет: C-диапазон, двухполяризационный, цикл 10 мин, Z до 250 км, скорость до 125 км', 'Roshydromet, Russia: C band, dual-polarisation, a 10 min cycle, Z to 250 km, velocity to 125 km'),
    verified: L('частота и поляризация — брошюра ЛЭМЗ, цикл и дальности — ЦАО; луч 1°, строб 500 м, наклоны (здесь только доплеровские до 7,5°; для Z их 24) и Найквист ±42 м/с (вобуляция) — предварительно, по пересказам методических указаний ЦАО 2014', 'frequency and polarisation — the LEMZ brochure, cycle and ranges — CAO; 1° beam, 500 m gates, the tilts (here only the Doppler ones up to 7.5°; Z uses 24) and the ±42 m/s Nyquist (staggered PRF) — provisional, from retellings of the CAO 2014 guidelines'),
  },
  dwd: {
    name: L('Европейский C (DWD)', 'European C (DWD)'), band: 'C', wavelength: 5.3, beam: 1, step: 1, gate: 250,
    tilts: [.5, 1.5, 2.5, 3.5, 4.5, 5.5, 8, 12, 17, 25], nyquist: 32, range: 180_000, velocityRange: 180_000, volume: 300,
    note: L('Сеть Германии: C-диапазон, 10 наклонов за 5 мин, двойная частота импульсов 600/800 Гц', 'The German network: C band, 10 tilts in 5 min, dual PRF 600/800 Hz'),
    verified: L('всё — Helmert и др., ERAD 2014', 'all — Helmert et al., ERAD 2014'),
  },
  x: {
    name: L('Мобильный X (RaXPol)', 'Mobile X (RaXPol)'), band: 'X', wavelength: 3.08, beam: 1, step: 1, gate: 75,
    tilts: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15], nyquist: 38.5, range: 30_000, velocityRange: 30_000, volume: 20,
    note: L('Исследовательский радар на грузовике: X-диапазон, объём за ~20 с, дальность 30 км', 'A truck-mounted research radar: X band, a volume in ~20 s, 30 km range'),
    verified: L('длина волны, луч, дальность, время — Pazmany и Bluestein 2011; наклоны — типичный набор (в источнике только их число, 10)', 'wavelength, beam, range, time — Pazmany & Bluestein 2011; the tilts — a typical set (the source gives only their number, 10)'),
  },
}
