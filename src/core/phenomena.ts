import { L } from '../i18n'

/**
 * The phenomena map of the Russian weather radars (the DMRL-C's "карта метеоявлений"): the codes and their order are
 * the GIMET-2010 legend (Roshydromet DMRL-C guidelines 2014, table 4.7.1); the inputs are its column quantities (PPI
 * vgo, z1, z2, zh3, zmax). GIMET-2010's own thresholds are not published, so the criteria are those of the guide for the
 * MRL-5 radars, RD 52.04.320-91, section 2.10 (its reflectivities are in lg Za, the old units by radius: dBZ = 10 lg Za +
 * 18), and where it has no grades (showers, hail and squalls 1-3) the grades are this project's choice, marked as such.
 * Notes: .claude/literature/dmrl-phenomena-criteria.md (02.11.2026).
 */
export const PHENOMENA: readonly { code: number; name: string; color: string }[] = [
  { code: 0, name: L('нет радиоэха', 'no echo'), color: 'transparent' },
  { code: 1, name: L('облачность верхнего и среднего яруса', 'upper and middle cloud'), color: '#6f7f99' },
  { code: 2, name: L('слоистообразная облачность', 'stratiform cloud'), color: '#9aa7b8' },
  { code: 3, name: L('осадки слабые', 'light precipitation'), color: '#9fe6a0' },
  { code: 4, name: L('осадки умеренные', 'moderate precipitation'), color: '#4cc25a' },
  { code: 5, name: L('осадки сильные', 'heavy precipitation'), color: '#1f7f32' },
  { code: 6, name: L('кучевая облачность', 'cumulus'), color: '#d8d8d8' },
  { code: 7, name: L('ливень слабый', 'light shower'), color: '#8fd3ff' },
  { code: 8, name: L('ливень умеренный', 'moderate shower'), color: '#3f9cf0' },
  { code: 9, name: L('ливень сильный', 'heavy shower'), color: '#1f4fd0' },
  { code: 10, name: L('гроза, вероятность 30–70 %', 'thunderstorm, 30–70 %'), color: '#ffe66b' },
  { code: 11, name: L('гроза, вероятность 71–90 %', 'thunderstorm, 71–90 %'), color: '#ffb52e' },
  { code: 12, name: L('гроза, вероятность > 90 %', 'thunderstorm, > 90 %'), color: '#ff7a1a' },
  { code: 13, name: L('град слабый', 'light hail'), color: '#ff5c8a' },
  { code: 14, name: L('град умеренный', 'moderate hail'), color: '#e0207a' },
  { code: 15, name: L('град сильный', 'heavy hail'), color: '#a0005a' },
  { code: 16, name: L('шквал слабый', 'light squall'), color: '#c49bff' },
  { code: 17, name: L('шквал умеренный', 'moderate squall'), color: '#9b5cff' },
  { code: 18, name: L('шквал сильный', 'heavy squall'), color: '#6a1fd8' },
  { code: 19, name: L('смерч', 'tornado'), color: '#ff1a1a' },
  { code: 31, name: L('нет данных', 'no data'), color: '#2a2f3a' },
]

/** dBZ of a reflectivity in the RD's lg Za (the old units by radius). */
export const lgZaToDbz = (lgZa: number) => 10 * lgZa + 18
const lgZa = (dbz: number) => (dbz - 18) / 10

/**
 * The RD's thresholds. Precipitation (table 2.13): lg Z 0 / 1.2 / 2.8 (18, 30, 46 dBZ) - light, moderate, heavy.
 * Thunder (pp. 76-79): Y = H lg Z3 with the top H at least at the -22 °C level, Y_cr = H(-22 °C) lg Z3min, lg Z3min
 * 1.0-1.5 (here 1.2); <= 70 % above Y_cr, 70-90 % above Y_cr + 6, > 90 % above Y_cr + 14. Hail (p. 74): >= 58 dBZ anywhere
 * in the cloud, or >= 55 dBZ with the top at 10 km or higher, with a core of >= 46 dBZ above H0 + 1.4 km. Squall (tables
 * 2.6-2.7): for tops of >= 10 km and a cell motion of >= 10 km/h the squall speed from the motion (table 2.7, H 10 km, lg Z3
 * 1.2-2.7: 10 / 30 / 50 / 70 / 90 / 105 km/h -> 15 / 18 / 21 / 24 / 28 / 30 m/s). Tornado (p. 71): the top >= 3 km above
 * the tropopause with 53-58 dBZ.
 */
