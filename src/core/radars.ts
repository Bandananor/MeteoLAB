import { L } from '../i18n'

/**
 * Radar profiles (roadmap E11, first step: the scan without new physics). Each radar samples the same model fields
 * (reflectivity Rayleigh unless PPI.mie, attenuation with PPI.attenuate) with its own scan: the elevation angles of its volume
 * scan (every volume product - composite, echo top, VIL, MESH - and the mesocyclone detection use them), the range gate and
 * the beam width of its radial bins, its Nyquist velocity (the folding option), and the ranges beyond which it gives no
 * reflectivity or no velocity. Sources: .claude/literature/radar-profiles.md (02.11.2026); `verified` says what was not
 * read in a primary document.
 */
/** The radar screen's products (src/radar/panel.ts). */
export type RadarProduct = 'Z' | 'V' | 'SRV' | 'CR' | 'ZDR' | 'RHO' | 'KDP' | 'VIL' | 'ET' | 'MESH' | 'VGO' | 'MAP'

export interface RadarProfile {
  name: string
  band: 'S' | 'C' | 'X'
  /** Wavelength, cm. */ wavelength: number
  /** 3 dB beam width, degrees. */ beam: number
  /** Azimuthal spacing of the radials, degrees (the WSR-88D's super-resolution: 0.5° with a 0.95° beam). */ step: number
  /** Range gate of the reflectivity, m. */ gate: number
  /** Elevation angles of the volume scan, degrees, ascending. */ tilts: readonly number[]
  /**
   * Where the radar scans the velocity at other angles or gates than the reflectivity (the DMRL-C's two volume files:
   * reflectivity on 24 tilts at 500 m, velocity on 22 at 250 m): those tilts (ascending) and that gate, m; absent = the same.
   */
  velocityTilts?: readonly number[]; velocityGate?: number
  /** Nyquist velocity of the low tilts, m/s (with dual or staggered PRF where the radar uses it). */ nyquist: number
  /** Range of the reflectivity and of the Doppler velocity, m. */ range: number; velocityRange: number
  /** Time of one volume scan, s. */ volume: number
  /**
   * The products its real system gives (the screen offers only these): the same quantity is not shown twice under two
   * systems' names - the cloud top as ET on the WSR-88D, as VGO (ВГО) on the DMRL-C.
   */
  products: readonly RadarProduct[]
  /** Reflectivity of its echo top product, dBZ (absent: ECHO_TOP_DBZ, 18, the NWS enhanced echo tops). */
  echoTopDbz?: number
  /** One line for the screen: what the radar is. */ note: string
  /** What the numbers rest on, and what is not verified. */ verified: string
}

export type RadarId = 'wsr88d' | 'dmrl' | 'dwd' | 'x'

