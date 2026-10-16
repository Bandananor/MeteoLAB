import type { SimConfig } from './config'
import type { StoryStage } from './situations'

/**
 * A ready-made experiment: values laid over the base configuration. `mesocyclone` says whether the environment is meant
 * to give a persistent mesocyclone (true), must not give one (false), or may go either way (undefined); the slow
 * scenario test checks it.
 */
/** `summary`: one line for the phone's scenario cards; `hint`: the full note. */
export interface Scenario {
  name: string; summary: string; hint: string; values: Partial<SimConfig>; mesocyclone?: boolean
  /** A synoptic situation (2.6, situations.ts): shown apart from the scenarios, with its story by the hour. */
  story?: StoryStage[]
}

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
// The first «Заряженное ружьё» (a 3 K lid, CIN ~140 J/kg, no thermal, 13:30) was removed on 2026-10-11: it fired only
// because the profile above its lid was superadiabatic (fixed by Environment.neutralise); stable, it never fired in 40
// min. The scenario set was reviewed on 2026-10-12 (roadmap 2.1) so that every scenario shows its own phenomenon:
// «Сухой воздух» and «Жаркий город» (the same light-wind summer storm as «Летний день») were retired, «Сдвиг ветра» was
// renamed «Многоячейковая гроза», a slider supercell and the loaded gun (a lid broken by the day's heating) were added.
// Links to the retired and renamed ones still open the same experiment (share.ts).
/** A plains supercell's hodograph: veering from south-east at the ground through south-west, 0-6 km shear ~28 m/s. */
const PLAINS_WIND: Partial<SimConfig> = { wind0: 8, windDir0: 150, wind05: 14, windDir05: 170, wind1: 17, windDir1: 190, wind3: 20, windDir3: 225, wind6: 26, windDir6: 245, wind10: 35, windDir10: 255 }
export const SCENARIOS: Scenario[] = [
  { name: 'Летний день', mesocyclone: false,
    summary: 'Одиночная гроза с ливнем, без мезоциклона',
    hint: 'Обычный жаркий летний день: влажный перемешанный слой у земли под слабой инверсией, ветер слабый. Одиночная гроза: растёт, выливается ливнем и гаснет в собственном холодном оттоке. Попробуйте сделать средний слой сухим (влажность 3–7 км 15 %): капли, испаряясь в сухом воздухе, отдадут земле меньше дождя',
    values: { bubbleRadius: NARROW, ...SUMMER_AIR, ...LIGHT_WIND } },
  { name: 'Многоячейковая гроза',
    summary: 'Наклонённое облако, новые ячейки на оттоке',
    hint: 'Западный ветер усиливается с высотой (сдвиг 0–6 км ~13 м/с): облако наклоняется, дождь выпадает в стороне от потока, по оттоку растут новые ячейки — многоячейковая гроза',
    values: { bubbleRadius: NARROW, ...SUMMER_AIR, rhSurface: 57, rhLow: 55, rhMid: 50, wind0: 3, wind3: 10, wind6: 16, wind10: 22, windDir0: 250, windDir3: 265, windDir6: 270, windDir10: 270 } },
  { name: 'Классическая суперячейка', mesocyclone: true,
    summary: 'Мезоциклон около часа, град, порывы до 30 м/с',
    hint: 'Суперячейка Великих равнин на обычном профиле (ползунки действуют): влажный тёплый слой у земли (точка росы ~19 °C), крутые градиенты выше, CAPE ~3,5 кДж/кг, сильный сдвиг 0–6 км (~28 м/с) и ветер, поворачивающий с высотой у земли (SRH 0–1 км ~190 м²/с²). Мезоциклон появляется к 20-й минуте и держится около часа, поток до ~55 м/с, у земли — шквал до 30 м/с, град, ливень. Без инверсии: с ней (1,5 K) сухой отток подрезал грозу к 35-й минуте',
    // Calibration (2026-10-12, tests/bench/scout.ts «sc6», 90 min): w 57 m/s, mesocyclone from ~16 min for 54 min (to the
    // end of the run on the large domain), gusts 32 m/s, hail to 1.4 cm, 28 mm; UH 0-1 km 16-43. With a 1.5 K lid or a
    // drier middle (45 -> 35 %) the cold pool (-8 K) undercut the storm by 35-50 min.
    values: { surfaceTemp: 24.5, rhSurface: 72, rhLow: 68, rhMid: 45, rhUpper: 30, lapseLow: 8.5, lapseMid: 7, lapseUpper: 6.5, tropopause: 12, moistLayer: 1, bubble: 1.8, ...PLAINS_WIND } },
  { name: 'Суперячейка WK', mesocyclone: true,
    summary: 'Мезоциклон, расщепление на правую и левую',
    hint: 'Классический опыт Weisman–Klemp: ML CAPE ~3 кДж/кг (у частицы приложения с вовлечением ~2,3), годограф «четверть окружности», один термик, точный перенос. От опыта 1982 года отличается: влажность у земли 16 г/кг вместо 14 и термик +4,8 K вместо +2 — на сетке ~1 км со стандартными ячейка не разгоняется. Ячейка расщепляется на правую (циклоническую) и левую. На стандартной области (48 × 36 км) после ~50-й минуты холодный отток заполняет почти всю область, ячейке нечем дышать и она гаснет; чтобы она жила больше часа, выберите «Размер области: Большая — 96 × 72 км». Профиль задан формулами — ползунки температуры, влажности и ветра не действуют',
    values: { profile: 'weisman-klemp', solarMax: 0, bubble: 1.5 } },
  { name: 'HSLC', mesocyclone: true,
    summary: 'Низкая мини-суперячейка: сильный сдвиг, умеренная CAPE',
    hint: 'Сильный сдвиг при умеренной CAPE (у земли ~1,3 кДж/кг, у самой неустойчивой частицы ~1,7), прохладно и влажно, как осенью или зимой: низкие мини-суперячейки с сильным вращением у земли (SRH 0–1 км ~300 м²/с²). Это НЕ настоящий HSLC: по определению (Sherburn, Parker 2014) там CAPE у земли до 0,5 кДж/кг, а на сетке ~1 км при такой CAPE вращение не держится. И ячейку запускает очень сильный термик (+8 K), сравнимый по плавучести с самой средой; в природе HSLC-грозы поднимает фронт или линия сходимости',
    values: { surfaceTemp: 20.5, rhSurface: 85, rhLow: 80, rhMid: 55, rhUpper: 40, lapseLow: 6.5, lapseMid: 6.8, lapseUpper: 6.5, tropopause: 10, moistLayer: .8, bubble: 2.5,
      wind0: 10, wind05: 20, wind1: 25, wind3: 30, wind6: 35, wind10: 45, windDir0: 150, windDir05: 170, windDir1: 185, windDir3: 210, windDir6: 230, windDir10: 240 } },
  { name: 'Микропорыв', mesocyclone: false,
    summary: 'Дождь испаряется, порыв у земли ~20 м/с',
    hint: 'Жара и сухой воздух до 3 км («перевёрнутое V»), влажная середина: облако с базой ~2,8 км, дождь испаряется по пути вниз, охлаждённый воздух ударяет в землю порывом до ~20 м/с',
    values: { bubbleRadius: NARROW, surfaceTemp: 34, rhSurface: 25, rhLow: 25, rhMid: 70, rhUpper: 35, lapseLow: 9.7, lapseMid: 7.2, lapseUpper: 6.5, tropopause: 12, ...LIGHT_WIND } },
  { name: 'Тропическая конвекция', mesocyclone: false,
    summary: 'Сильный ливень над океаном, вращения нет',
    hint: 'Тёплый океан (28 °C), влажно до 5–6 км (влагосодержание ~57 мм), тропопауза на 16 км, слабый пассат. CAPE ~2,7 кДж/кг растянута на всю тропосферу, поэтому поток слабее, чем над сушей при той же CAPE (~25 м/с — но это всё равно в 2–3 раза больше, чем над океаном в природе: там ядра 2–5 м/с, редко 10–15; модель завышает из-за потока тепла с моря, заданного по солнцу, как над сушей, и сетки ~1 км), зато облако растёт до 14–16 км, а ливень из тёплого дождя доходит до 150 мм/ч. Вращения нет. Область — до 22 км (у остальных сценариев 18,9), чтобы над тропопаузой оставалось место для губки',
    // Calibration (2026-10-10, 40 min): w 22-25 m/s, tops 14-15.6 km, rain 140-160 mm/h and ~20 mm, no rotation.
    values: { bubbleRadius: NARROW, bubble: 1.2, top: 22, surfaceTemp: 28, lapseLow: 6.3, lapseMid: 5.6, lapseUpper: 7.5, tropopause: 16, stratoWarming: 1.5,
      rhSurface: 80, rhLow: 80, rhMid: 75, rhUpper: 50, moistLayer: .5, capStrength: 0, surfaceType: 'water', latitude: 15,
      wind0: 4, windDir0: 90, wind3: 6, windDir3: 100, wind6: 7, windDir6: 110, wind10: 9, windDir10: 120 } },
  { name: 'Суточный ход', mesocyclone: false,
    summary: 'С рассвета: солнце доводит до грозы после полудня',
    hint: 'Старт на рассвете, в 06:00: у земли ночная инверсия (на 6 K холоднее, чем станет днём), термика нет. Сначала солнце съедает инверсию (до ~10 ч), потом перемешанный слой растёт до ~2 км, около полудня появляются кучевые, а через полчаса — первые грозы с ливнем и холодными оттоками. Ждать долго: поставьте скорость побольше',
    // Calibration (2026-10-10): nothing until 10:00, first cumulus 11:57, first thunderstorm 12:31, ~8 mm by 13:30. No
    // lid: under the 1 K one of «Летний день» the mixed layer stops at 1.6 km and no cloud forms all day. No moist layer:
    // its top was unstable in virtual temperature (the profiles are neutralised since 2026-10-11, Environment.neutralise).
    values: { ...SUMMER_AIR, ...LIGHT_WIND, capStrength: 0, moistLayer: 0, bubble: 0, hour: 6, nightInversion: 6 } },
  { name: 'Заряженное ружьё',
    summary: 'Крышка держит до вечера, потом взрывная гроза',
    hint: 'Утро, 9:00. Под тёплой сухой «крышкой» (инверсия 3 K на 1 км, CIN ~150 Дж/кг) — влажный слой, над ней крутые градиенты: CAPE ~3 кДж/кг заперта. Термика нет: солнце медленно греет слой у земли, к обеду растут кучевые, их башни весь день пытаются пробить крышку и гаснут, а около 15:00 прорываются — взрывная гроза с потоком ~60 м/с, вершиной 15–16 км, шквалом ~30 м/с и ливнем. Ждать долго: поставьте скорость побольше',
    // Calibration (2026-10-12, tests/bench/scout.ts «gun4», 7.5 h): calm to ~12:00, cumulus from 12:10, towers to 9-10 km
    // without rain all afternoon, at 14:55-15:20 the break-through: w 47-63 m/s, tops 15-16 km, gusts 33 m/s, 24 mm by
    // 16:30; rotation 4 min (not a mesocyclone). Started at 10:00 it fires at ~16:20, at 11:00 (a warmer profile, CIN
    // 55-75) not by 15:00; caps of 1-1.5 K fire no sooner (the heating of the day decides, not the lid).
    values: { surfaceTemp: 26, rhSurface: 65, rhLow: 65, rhMid: 30, rhUpper: 30, lapseLow: 8, lapseMid: 7.5, lapseUpper: 6.5, tropopause: 12, moistLayer: 1, capHeight: 1, capStrength: 3,
      bubble: 0, hour: 9, latitude: 35, dayOfYear: 170, wind0: 6, windDir0: 170, wind1: 10, windDir1: 190, wind3: 12, windDir3: 220, wind6: 18, windDir6: 240, wind10: 25, windDir10: 250 } },
  { name: 'Холодный фронт',
    summary: 'Фронт прорывает инверсию: на нём встаёт линия гроз',
    hint: 'Тёплый влажный сектор (26 °C, 75 % у земли, CAPE ~2,9 кДж/кг) под слабой «крышкой» 0,7 K: без толчка здесь за час не вырастает ничего, термика нет. С запада подходит холодный фронт: воздух за ним на 9 K холоднее, глубиной 2,5 км, наклон поверхности 1 : 80, скорость 9 м/с на восток. Голова фронта поднимает тёплый влажный воздух, прорывает инверсию — к 35–40-й минуте вдоль фронта растут облака, к 50-й грозы поднимаются до 12 км. Края области гасят ячейки (по 12 км у каждого края, чтобы воздух у них оставался исходным), поэтому «линия» — это отрезок ~10–20 км посередине. Фронт меняется на экране «Зоны» (Z): контраст, глубина, наклон, скорость, направление; можно сделать тёплый.',
    // Calibration (2026-10-13, 50 min, the cold air mass drier): without the front w 3.8 m/s and no cloud above 1.8 km;
    // with it cells from ~35 min, w 21.5 at 40, 32 m/s and tops 12.3 km at 50. The domain follows the mean wind (8.8 m/s east), so the front
    // nearly stands in it: the storms grow along it in view.
    values: { bubble: 0, surfaceTemp: 26, rhSurface: 75, rhLow: 70, rhMid: 50, moistLayer: 1.2, capStrength: .7, lapseMid: 5.8, lapseUpper: 6.2,
      wind0: 4, windDir0: 180, wind3: 12, windDir3: 220, wind6: 18, windDir6: 240, wind10: 24, windDir10: 250,
      frontLine: { kind: 'cold', contrast: 9, depth: 2.5, slope: 80, speed: 9, heading: 90, start: -12 } } },
  // Synoptic situations (2.6): stories over hours, shown apart from the scenarios (they have a story). Calibration
  // 2026-10-13 (tests/bench/scout.ts, 3 h each; the slow test in situations.test.ts).
  { name: 'Тёплый сектор и холодный фронт',
    summary: 'Влага подтягивается, фронт прорывает крышку — грозы на фронте',
    hint: 'Сюжет на 2–3 часа. 10:00, тёплый сектор циклона: 25 °C, южный ветер, слабый задерживающий слой 1,5 K, термика нет. С юга подтягивается влага (+2,5 г/кг в нижних 1,5 км за 3 ч), с 11:00 наверху холодает (ложбина, −2 K на 5–9 км). С запада входит холодный фронт (8 K, 2 км, 10 м/с): к 11:00 его голова прорывает крышку, к 11:15 на фронте грозы, сдвиг умеренный — с вращением. Без фронта та же среда за три часа даёт в модели только кучевые. Честно: CIN здесь всего ~10 Дж/кг — в природе при такой слабой крышке грозы могли бы начаться и без фронта; на сетке ~1 км модель медленно запускает конвекцию от солнца, и слабая крышка держит дольше. Изменения среды ускорены в несколько раз, чтобы сюжет уложился в 2–3 часа (в природе — за 6–12 ч). Фронт — на экране «Зоны», адвекция — в группе «Адвекция» слева',
    // Calibration (scout «ws_full», 3 h): towers from 11:05, w 32 m/s at 11:15, 40 at 11:30, tops 11.6-14.5 km, a
    // mesocyclone 28 min, hail to 8 mm, 10 mm of rain by 12:10. Without the front («ws_nofront») w at most 4.9 m/s.
    values: { bubble: 0, hour: 10, surfaceTemp: 25, rhSurface: 65, rhLow: 60, rhMid: 45, rhUpper: 30, moistLayer: 1, capStrength: 1.5, capHeight: 1.5, lapseLow: 9, lapseMid: 6.3, lapseUpper: 6.5,
      wind0: 5, windDir0: 170, wind3: 12, windDir3: 210, wind6: 18, windDir6: 235, wind10: 25, windDir10: 245, frameMotion: [8, 4],
      largeScale: [{ quantity: 'moisture', bottom: 0, top: 1.5, amount: 2.5, start: 0, hours: 3 }, { quantity: 'temperature', bottom: 5, top: 9, amount: -2, start: 1, hours: 2 }],
      frontLine: { kind: 'cold', contrast: 8, depth: 2, slope: 80, speed: 10, heading: 100, start: -25 } },
    story: [[0, 'Тёплый сектор: влажно и тепло, но крышка держит — только дымка'], [.25, 'С запада входит холодный фронт, с юга подтягивается влага'], [1, 'Голова фронта прорывает крышку: вдоль фронта растут башни'], [1.25, 'Грозы на фронте, до 11–14 км, с вращением'], [2, 'Наверху холодает (ложбина) — грозы на фронте не слабеют']] },
  { name: 'Высотная ложбина',
    summary: 'Солнце запускает грозы, холод наверху не даёт им утихнуть',
    hint: 'Сюжет на 3 часа. 10:00, континентальный воздух: 27 °C, суховато, крышки нет, термика нет. С 10:30 подходит высотная ложбина — на 4–10 км холодает на 3 K за 2 часа. Солнце доводит до гроз к 11:30, как в обычный день. Без ложбины к 13:00 всё затихает — но это свойство маленькой области модели: отток гроз заполняет её всю (48 × 36 км); в природе новые грозы росли бы на границах оттока до вечера. С ложбиной профиль всё круче, холод наверху возвращает неустойчивость остывшему воздуху, и новые грозы растут до конца. Ускорено: в природе ложбина приносит 2–4 K за 6–12 ч; модель меняет только температуру — подъём воздуха перед ложбиной и усиление ветра наверху не учтены. Сравните: в группе «Адвекция» слева нажмите «Убрать все»',
    // Calibration (scouts «c0_trough» and «c0_still», 3 h): both fire at ~11:20-11:30 (w 27-32 m/s); from 12:30 the plain
    // day dies out (w 3-6 m/s by 12:40-13:00), with the trough w 11-14 m/s and new rain to 13:00.
    values: { bubble: 0, hour: 10, surfaceTemp: 27, rhSurface: 50, rhLow: 45, rhMid: 40, rhUpper: 30, moistLayer: 1, capStrength: 0, lapseLow: 9.3, lapseMid: 6.2, lapseUpper: 6.5,
      wind0: 3, windDir0: 220, wind3: 8, windDir3: 250, wind6: 13, windDir6: 265, wind10: 18, windDir10: 270,
      largeScale: [{ quantity: 'temperature', bottom: 4, top: 10, amount: -3, start: .5, hours: 2 }] },
    story: [[0, 'Утро: солнце греет землю, крышки нет'], [.5, 'Подходит высотная ложбина: на 4–10 км начинает холодать'], [1.3, 'Солнце довело до гроз: башни и первые ливни'], [2.3, 'Без ложбины грозы в этой маленькой области затихли бы — а наверху всё холоднее, растут новые']] },
  { name: 'Тёплый воздух над слоем: гроз не будет',
    summary: 'Тот же день, но тёплый воздух наверху запирает конвекцию',
    hint: 'Сюжет на 2 часа. Тот же воздух, что в «Высотной ложбине»: 27 °C, крышки нет, CAPE ~1,8 кДж/кг — в обычный день к 11:30 здесь грозы. Но на 2–3,5 км, над слоем перемешивания, ветер приносит тёплый воздух: +3 K за 2 часа. Это не «тёплая адвекция вообще»: в синоптике тёплая адвекция обычно связана с подъёмом воздуха и может давать приподнятую конвекцию. Здесь — вынос тёплого сухого воздуха над слоем перемешивания (как «тёплый нос» на 850–700 гПа): крышка растёт быстрее, чем солнце прогревает воздух у земли, кучевые упираются в неё, грозы так и не начинаются. Подъём, который в природе сопровождал бы адвекцию и частично охлаждал крышку, в модели не учтён; изменение ускорено (в природе — 0,2–0,5 K/ч). Тёплый воздух ниже, внутри слоя перемешивания, подействовал бы наоборот — слой прогрелся бы весь. Сравните: в группе «Адвекция» слева нажмите «Убрать все» — и к 11:30 вырастут грозы',
    // Calibration (scouts «c0_warm» and «c0_still», 3 h): with the warm air aloft w at most 3.9 m/s, no cloud; without it
    // towers from 11:20, w 27 m/s, 6 mm of rain. At 1-2.5 km («wa_full») it warmed the whole mixed layer and gave more.
    values: { bubble: 0, hour: 10, surfaceTemp: 27, rhSurface: 50, rhLow: 45, rhMid: 40, rhUpper: 30, moistLayer: 1, capStrength: 0, lapseLow: 9.3, lapseMid: 6.2, lapseUpper: 6.5,
      wind0: 3, windDir0: 220, wind3: 8, windDir3: 250, wind6: 13, windDir6: 265, wind10: 18, windDir10: 270,
      largeScale: [{ quantity: 'temperature', bottom: 2, top: 3.5, amount: 3, start: 0, hours: 2 }] },
    story: [[0, 'Утро: CAPE хватает на грозы, крышки нет'], [.3, 'На 2–3,5 км теплеет: ветер приносит тёплый воздух'], [1.3, 'В обычный день здесь уже росли бы грозы — а кучевые упираются в крышку'], [2, 'Крышка окрепла на 3 K: грозы так и не начнутся']] },
]