export const RD_CRITERIA = {
  rain: [18, 30, 46], lgZ3min: 1.2, thunderSteps: [0, 6, 14], hailAnywhere: 58, hailHigh: 55, hailHighTop: 10, hailCore: 46, hailCoreAbove: 1400,
  squallTop: 10, squallZ3: 30, squallMotion: [10, 30, 50, 70, 90, 105], squallSpeed: [15, 18, 21, 24, 28, 30], tornadoAbove: 3, tornadoDbz: 53,
} as const
/**
 * This project's grades where the RD has none: showers - precipitation with a convective column (Z2 >= 18 dBZ and the
 * top above the 0 °C level), graded by Z1 like the precipitation; hail - moderate from Zmax >= 63 dBZ (lg Z 4.5, Brylev
 * et al. 1986), heavy with MESH >= 20 mm too; squalls - 15-20 / 20-25 / > 25 m/s (the Roshydromet DMRL-C instruction
 * of 2016), and only over a convective core (>= 46 dBZ above H0 + 1.4 km, as the hail core: the RD puts the squall zone
 * within 15 km of the precipitation's front; without it a supercell's whole thunder area was a squall).
 */
export const OWN = { showerZ2: 18, hailModerate: 63, hailHeavyMesh: 20, squall: [15, 20, 25], squallCore: 46 } as const

/** Squall speed (m/s) of RD table 2.7 for a cell motion of `kmh` km/h (linear between its columns; 0 below 10 km/h). */
export function squallSpeed(kmh: number) {
  const m = RD_CRITERIA.squallMotion, s = RD_CRITERIA.squallSpeed
  if (kmh < m[0]) return 0
  for (let k = 1; k < m.length; k++) if (kmh <= m[k]) return s[k - 1] + (s[k] - s[k - 1]) * (kmh - m[k - 1]) / (m[k] - m[k - 1])
  return s[s.length - 1]
}

export interface ColumnEcho {
  /** Cloud top (km, 0: none), the strongest echo (dBZ), the layers Z1 and Z2, the levels H3 and H0 + 1.4 km, Zmax above 1 km. */
  top: number; strongest: number; z1: number; z2: number; zh3: number; zCore: number; zmax: number
  /** MESH, mm. */ mesh: number
}
export interface PhenomenaLevels {
  /** Heights of the 0 °C and -22 °C levels and of the tropopause, km; the cell motion, km/h. */
  h0: number; h22: number; tropopause: number; motion: number
}

/**
 * The phenomena code of one column: the highest of the criteria met, as GIMET-2010 marks the map. Hail, squalls and
 * tornadoes only where thunder is > 90 % likely: the DMRL-C guidelines (2014, section 5.1) say every phenomenon from
 * light hail to a heavy squall includes it (without that, table 2.7 marked a supercell's whole anvil a squall).
 */
export function phenomenon(c: ColumnEcho, lv: PhenomenaLevels) {
  if (c.top <= 0) return 0
  let code = 0
  if (c.z1 >= RD_CRITERIA.rain[0]) {
    const grade = c.z1 >= RD_CRITERIA.rain[2] ? 2 : c.z1 >= RD_CRITERIA.rain[1] ? 1 : 0
    code = (c.z2 >= OWN.showerZ2 && c.top > lv.h0 ? 7 : 3) + grade
  } else code = c.z2 >= OWN.showerZ2 && c.top > lv.h0 ? 6 : c.z1 > -20 ? 2 : 1
  // Thunder: the top at least at -22 °C, Y over Y_cr (lg Z3 of no echo is below zero: no thunder).
  let sure = false
  if (c.top >= lv.h22) {
    const y = c.top * lgZa(c.zh3), ycr = lv.h22 * RD_CRITERIA.lgZ3min, steps = RD_CRITERIA.thunderSteps
    for (let k = steps.length - 1; k >= 0; k--) if (y > ycr + steps[k]) { code = Math.max(code, 10 + k); sure = k === steps.length - 1; break }
  }
  if (!sure) return code
  const hail = (c.zmax >= RD_CRITERIA.hailAnywhere || (c.zmax >= RD_CRITERIA.hailHigh && c.top >= RD_CRITERIA.hailHighTop)) && c.zCore >= RD_CRITERIA.hailCore
  if (hail) code = Math.max(code, c.zmax >= OWN.hailModerate ? (c.mesh >= OWN.hailHeavyMesh ? 15 : 14) : 13)
  if (c.top >= RD_CRITERIA.squallTop && c.zh3 >= RD_CRITERIA.squallZ3 && c.zCore >= OWN.squallCore) {
    const v = squallSpeed(lv.motion)
    if (v >= OWN.squall[0]) code = Math.max(code, v > OWN.squall[2] ? 18 : v > OWN.squall[1] ? 17 : 16)
  }
  if (c.top >= lv.tropopause + RD_CRITERIA.tornadoAbove && c.strongest >= RD_CRITERIA.tornadoDbz) code = 19
  return code
}