export const RADARS: Record<RadarId, RadarProfile> = {
  wsr88d: {
    name: 'WSR-88D', band: 'S', wavelength: 10, beam: .95, step: .5, gate: 250,
    tilts: [.5, .9, 1.3, 1.8, 2.4, 3.1, 4, 5.1, 6.4, 8, 10, 12.5, 15.6, 19.5], nyquist: 28, range: 460_000, velocityRange: 300_000, volume: 270,
    // NEXRAD Level III (NCEI product descriptions): base and storm-relative velocity, the dual-pol moments ZDR, CC, KDP,
    // composite reflectivity, VIL, enhanced echo tops; the hail detection algorithm gives its largest hail size per cell
    // (MEHS, Hail Index), the MESH field here is gridded as MRMS does.
    products: ['Z', 'V', 'SRV', 'ZDR', 'RHO', 'KDP', 'CR', 'VIL', 'ET', 'MESH'],
    note: L('NEXRAD, США: S-диапазон, VCP 12/212 (14 наклонов за ~4,5 мин), строб 250 м', 'NEXRAD, USA: S band, VCP 12/212 (14 tilts in ~4.5 min), 250 m gates'),
    verified: L('наклоны VCP 12/212 и время — документация NWS (WDTD); луч 0,95°, дальности и Найквист 25–34 м/с — по вторичным источникам', 'VCP 12/212 tilts and time — NWS documentation (WDTD); 0.95° beam, ranges and Nyquist 25–34 m/s — secondary sources'),
  },
  dmrl: {
    name: L('ДМРЛ-С', 'DMRL-C'), band: 'C', wavelength: 5.33, beam: 1, step: 1, gate: 500,
    tilts: [.1, .3, .7, 1.1, 1.5, 1.9, 2.3, 2.8, 3.4, 4, 5, 6, 7.5, 9, 11.2, 14, 17.5, 22, 28, 35.5, 45.5, 58, 72, 86],
    velocityTilts: [.1, .3, .7, 1.1, 1.6, 2.2, 2.9, 3.8, 4.8, 6, 7.5, 9, 11.2, 14, 17.5, 22, 28, 35.5, 45.5, 58, 72, 86], velocityGate: 250,
    nyquist: 66, range: 250_000, velocityRange: 125_000, volume: 600,
    // GIMET-2010 (the 2014 guidelines, section 4.7): Z, V, Zdr, rhoHV, Zmax above 1 km (as CR), VIL, the cloud top ВГО and
    // the phenomena map; it measures the differential phase but lists no KDP; no storm-relative velocity, echo top or MESH.
    products: ['Z', 'V', 'ZDR', 'RHO', 'CR', 'VIL', 'VGO', 'MAP'],
    note: L('Росгидромет: C-диапазон, двухполяризационный, цикл 10 мин; отражаемость — 24 наклона до 250 км (строб 500 м), скорость — 22 наклона до 125 км (строб 250 м)', 'Roshydromet, Russia: C band, dual-polarisation, a 10 min cycle; reflectivity on 24 tilts to 250 km (500 m gates), velocity on 22 tilts to 125 km (250 m gates)'),
    verified: L('наклоны, стробы, дальности, цикл и скорость до ±66 м/с (две частоты импульсов, периоды 1,0 и 1,2 мс) — «Временные методические указания по использованию информации ДМРЛ-С» (Росгидромет, 2014), раздел 4.5; частота и поляризация — брошюра ЛЭМЗ; ширина луча 1° — по вторичным источникам', 'tilts, gates, ranges, cycle and velocities to ±66 m/s (two pulse periods, 1.0 and 1.2 ms) — the Roshydromet guidelines on the DMRL-C (2014), section 4.5; frequency and polarisation — the LEMZ brochure; the 1° beam — secondary sources'),
  },
  dwd: {
    name: L('Европейский C (DWD)', 'European C (DWD)'), band: 'C', wavelength: 5.3, beam: 1, step: 1, gate: 250,
    tilts: [.5, 1.5, 2.5, 3.5, 4.5, 5.5, 8, 12, 17, 25], nyquist: 32, range: 180_000, velocityRange: 180_000, volume: 300,
    // DWD radar products (dwd.de "Radarprodukte", read 03.11.2026): sweeps of Z, V, ZDR, rhoHV and PhiDP (no KDP), the
    // maximum composite DMAX (as CR), the single-site echo top PE at 5 dBZ; VII (integrated ice), not VIL; no SRV, no MESH.
    products: ['Z', 'V', 'ZDR', 'RHO', 'CR', 'ET'], echoTopDbz: 5,
    note: L('Сеть Германии: C-диапазон, 10 наклонов за 5 мин, двойная частота импульсов 600/800 Гц', 'The German network: C band, 10 tilts in 5 min, dual PRF 600/800 Hz'),
    verified: L('всё — Helmert и др., ERAD 2014', 'all — Helmert et al., ERAD 2014'),
  },
  x: {
    name: L('Мобильный X (RaXPol)', 'Mobile X (RaXPol)'), band: 'X', wavelength: 3.08, beam: 1, step: 1, gate: 75,
    tilts: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15], nyquist: 38.5, range: 30_000, velocityRange: 30_000, volume: 20,
    // A research radar gives the moments only (FARM, RaXPol): Z, V, ZDR, rhoHV; KDP from the phase in post-processing.
    products: ['Z', 'V', 'ZDR', 'RHO', 'KDP'],
    note: L('Исследовательский радар на грузовике: X-диапазон, объём за ~20 с, дальность 30 км', 'A truck-mounted research radar: X band, a volume in ~20 s, 30 km range'),
    verified: L('длина волны, луч, дальность, время — Pazmany и Bluestein 2011; наклоны — типичный набор (в источнике только их число, 10)', 'wavelength, beam, range, time — Pazmany & Bluestein 2011; the tilts — a typical set (the source gives only their number, 10)'),
  },
}
