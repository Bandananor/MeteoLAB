import type { SimConfig } from './config'

/**
 * A ready-made experiment: values laid over the base configuration. `mesocyclone` says whether the environment is meant
 * to give a persistent mesocyclone (true), must not give one (false), or may go either way (undefined); the slow
 * scenario test checks it.
 */
export interface Scenario { name: string; hint: string; values: Partial<SimConfig>; mesocyclone?: boolean }

/**
 * Starting-thermal radius (km) of the ordinary storms (2026-10-08). The default broad thermal (4.2 km, ~8 km across)
 * gave updraughts of 0.9-1.0 sqrt(2 CAPE): a wide updraught hardly entrains. With 2.5 km they are ~10 m/s weaker and
 * the tilted vortex pairs (UH ~ w zeta, zeta ~ dw/dy) 20-40 % weaker, so weak-shear storms no longer pass for
 * supercells. HSLC and Weisman-Klemp keep the broad thermal: the low-CAPE HSLC mini-supercell dies without it.
 */
const NARROW = 2.5
// Weak veering wind of a quiet summer day and the hodographs of the sheared scenarios (speed m/s, direction °).
const LIGHT_WIND: Partial<SimConfig> = { wind0: 2, wind3: 5, wind6: 9, wind10: 14, windDir0: 200, windDir3: 230, windDir6: 250, windDir10: 260 }
// Summer boundary layer: well mixed and moist in the lowest kilometre under a weak lid.
const SUMMER_AIR: Partial<SimConfig> = {
  surfaceTemp: 28, rhSurface: 55, rhLow: 50, rhMid: 45, rhUpper: 30, lapseLow: 9.3, lapseMid: 6.3, lapseUpper: 6.5,
  capStrength: 1, capHeight: 1.4, moistLayer: 1,
}

/**
 * Realistic environments (2026-09-29): moderate CAPE (the ~1 km model gets close to parcel theory, w ~0.7-0.8 sqrt(2 CAPE)), a well-mixed moist boundary layer (with humidity falling linearly the updraught
 * ingests dry air and dies by 30-40 min) and a lid where nature has one. All use the default WENO transport: with the
 * semi-Lagrangian one the thermal is smeared out in strong wind before it can rise.
 */
export const SCENARIOS: Scenario[] = [
  { name: 'Летний день', mesocyclone: false,
    hint: 'Обычный жаркий летний день: влажный перемешанный слой у земли под слабой инверсией, ветер слабый. Одиночная гроза с ливнем и холодным оттоком',
    values: { bubbleRadius: NARROW, ...SUMMER_AIR, ...LIGHT_WIND } },
  { name: 'Сухой воздух', mesocyclone: false,
    hint: 'Умеренная CAPE и очень сухой средний слой (15 %). Сухой воздух, вовлекаясь в облако, испаряет капли: дождя на треть меньше, чем при влажной середине. Сам поток почти не слабеет — широкий термик (~8 км) на сетке ~1 км вовлекает мало; тонкие струи, которые в природе душит сухой воздух, сетка не разрешает',
    values: { bubbleRadius: NARROW, ...SUMMER_AIR, ...LIGHT_WIND, surfaceTemp: 25.5, rhLow: 35, rhMid: 15, rhUpper: 10 } },
  { name: 'Сдвиг ветра',
    hint: 'Западный ветер усиливается с высотой (сдвиг 0–6 км ~13 м/с): облако наклоняется, дождь выпадает в стороне от потока, по оттоку растут новые ячейки — многоячейковая гроза',
    values: { bubbleRadius: NARROW, ...SUMMER_AIR, rhSurface: 57, rhLow: 55, rhMid: 50, wind0: 3, wind3: 10, wind6: 16, wind10: 22, windDir0: 250, windDir3: 265, windDir6: 270, windDir10: 270 } },
  { name: 'Микропорыв', mesocyclone: false,
    hint: 'Жара и сухой воздух до 3 км («перевёрнутое V»), влажная середина: облако с базой ~2,8 км, дождь испаряется по пути вниз, охлаждённый воздух ударяет в землю порывом до ~20 м/с',
    values: { bubbleRadius: NARROW, surfaceTemp: 34, rhSurface: 25, rhLow: 25, rhMid: 70, rhUpper: 35, lapseLow: 9.7, lapseMid: 7.2, lapseUpper: 6.5, tropopause: 12, ...LIGHT_WIND } },
  { name: 'Заряженное ружьё',
    hint: 'Тёплая сухая «крышка» (инверсия 3 K на 1 км, над ней крутой градиент) над влажным слоем: CIN ~140 Дж/кг. Термика нет — первые 20 минут ничего не происходит, потом нагрев у земли пробивает крышку сразу во многих местах',
    values: { surfaceTemp: 30, rhSurface: 50, rhLow: 25, rhMid: 35, rhUpper: 30, lapseLow: 9.6, lapseMid: 6.8, lapseUpper: 6.5, capStrength: 3, capHeight: 1, bubble: 0,
      wind0: 6, wind3: 15, wind6: 22, wind10: 28, windDir0: 170, windDir3: 220, windDir6: 245, windDir10: 255 } },
  { name: 'HSLC', mesocyclone: true,
    hint: 'Сильный сдвиг при малой CAPE (~1,3 кДж/кг — верхний край HSLC: на сетке ~1 км при меньшей CAPE вращение не держится), прохладно и влажно, как осенью или зимой: низкие мини-суперячейки с сильным вращением у земли (SRH 0–1 км ~300 м²/с²). Малая CAPE — нужен сильный начальный термик (2,5). На сетке ~1 км на грани разрешения',
    values: { surfaceTemp: 20.5, rhSurface: 85, rhLow: 80, rhMid: 55, rhUpper: 40, lapseLow: 6.5, lapseMid: 6.8, lapseUpper: 6.5, tropopause: 10, moistLayer: .8, bubble: 2.5,
      wind0: 10, wind05: 20, wind1: 25, wind3: 30, wind6: 35, wind10: 45, windDir0: 150, windDir05: 170, windDir1: 185, windDir3: 210, windDir6: 230, windDir10: 240 } },
  { name: 'Жаркий город', mesocyclone: false,
    hint: 'Городская застройка и сухая почва сильно греют воздух у земли; воздух суше, чем за городом',
    values: { bubbleRadius: NARROW, ...SUMMER_AIR, ...LIGHT_WIND, surfaceTemp: 29, rhSurface: 45, rhLow: 45, lapseLow: 9.5, surfaceType: 'urban', soilMoisture: 15, solarMax: 1100 } },
  { name: 'Суперячейка WK', mesocyclone: true,
    hint: 'Классический опыт Weisman–Klemp: реалистичная CAPE ~2,3 кДж/кг, годограф «четверть окружности», один термик, точный перенос. Ячейка живёт больше часа и расщепляется на правую (циклоническую) и левую. Профиль задан формулами — ползунки температуры, влажности и ветра не действуют',
    values: { profile: 'weisman-klemp', solarMax: 0, bubble: 1.5 } },
]
