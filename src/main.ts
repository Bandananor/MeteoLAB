import '@fontsource/onest/400.css'
import '@fontsource/onest/500.css'
import '@fontsource/onest/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/layout.css'
import './styles/app.css'
import { applyTheme, chartPalette, MONO, STATION_LETTERS, themeChoice, type ThemeChoice } from './theme'
import { Atmosphere, type Live } from './atmosphere'
import { RadarPanel } from './radar/panel'
import { SkewTPanel } from './skewt/panel'
import { StationPanel } from './station/panel'
import { ComparePanel } from './compare/panel'
import { EchoMaps } from './compare/run'
import { EnsemblePanel } from './ensemble/panel'
import { RegimePanel } from './regime/panel'
import { SeriesPanel } from './series/panel'
import { seriesBase, seriesTemplate } from './series/series'
import { modelNetCDF } from './export/fields'
import { MODEL_VERSION } from './version'
import { mediaStamp, runLink as stampLink, setRunLink, stampColumns, stampPngBlob } from './export/stamp'
import type { InterventionKind } from './core'
import { environmentOf, heatOf, moistureOf, turnOf, withHeat, withMoisture, withShear, withTurn } from './settings/simple'
import { DetectorPanel } from './detector/panel'
import { AnalysisPanel } from './analysis/panel'
import { SatellitePanel } from './satellite/panel'
import { elapsed as runTime, timeOfDay } from './clock'
import { ZonesPanel } from './zones/panel'
import { AdvectionEditor, advectionMarkup } from './largescale-ui'
import { frameSettings, CELL_STAGES, type Expectation, expectations, type Flank, type StormFlanks, AIR_MASSES, buildSituation, SHEARS, type StoryStage, storyStage, TRIGGERS, MESO_PERSISTENCE, TORNADO_DEFAULTS, TORNADO_LEVELS, TORNADO_NOTES, tornadoSigns, type TornadoThresholds, UH_ROTATING, readState, createGrid, describeBalance, DT, Environment, liftParcel, parcelIndices, SCENARIOS, type SimConfig, rotationSummary, SPIN_SUPERCELL, spinProfile, stormIndices, stormMotion, UH_LAYERS, type UhLayer, environmentProfile, parseSounding, soundingProfile, SoundingError, computeSounding, type Sounding } from './core'
import { type FieldMode, fieldInfo } from './render/fields'
import { type LayerMode, OBSERVER_BACK, OBSERVER_NEAR, type Quality } from './render/view'
import { cleanSettings, decodeSettings, download, encodeSettings, toCsv } from './share'
import { HODOGRAPH_NODES, nudgeSounding, sliderNode } from './hodograph'
import { applyLayout, askGuide, askLayout, Hud, isPhone, savedLayout, suggestedLayout } from './hud'
import { Timeline } from './timeline'
import { DEFAULTS as defaults, fillLowWind } from './defaults'
import { cloudGenus, hailWord, rainWord } from './describe'
import { type CameraGrade, GRADE_SLIDERS, loadGrade, NEUTRAL_GRADE, saveGrade } from './camera'
import { decimal, L, lang, otherLanguagePath, rememberLang } from './i18n'
import { VideoRecorder } from './record/recorder'

// Settings whose change restarts the run (the rest act on the running model): marked ↻ at their label.
// Units of the sliders.
const KM = L(' км', ' km'), MS = L(' м/с', ' m/s'), KKM = L(' K/км', ' K/km'), JKG = L('Дж/кг', 'J/kg'), NO = L('№', '#')
const resetKeys = new Set<keyof SimConfig>(['surfaceTemp','lapseLow','lapseMid','lapseUpper','tropopause','stratoWarming','capStrength','capHeight','rhSurface','rhLow','rhMid','rhUpper','moistLayer','wind0','wind05','wind1','wind3','wind6','wind10','windDir0','windDir05','windDir1','windDir3','windDir6','windDir10','latitude','bubble','surfaceType','city'])
const RESTART = `<span class="field__restart" title="${L('Изменение перезапускает расчёт', 'Changing it restarts the run')}">↻</span>`

// Markup pieces of the design system (styles/components.css).
const slider = (key: keyof SimConfig, label: string, min: number, max: number, step: number, value: number, unit: string, digits = 0) => `
  <label class="field"><span class="field__head"><span class="field__label">${label}${resetKeys.has(key) ? RESTART : ''}</span><output class="field__value" data-output="${key}"></output></span>
    <input class="range" data-key="${key}" data-unit="${unit}" data-digits="${digits}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"></label>`
/**
 * A collapsible group; `profile` groups are dimmed when the scenario's profile is analytic, `id` ones remember being
 * open.
 */
const group = (title: string, body: string, o: { count?: number; tag?: string; open?: boolean; profile?: boolean; id?: string; bare?: boolean } = {}) => `
  <details class="group"${o.open ? ' open' : ''}${o.profile ? ' data-profile' : ''}${o.id ? ` data-group="${o.id}"` : ''}><summary><span class="group__title">${title}</span>${o.profile ? `<span class="group__tag" hidden>${L('формулы WK', 'WK formulas')}</span>` : ''}${o.count || o.tag ? `<span class="group__count">${o.count ?? o.tag}</span>` : ''}</summary>${o.bare ? body : `<div class="group__body">${body}</div>`}</details>`
/** A knob of the simple settings: a slider of its own (src/settings/simple.ts changes the profile), not a SimConfig key. */
const knob = (id: string, label: string, min: number, max: number, step: number, title: string) => `
  <label class="field" title="${title}"><span class="field__head"><span class="field__label">${label}${RESTART}</span><output class="field__value" id="${id}Out"></output></span>
    <input class="range" id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="0"></label>`
/** The interventions by hand (core/intervene.ts): kind, name, what it does. */
const HAND: [InterventionKind, string, string][] = [
  ['thermal', L('Термик', 'Thermal'), L('+3 K и подъём до 2,7 км — как двойной щелчок', '+3 K and a lift up to 2.7 km — as a double click')],
  ['warm', L('Нагреть', 'Warm'), L('+2 K у земли, до ~1 км: солнце на сухой поляне, город', '+2 K near the ground, to ~1 km: the sun on a dry clearing, a town')],
  ['cool', L('Охладить', 'Cool'), L('−2 K у земли: тень облаков, озеро', '−2 K near the ground: cloud shade, a lake')],
  ['moisten', L('Увлажнить', 'Moisten'), L('+2 г/кг пара до ~1 км, не выше 95 % влажности', '+2 g/kg of vapour to ~1 km, at most 95 % humidity')],
  ['dry', L('Иссушить', 'Dry'), L('−2 г/кг пара: сухой вынос', '−2 g/kg of vapour: a dry intrusion')],
  ['coldPool', L('Холодный купол', 'Cold pool'), L('−6 K в нижних ~700 м: отток выпавшего дождя, растечётся фронтом порывов', '−6 K in the lowest ~700 m: a rained-out outflow that spreads as a gust front')],
  ['vortex', L('Вихрь', 'Vortex'), L('вращение против часовой, 10 м/с на 3 км от центра, до ~3 км вверх', 'an anticlockwise spin, 10 m/s 3 km from the centre, up to ~3 km')],
]
/** A row of the values table: the quantity (with its «i»), now, the most so far this run (or of the chosen cell), the unit. */
const mrow = (id: string, label: string, unit: string, tip?: string) =>
  `<tr data-metric="${id}"><th scope="row"><span class="label">${label}</span>${tip ? info(tip) : ''}</th><td class="num mtable__now" id="${id}">—</td><td class="num mtable__max" id="${id}Max">—</td><td class="unit">${unit}</td></tr>`
/** A block's CSV button (main.ts blockCsv): the block's quantities with the model time and the seed. */
const csvButton = (block: string) => `<button class="btn btn--xs diag__csv" data-csv="${block}" title="${L('Значения этого блока в CSV — с модельным временем и зерном опыта', 'This block’s values as CSV — with the model time and the run’s seed')}">CSV</button>`
const info = (tip: string) => `<button class="info" popovertarget="${tip}" aria-expanded="false" aria-label="${L('Что это', 'What is this')}">i</button>`
type PairItem = [id: string, label: string, unit: string, title?: string]
const pair = (...items: PairItem[]) => `<div class="pair">${items.map(([id, label, unit, title]) =>
  `<div${title ? ` title="${title}"` : ''}><span class="label">${label}</span><span class="metric__value"><span class="metric__num" id="${id}">—</span><span class="unit">${unit}</span></span></div>`).join('')}</div>`
const stat = (id: string, label: string, unit: string, title?: string) =>
  `<div class="stat"${title ? ` title="${title}"` : ''}><span>${label}</span><span class="stat__v"><span id="${id}">—</span> <span class="unit">${unit}</span></span></div>`
const tip = (id: string, title: string, text: string, scale = '', foot = '') =>
  `<div id="${id}" popover class="popover"><div class="popover__title">${title}</div><div class="popover__text">${text}</div>${scale}${foot ? `<div class="popover__foot">${foot}</div>` : ''}</div>`

// The scenario note under the buttons ends with the environment's own numbers (standard parcels, MetPy conventions).
/** ML CAPE and CIN, shear and SRH of a configuration's environment, as one line. */
function environmentNums(c: SimConfig) {
  const grid = createGrid(), env = new Environment(c, grid, environmentProfile(c, grid.height)), p = parcelIndices(env, grid.height), k = stormIndices(env, p)
  const minus = (v: number) => String(Math.round(v)).replace('-', '−')
  return L(`ML CAPE ${minus(p.ml.cape)} Дж/кг · ML CIN ${minus(p.ml.cin)} · сдвиг 0–6 км ${Math.round(k.shear06)} м/с · SRH 0–1 км ${Math.round(k.srh01)} м²/с²`,
    `ML CAPE ${minus(p.ml.cape)} J/kg · ML CIN ${minus(p.ml.cin)} · 0–6 km shear ${Math.round(k.shear06)} m/s · SRH 0–1 km ${Math.round(k.srh01)} m²/s²`)
}
const presets = SCENARIOS.map(s => ({ ...s, nums: environmentNums({ ...defaults, ...s.values }) }))
/**
 * The scenario buttons in two columns, in their order: long names take the whole row, and so does a short one that
 * would otherwise stand alone (before a long one or at the end), so that no gap is left for a later button to fill.
 */
const wideOf = (names: string[]) => {
  const wide = names.map(n => n.length > 14)
  for (let i = 0, col = 0; i < wide.length; i++) {
    if (wide[i]) { col = 0; continue }
    if (col === 0 && (i + 1 >= wide.length || wide[i + 1])) wide[i] = true
    else col = 1 - col
  }
  return wide
}
const plainPresets = presets.flatMap((p, i) => p.story ? [] : [i]), situationPresets = presets.flatMap((p, i) => p.story ? [i] : [])
const scenarioButtons = (indices: number[]) => { const wide = wideOf(indices.map(i => presets[i].title)); return indices.map((i, k) => `<button class="btn${wide[k] ? ' is-wide' : ''}" data-preset="${i}" aria-pressed="false">${presets[i].title}</button>`).join('') }
const choice = (id: string, label: string, items: Record<string, { name: string }>) => `<div class="field"><span class="field__label">${label}</span><span class="select"><select id="${id}">${Object.entries(items).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('')}</select></span></div>`

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `<div class="app">
  <header class="topbar">
    <a class="logo" href="../" title="${L('На главную', 'Home')}"><span class="logo__mark"></span>MeteoLab</a>
    <span class="topbar__sep"></span>
    <span class="status" id="statusText">${L('Идёт расчёт', 'Running')}</span><span class="num faint m-only" data-hud="speed">×8</span>
    <span class="topbar__stats"><span title="${L('Время расчёта — часы:минуты:секунды с начала опыта', 'Run time — hours:minutes:seconds since the start of the experiment')}">T+<b id="time">0:00:00</b></span><span title="${L('Местное солнечное время в модели: начальное время (ползунок «Местное солнечное время») плюс время расчёта', 'Local solar time in the model: the start time (the “Local solar time” slider) plus the run time')}"><b id="localTime">—</b></span><span title="${L('Потоки расчёта физики', 'Threads computing the physics')}"><b id="threads">—</b> ${L('потоков', 'threads')}</span><span class="faint" id="domainSize">48 × 36 × 19 ${L('км', 'km')}</span></span>
    <span class="topbar__spacer"></span>
    <nav class="topbar__group topbar__menus" aria-label="${L('Меню', 'Menu')}"><button class="btn btn--quiet topmenu__btn" popovertarget="menuRun">${L('Опыт', 'Run')}</button><div class="popover topmenu" id="menuRun" popover><button class="topmenu__item" data-tool="#restart">${L('Перезапустить', 'Restart')}</button><button class="topmenu__item" data-tool="#pause">${L('Пауза / продолжить', 'Pause / resume')} <span class="kbd">${L('Пробел', 'Space')}</span></button><hr><button class="topmenu__item" data-tool="#soundingOpen">${L('Из зондирования…', 'From a sounding…')}</button><button class="topmenu__item" data-tool="#loadState">${L('Открыть файл .meteolab…', 'Open a .meteolab file…')}</button><button class="topmenu__item" id="framesOpen" title="${L('Проиграть точный прогон на мелкой сетке (npm run precise, файл frames.mlframes): ползунок по времени, все приборы на каждом кадре', 'Play back a precise run on a fine grid (npm run precise, the file frames.mlframes): a slider over the time, every instrument at each frame')}">${L('Проиграть точный прогон…', 'Play back a precise run…')}</button><button class="topmenu__item" data-tool="#saveState">${L('Сохранить расчёт в файл', 'Save the run to a file')}</button><button class="topmenu__item" data-tool="#share">${L('Ссылка на опыт', 'Link to the run')}</button></div><button class="btn btn--quiet topmenu__btn" popovertarget="menuInstruments">${L('Приборы', 'Instruments')}</button><div class="popover topmenu" id="menuInstruments" popover><button class="topmenu__item" id="radarOpen" title="${L('Доплеровский радар: отражаемость на выбранном угле наклона луча', 'Doppler radar: reflectivity at the chosen beam tilt')}">${L('Доплеровский радар', 'Doppler radar')} <span class="kbd">R</span></button><button class="topmenu__item" id="skewOpen" title="${L('Аэрологическая диаграмма Skew-T log-p: профиль среды, частица, CAPE/CIN, ветер и зонд в модели у выбранной ячейки', 'Skew-T log-p diagram: the environment’s profile, the parcel, CAPE/CIN, the wind and a sounding taken in the model at the selected cell')}">${L('Skew-T log-p', 'Skew-T log-p')} <span class="kbd">S</span></button><button class="topmenu__item" id="zonesOpen" title="${L('Зоны среды и фронт на карте: участки земли, где воздух у земли теплее или холоднее, влажнее или суше, и холодный или тёплый фронт — гроза пройдёт через них', 'Environment zones and a front on the map: patches of ground where the near-surface air is warmer or colder, moister or drier, and a cold or warm front — the storm will pass through them')}">${L('Зоны среды и фронт', 'Environment zones and a front')} <span class="kbd">Z</span></button><button class="topmenu__item" id="detectorOpen" title="${L('Грозопеленгатор: удары в землю и внутриоблачные вспышки на карте, плотность молний на км², частота вспышек и её скачки', 'Lightning detector: ground strokes and in-cloud flashes on the map, flash density per km², the flash rate and its jumps')}">${L('Грозопеленгатор', 'Lightning detector')} <span class="kbd">L</span></button><button class="topmenu__item" id="analysisOpen" title="${L('Приземный анализ: карта области, как у синоптика — изобары давления у земли с центрами H и L, фронт, осадки и станции с температурой, точкой росы, давлением, ветром и погодой', 'Surface analysis: a forecaster’s map of the domain — surface isobars with H and L centres, the front, precipitation and stations with temperature, dew point, pressure, wind and weather')}">${L('Приземный анализ', 'Surface analysis')} <span class="kbd">A</span></button><button class="topmenu__item" id="satelliteOpen" title="${L('Метеоспутник: гроза сверху в видимом канале и в инфракрасном (температура вершин облаков), с перегревающимися вершинами (I)', 'Weather satellite: the storm from above in the visible channel and the infrared (the cloud tops’ temperature), with overshooting tops (I)')}">${L('Метеоспутник', 'Weather satellite')} <span class="kbd">I</span></button><button class="topmenu__item" id="stationOpen" title="${L('Виртуальная метеостанция: поставьте её щелчком на земле и смотрите метеограмму — температуру, давление, ветер с порывами и осадки, когда гроза проходит над ней', 'Virtual weather station: place it with a click on the ground and watch the meteogram — temperature, pressure, wind with gusts and precipitation as the storm passes over it')}">${L('Метеостанции', 'Weather stations')} <span class="kbd">M</span></button></div><button class="btn btn--quiet topmenu__btn" popovertarget="menuExperiments">${L('Эксперименты', 'Experiments')}</button><div class="popover topmenu" id="menuExperiments" popover><button class="topmenu__item" id="compareOpen" title="${L('Сравнение двух опытов (C): запомнить этот как A, изменить настройку и смотреть A и B рядом', 'Comparing two runs (C): remember this one as A, change a setting and watch A and B side by side')}">${L('Сравнение двух опытов (A/B)', 'Comparing two runs (A/B)')} <span class="kbd">C</span></button><button class="topmenu__item" id="ensembleOpen" title="${L('Ансамбль (E): эти настройки много раз с разными зёрнами — вероятности мезоциклона, града, ветра и карты осадков', 'Ensemble (E): these settings many times with different seeds — the chances of a mesocyclone, hail, wind and rain maps')}">${L('Ансамбль', 'Ensemble')} <span class="kbd">E</span></button><button class="topmenu__item" id="regimeOpen" title="${L('Карта режимов (K): этот опыт на сетке влажности и сдвига — где одиночные, многоячейковые и суперячейки', 'Regime map (K): this run on a grid of moisture and shear — where the ordinary cells, multicells and supercells are')}">${L('Карта режимов CAPE × сдвиг', 'Regime map CAPE × shear')} <span class="kbd">K</span></button><button class="topmenu__item" id="seriesOpen" title="${L('Пакетная серия (B): много опытов по файлу — перебор любых настроек и зёрен; итог — таблица CSV и NetCDF со всеми опытами', 'Batch series (B): many runs from a file — any settings and seeds varied; the results as a CSV table and one NetCDF with every run')}">${L('Пакетная серия…', 'Batch series…')} <span class="kbd">B</span></button><button class="topmenu__item" data-tool="#handToggle">${L('Воздействие руками', 'Intervene by hand')} <span class="kbd">H</span></button></div><button class="btn btn--quiet topmenu__btn" popovertarget="menuExport">${L('Экспорт', 'Export')}</button><div class="popover topmenu" id="menuExport" popover><button class="topmenu__item" id="exportNetcdf" title="${L('Все поля модели в этот момент (ветер, θ, пар, гидрометеоры, отражаемость, следы на земле, базовое состояние) в NetCDF по соглашениям CF — для xarray, MetPy, Panoply; в файле версия модели, настройки и зерно', 'All the model’s fields at this moment (wind, θ, vapour, hydrometeors, reflectivity, the swaths, the base state) as CF NetCDF — for xarray, MetPy, Panoply; the file holds the model’s version, the settings and the seed')}">${L('Поля модели — NetCDF', 'Model fields — NetCDF')}</button><button class="topmenu__item" data-tool="#timelineCsv">${L('Ряды «Хода грозы» — CSV', '“Storm history” series — CSV')}</button><button class="topmenu__item" data-tool="#snapshotButton">${L('Снимок 3D-вида — PNG', '3D view snapshot — PNG')} <span class="kbd">P</span></button><button class="topmenu__item" data-tool="#videoButton">${L('Видео 3D-вида — MP4', '3D view video — MP4')} <span class="kbd">V</span></button><p class="topmenu__note">${L('Каждый прибор выгружает свои данные сам: CSV и PNG — на его экране.', 'Each instrument exports its own data: CSV and PNG on its screen.')}</p></div></nav>
    <span class="topbar__sep"></span>
    <a class="btn btn--quiet" href="../guide/" target="_blank" rel="noopener" title="${L('Как пользоваться: где какие кнопки, как менять параметры, приборы, телефон (откроется в новой вкладке, расчёт не прервётся)', 'How to use it: where the buttons are, how to change settings, the instruments, the phone (opens in a new tab, the run goes on)')}">${L('Справка', 'Guide')}</a>
    <a class="btn btn--quiet" id="langSwitch" href="#" title="${L('English version', 'Русская версия')}">${L('EN', 'RU')}</a>
    <button class="btn btn--quiet" id="layoutToggle" title="${L('Телефонный вид: 3D во весь экран, крупные цифры, панель под палец. Выбор запоминается', 'Phone layout: 3D on the whole screen, large numbers, a panel for the thumb. The choice is remembered')}">${L('Телефонный вид', 'Phone layout')}</button>
    <div class="seg seg--text" role="group" aria-label="${L('Тема', 'Theme')}"><button data-theme-set="auto" title="${L('Как в системе', 'As the system')}">${L('Авто', 'Auto')}</button><button data-theme-set="light">${L('Светлая', 'Light')}</button><button data-theme-set="dark">${L('Тёмная', 'Dark')}</button></div>
  </header>
  <main class="app__main">
    <aside class="side side--left" aria-label="${L('Начальные условия', 'Initial conditions')}">
      <div class="side__scroll">
        <div class="side__block">
          <h2 class="side__title d-only">${L('Сценарии', 'Scenarios')}</h2>
          <div class="scenarios d-only">${scenarioButtons(plainPresets)}</div>
          <h2 class="side__title side__title--sub d-only" title="${L('Сюжет на несколько часов: воздушная масса, что приносит ветер (адвекция), фронт и солнце', 'A story of a few hours: the air mass, what the wind brings (advection), a front and the sun')}">${L('Синоптические ситуации', 'Synoptic situations')}</h2>
          <div class="scenarios d-only">${scenarioButtons(situationPresets)}</div>
          <h2 class="side__title side__title--sub d-only">${L('Своя среда', 'Your own environment')}</h2>
          <button class="btn btn--block" id="soundingOpen" title="${L('Реальное зондирование из файла или вставленного текста: Вайомингский университет, SHARPpy, input_sounding CM1/WRF, CSV — гроза в среде конкретного дня', 'A real sounding from a file or pasted text: University of Wyoming, SHARPpy, CM1/WRF input_sounding, CSV — a storm in the environment of a given day')}">${L('Реальное зондирование…', 'Real sounding…')}</button>
          <details class="builder"><summary>${L('Собрать свою ситуацию', 'Build your own situation')}</summary>
            ${choice('sitMass', L('Воздушная масса', 'Air mass'), AIR_MASSES)}${choice('sitTrigger', L('Что запускает конвекцию', 'What sets off convection'), TRIGGERS)}${choice('sitShear', L('Сдвиг ветра', 'Wind shear'), SHEARS)}
            <div class="field"><span class="field__label">${L('Начало', 'Start')}</span><span class="select"><select id="sitHour">${[8, 9, 10, 11, 12, 13].map(h => `<option value="${h}"${h === 10 ? ' selected' : ''}>${h}:00</option>`).join('')}</select></span></div>
            <button class="btn btn--block btn--primary" id="sitBuild" type="button">${L('Собрать и запустить', 'Build and run')}</button></details>
          <div class="scards m-only">${presets.map((p, i) => `<button class="scard" data-preset="${i}" aria-pressed="false"><span class="scard__name">${p.title}</span><span class="scard__desc">${p.summary}</span><span class="scard__nums">${p.nums}</span></button>`).join('')}</div>
          <div class="scenario-note d-only" id="scenarioNote">
            <div class="scenario-note__head"><span class="scenario-note__name" id="scenarioName"></span><button class="btn btn--quiet btn--xs" id="scenarioMore">${L('Подробнее', 'More')}</button></div>
            <div class="scenario-note__text" id="scenarioText"></div>
            <ol class="story" id="story" hidden></ol>
          </div>
          <div class="notice" id="profileLocked" hidden>${L('Профиль задан формулами — ползунки температуры, влажности и ветра не действуют.', 'The profile is set by formulas — the temperature, humidity and wind sliders have no effect.')}</div>
        </div>
        <div class="env-summary" aria-live="polite"><div class="env-summary__head">${L('Среда на старте', 'Starting environment')}<span class="t-caption" title="${L('Частица перемешанного слоя (ML, нижние 100 гПа) по соглашениям MetPy; сдвиг — разность ветра 0–6 км; SRH — для правой ячейки по Банкерсу; DCAPE — нисходящая частица из слоя 700–500 гПа', 'The mixed-layer parcel (ML, the lowest 100 hPa) by the MetPy conventions; the shear — the 0–6 km wind difference; SRH — for the Bunkers right mover; DCAPE — the downdraught parcel from the 700–500 hPa layer')}">ML · MetPy</span></div><dl class="env-summary__grid" id="envSummary"></dl></div>
        ${group(L('Основные параметры', 'Main parameters'), `
          ${knob('simpleHeat', L('Жара: воздух у земли', 'Heat: the air near the ground'), -6, 6, .5, L('Теплее или холоднее сценария у земли (до 1,5 км): больше или меньше CAPE', 'Warmer or cooler than the scenario near the ground (up to 1.5 km): more or less CAPE'))}
          ${knob('simpleMoisture', L('Влажность нижних 1,5 км', 'Moisture of the lowest 1.5 km'), .7, 1.3, .05, L('Пар у земли как доля сценария: топливо грозы — CAPE и низкое основание облаков', 'The vapour near the ground as a share of the scenario’s: the storm’s fuel — CAPE and a low cloud base'))}
          ${knob('simpleShear', L('Ветер наверху: сдвиг 0–6 км', 'Wind aloft: 0–6 km shear'), 0, 40, 1, L('Насколько ветер на 6 км сильнее, чем у земли: слабый — одиночные ячейки, умеренный — многоячейковые, сильный — суперячейки', 'How much stronger the wind at 6 km is than at the ground: weak — ordinary cells, moderate — multicells, strong — supercells'))}
          ${knob('simpleTurn', L('Поворот ветра 0–3 км', 'Wind turning 0–3 km'), -45, 180, 5, L('На сколько градусов ветер поворачивает по часовой стрелке от земли до 3 км: поворот даёт спиральность (SRH) и вращение', 'How many degrees the wind turns clockwise from the ground to 3 km: the turning gives helicity (SRH) and rotation'))}
          <p class="t-caption" id="simpleNote" hidden></p>`, { open: true })}
        ${group(L('Температурный профиль', 'Temperature profile'), `
          ${slider('surfaceTemp',L('Температура у земли', 'Surface temperature'),15,40,.5,30,' °C',1)}
          ${slider('lapseLow',L('Градиент 0–3 км', 'Lapse rate 0–3 km'),3,11,.1,8.4,KKM,1)}
          ${slider('lapseMid',L('Градиент 3–8 км', 'Lapse rate 3–8 km'),3,11,.1,7.2,KKM,1)}
          ${slider('lapseUpper',L('Градиент 8 км–TP', 'Lapse rate 8 km–TP'),3,11,.1,6.5,KKM,1)}
          ${slider('tropopause',L('Тропопауза', 'Tropopause'),8,17,.5,11,KM,1)}
          ${slider('stratoWarming',L('Стратосферный градиент', 'Stratospheric gradient'),-1,4,.1,1.2,KKM,1)}
          ${slider('capStrength',L('Задерживающий слой (инверсия)', 'Cap (inversion)'),0,6,.25,0,' K',2)}
          ${slider('capHeight',L('Высота инверсии', 'Inversion height'),.5,4,.1,1.5,KM,1)}`, { count: 8, open: true, profile: true })}
        ${group(L('Влажность по слоям', 'Humidity by layer'), `
          ${slider('rhSurface',L('У земли', 'Surface'),20,100,1,72,' %')}
          ${slider('rhLow',L('1–3 км', '1–3 km'),10,100,1,60,' %')}
          ${slider('rhMid',L('3–7 км', '3–7 km'),5,100,1,42,' %')}
          ${slider('rhUpper',L('7 км–TP', '7 km–TP'),5,100,1,28,' %')}
          ${slider('moistLayer',L('Влажный перемешанный слой', 'Moist mixed layer'),0,2.5,.1,0,KM,1)}`, { count: 5, open: true, profile: true })}
        ${group(L('Профиль ветра', 'Wind profile'), `
          ${slider('wind0',L('Ветер у земли', 'Surface wind'),-20,30,1,2,MS)}
          ${slider('wind05',L('Ветер на 0,5 км', 'Wind at 0.5 km'),-20,35,1,3,MS)}
          ${slider('wind1',L('Ветер на 1 км', 'Wind at 1 km'),-20,40,1,5,MS)}
          ${slider('wind3',L('Ветер на 3 км', 'Wind at 3 km'),-10,45,1,10,MS)}
          ${slider('wind6',L('Ветер на 6 км', 'Wind at 6 km'),-10,60,1,20,MS)}
          ${slider('wind10',L('Ветер на 10 км', 'Wind at 10 km'),-10,75,1,28,MS)}
          ${slider('windDir0',L('Направление у земли', 'Surface direction'),0,360,5,160,'°')}
          ${slider('windDir05',L('Направление на 0,5 км', 'Direction at 0.5 km'),0,360,5,165,'°')}
          ${slider('windDir1',L('Направление на 1 км', 'Direction at 1 km'),0,360,5,170,'°')}
          ${slider('windDir3',L('Направление на 3 км', 'Direction at 3 km'),0,360,5,185,'°')}
          ${slider('windDir6',L('Направление на 6 км', 'Direction at 6 km'),0,360,5,215,'°')}
          ${slider('windDir10',L('Направление на 10 км', 'Direction at 10 km'),0,360,5,235,'°')}`, { count: 12, profile: true })}
        ${group(L('Поверхность и радиация', 'Surface and radiation'), `
          <div class="field"><span class="field__label">${L('Тип поверхности', 'Surface type')}${RESTART}</span><span class="select"><select id="surfaceType"><option value="grass">${L('Трава', 'Grass')}</option><option value="dry">${L('Сухая почва', 'Dry soil')}</option><option value="water">${L('Вода', 'Water')}</option><option value="urban">${L('Город', 'City')}</option></select></span></div>
          ${slider('hour',L('Местное солнечное время', 'Local solar time'),5,21,.25,13.5,L(' ч', ' h'),2)}
          ${slider('dayOfYear',L('День года: 80 — равноденствие, 172 — 21 июня, 355 — 21 декабря', 'Day of the year: 80 — equinox, 172 — 21 June, 355 — 21 December'),1,365,1,80,'',0)}
          ${slider('solarMax',L('Солнце в зените', 'Sun at the zenith'),300,1200,25,1000,L(' Вт/м²', ' W/m²'))}
          ${slider('soilMoisture',L('Влажность почвы', 'Soil moisture'),0,100,1,45,' %')}
          ${slider('city',L('Город в центре, радиус (0 — нет)', 'City in the centre, radius (0 — none)'),0,12,1,0,KM)}`, { count: 6 })}
        ${group(L('Инициирование', 'Initiation'), `
          ${slider('bubble',L('Сила начального термика (0 — без термика)', 'Starting thermal strength (0 — no thermal)'),0,2.5,.05,1,'×',2)}
          <p class="t-caption">${L('Тёплые пузыри у земли на старте (+3,2 K и 1,1 м/с в центре, радиус ~4 км, до 2,7 км) — как в идеализированных опытах; ещё термик — двойным щелчком по земле или меню «Эксперименты» → «Воздействие руками».', 'Warm bubbles near the ground at the start (+3.2 K and 1.1 m/s at the centre, a ~4 km radius, up to 2.7 km), as in idealised experiments; more thermals — a double click on the ground or “Experiments” → “Intervene by hand”.')}</p>`, { count: 1 })}
        ${group(L('Динамика: Кориолис и турбулентность', 'Dynamics: Coriolis and turbulence'), `
          ${slider('latitude',L('Широта / Кориолис', 'Latitude / Coriolis'),0,75,1,45,'°')}
          ${slider('turbulence',L('Субсеточная турбулентность', 'Subgrid turbulence'),0,2,.05,.55,'×',2)}`, { count: 2 })}
        ${group(L('Адвекция: среда меняется', 'Advection: the environment changes'), advectionMarkup(), { id: 'advection' })}
        ${group(L('Численная схема и расчёт', 'Numerics and computation'), `
          <div class="field" title="${L('Точный перенос (WENO 5-го порядка, по умолчанию) почти не размывает восходящие потоки и сам сохраняет массу воды. Быстрый (полулагранжев) примерно вдвое дешевле, но размывает потоки: в сильном сдвиге термик не стартует', 'Accurate transport (5th-order WENO, the default) hardly smears the updraughts and conserves the water mass by itself. Fast (semi-Lagrangian) costs about half as much but smears them: in strong shear the thermal does not start')}"><span class="field__label">${L('Перенос', 'Transport')}</span><span class="select"><select id="transport"><option value="weno">${L('Точный (WENO5)', 'Accurate (WENO5)')}</option><option value="semi-lagrangian">${L('Быстрый (полулагранжев)', 'Fast (semi-Lagrangian)')}</option></select></span></div>
          <label class="check" title="${L('Область сдвигается вместе с грозой (правая ячейка по Банкерсу при сдвиге 0–6 км от 15 м/с, иначе средний ветер 0–6 км): гроза остаётся внутри и не въезжает с другой стороны в собственный холодный отток. Ветер, годограф и радар — относительно земли', 'The domain moves with the storm (the Bunkers right mover with 0–6 km shear from 15 m/s, else the 0–6 km mean wind): the storm stays inside and does not drive into its own cold outflow from the other side. The wind, the hodograph and the radar are ground-relative')}"><input type="checkbox" id="followStorm" checked> ${L('Область движется вместе с грозой', 'The domain moves with the storm')}${RESTART}</label>
          <label class="check" title="${L('Электризация облака и молнии: заряд на крупе, кристаллах и каплях, поле и разряды (IC и в землю). Выключение ускоряет расчёт примерно на четверть; погода от этого не меняется — заряд не влияет на движение воздуха', 'Cloud electrification and lightning: charge on graupel, crystals and drops, the field and the discharges (IC and to the ground). Turning it off speeds the run up by about a quarter; the weather stays the same — the charge does not move the air')}"><input type="checkbox" id="lightning" checked> ${L('Молнии', 'Lightning')}${RESTART}</label>
          <div class="field" title="${L('Большая область — 96 × 72 км с тем же шагом: ячейкам просторнее, но расчёт примерно в 4 раза медленнее', 'Large domain — 96 × 72 km at the same spacing: more room for the cells, but the run is about 4 times slower')}"><span class="field__label">${L('Размер области', 'Domain size')}${RESTART}</span><span class="select"><select id="domain"><option value="standard">${L('Стандарт — 48 × 36 км', 'Standard — 48 × 36 km')}</option><option value="large">${L('Большая — 96 × 72 км (в ~4 раза медленнее)', 'Large — 96 × 72 km (~4 times slower)')}</option><option value="custom">${L('Своя…', 'Custom…')}</option></select></span></div>
          <div class="field" title="${L('Со льдом (по умолчанию): облачный лёд, снег и крупа (Lin et al. 1983) — наковальня из кристаллов, теплота замерзания, таяние крупы в дождь. Тёплый дождь (Кесслер) — только капли: дешевле, но без наковальни и теплоты замерзания', 'With ice (the default): cloud ice, snow and graupel (Lin et al. 1983) — an anvil of crystals, the latent heat of freezing, graupel melting into rain. Warm rain (Kessler) — drops only: cheaper, but no anvil and no heat of freezing')}"><span class="field__label">${L('Микрофизика', 'Microphysics')}${RESTART}</span><span class="select"><select id="microphysics"><option value="ice">${L('Со льдом — лёд, снег, крупа', 'With ice — ice, snow, graupel')}</option><option value="warm">${L('Тёплый дождь (Кесслер)', 'Warm rain (Kessler)')}</option></select></span></div>
          <div id="domainCustom" hidden><label class="field"><span class="field__head"><span class="field__label">${L('Ширина области', 'Domain width')}</span><output class="field__value" id="domainWidthOut">48 ${L('км', 'km')}</output></span><input class="range" type="range" id="domainWidth" min="24" max="144" step="12" value="48"></label><label class="field"><span class="field__head"><span class="field__label">${L('Глубина области', 'Domain depth')}</span><output class="field__value" id="domainDepthOut">36 ${L('км', 'km')}</output></span><input class="range" type="range" id="domainDepth" min="18" max="108" step="9" value="36"></label></div>
          <div class="notice notice--warn" id="domainWarn" hidden><span class="notice__text">${L('Большая область считается медленнее: время шага растёт с площадью (96 × 72 км — в ~4 раза дольше стандартной). До расчёта на видеокарте (WebGPU, в плане) очень большие области на слабом компьютере идут медленно.', 'A larger domain runs slower: a step’s time grows with the area (96 × 72 km takes ~4 times the standard one). Until the computation moves to the GPU (WebGPU, planned) very large domains are slow on a weak computer.')}</span></div>
          ${slider('speed',L('Ускорение времени', 'Time acceleration'),1,120,1,8,'×')}
          <div class="t-caption" id="speedReal"></div>
          <div class="notice notice--warn" id="speedWarn" hidden><span class="notice__text"></span></div>`, { count: 5 })}
        ${group(L('Что рассчитано, а что нет', 'What is computed and what is not'), `<div class="model-notes">${L(`
          <p><b>Рассчитано по уравнениям</b> на сетке ~1,2 км по горизонтали (у земли 100 м по вертикали, выше — растянуто): ветер во всех трёх направлениях, давление (анеластическое приближение), плавучесть с учётом пара и веса капель, перенос тепла, пара, облака и осадков (WENO 5-го порядка), сила Кориолиса. Потоки шире ~6–8 км (5–7 шагов сетки) разрешены хорошо, более узкие сглажены.</p>
          <p><b>Параметризовано</b> — заменено упрощённой формулой, потому что меньше ячейки сетки: турбулентность мельче сетки (Смагоринский, отдельно по горизонтали и вертикали), микрофизика (объёмная: тёплый дождь по Кесслеру, лёд, снег, крупа и град по Лину — каждая частица описана только массой), потоки тепла и пара от поверхности (баланс энергии, трение по шероховатости), солнце (греет только землю; облака его не заслоняют, ночного выхолаживания нет — тени облаков и ночь на 3D-виде только нарисованы), губка у верха области, периодические края.</p>
          <p><b>Только картинка</b>, в расчёт не входит: мелкие детали облаков (фрактальный шум мельче сетки), частицы дождя и снега, тени облаков на земле. Радар, станция и индексы считаются по полям модели; давление станции — гидростатическая оценка.</p>`, `
          <p><b>Computed from the equations</b> on a grid of ~1.2 km horizontally (100 m vertically at the ground, stretched above): the wind in all three directions, the pressure (anelastic approximation), buoyancy with vapour and the weight of the drops, the transport of heat, vapour, cloud and precipitation (5th-order WENO), the Coriolis force. Flows wider than ~6–8 km (5–7 grid steps) are resolved well, narrower ones are smoothed.</p>
          <p><b>Parameterized</b> — replaced by a simplified formula because it is smaller than a grid cell: turbulence below the grid scale (Smagorinsky, separately horizontal and vertical), microphysics (bulk: warm rain after Kessler, ice, snow, graupel and hail after Lin — each kind of particle described by its mass only), heat and vapour fluxes from the surface (energy balance, friction by roughness), the sun (heats only the ground; clouds do not block it, there is no night cooling — cloud shadows and the night in the 3D view are only drawn), a sponge at the top of the domain, periodic edges.</p>
          <p><b>Picture only</b>, not part of the computation: small cloud detail (fractal noise below the grid scale), the rain and snow particles, cloud shadows on the ground. The radar, the station and the indices come from the model’s fields; the station’s pressure is a hydrostatic estimate.</p>`)}
        </div>`)}
      </div>
      <div class="side__actions">
        <div class="side__row"><button class="btn btn--primary btn--l" id="restart">${L('Перезапустить', 'Restart')}</button><button class="btn btn--l" id="pause">${L('Пауза', 'Pause')}</button></div>
        <div hidden><button class="btn btn--block" id="share" title="${L('Скопировать ссылку на этот опыт: все настройки и сид, так что по ней откроется тот же расчёт', 'Copy a link to this experiment: all the settings and the seed, so it opens the same run')}">${L('Ссылка на опыт', 'Link to the run')}</button>
        <div class="side__row"><button class="btn" id="saveState" title="${L('Сохранить расчёт в файл .meteolab (все поля модели в этот момент, ~4 МБ): его можно открыть позже и продолжить с того же места', 'Save the run to a .meteolab file (all the model’s fields at this moment, ~4 MB): open it later and go on from the same point')}">${L('Сохранить', 'Save')}</button><button class="btn" id="loadState" title="${L('Открыть сохранённый файл .meteolab и продолжить расчёт с сохранённого момента', 'Open a saved .meteolab file and continue the run from the saved moment')}">${L('Открыть…', 'Open…')}</button></div>
        </div>
        <span class="select"><select id="rewind" title="${L('Перемотка назад: состояние запоминается каждые 5 модельных минут (последние ~60 МБ). Выбранная минута — и расчёт идёт оттуда заново; более поздние точки забываются', 'Rewind: the state is kept every 5 model minutes (the last ~60 MB). Pick a minute and the run starts again from there; later points are forgotten')}"><option value="">${L('Вернуться к минуте…', 'Go back to minute…')}</option></select></span>
        <input id="stateFile" type="file" accept=".meteolab" hidden><input id="framesFile" type="file" accept=".mlframes" hidden>
        <div class="notice" id="stateNote" role="status" hidden><span class="notice__text"></span><button class="notice__close" aria-label="${L('Закрыть', 'Close')}">×</button></div>
      </div>
    </aside>

    <section class="workspace">
      <nav class="tabs" role="tablist" aria-label="${L('Отображаемое поле', 'Field shown')}">${([['composite', L('Облака', 'Clouds')], ['updraft', L('Вертикальные потоки', 'Vertical motion')], ['theta', L('Температура', 'Temperature')], ['moisture', L('Влажность', 'Moisture')], ['vorticity', L('Завихренность', 'Vorticity')], ['helicity', L('Вращение (UH)', 'Rotation (UH)')], ['coldpool', L('Холодный купол', 'Cold pool')]] as const).map(([f, name]) => `<button class="tab" role="tab" data-field="${f}" aria-selected="${f === 'composite'}"${f === 'helicity' ? ` title="${L('Спиральность восходящего потока: где поднимающийся воздух вращается (слой 2–5 км)', 'Updraft helicity: where the rising air rotates (the 2–5 km layer)')}"` : ''}>${name}</button>`).join('')}</nav>
      <div class="popover ground-menu hand-menu" id="handMenu" popover>
        <span class="popover__title">${L('Воздействие руками', 'Intervene by hand')}</span>
        <span class="popover__text">${L('Выберите, что сделать, и щёлкайте по земле в виде сверху: каждое касание — пятно ~5 км, у земли. Esc — выключить.', 'Choose what to do and click the ground in the view from above: each touch is a patch of ~5 km near the ground. Esc turns it off.')}</span>
        ${HAND.map(([kind, name, note]) => `<button class="ground-menu__item" data-hand="${kind}"><b>${name}</b><small>${note}</small></button>`).join('')}
        <div class="seg seg--text seg--block" data-hand-strength>${[[.5, L('слабо', 'weak')], [1, L('обычно', 'normal')], [2, L('сильно', 'strong')]].map(([v, t]) => `<button data-value="${v}">${t}</button>`).join('')}</div>
        <span class="popover__text" id="handLedger"></span>
        <button class="ground-menu__item" data-hand="off"><b>${L('Выключить', 'Turn off')}</b><small>${L('щелчок по виду снова выбирает ячейку', 'a click on the view chooses a cell again')}</small></button>
      </div>
      <div class="popover ground-menu" id="groundMenu" popover>
        <span class="popover__title">${L('Вид с земли', 'View from the ground')}</span>
        <span class="popover__text">${L('Где встать наблюдателю. Потом перетаскивание — поворот головы, колесо — приближение, двойной щелчок по земле — перейти туда.', 'Where the observer stands. Then drag to turn the head, wheel to zoom, double-click the ground to walk there.')}</span>
        <button class="ground-menu__item" data-stand="far"><b>${L('Сбоку от грозы, 25 км', 'Beside the storm, 25 km')}</b><small>${L('видна вся гроза — башня, наковальня, основание; под ясным небом, со стороны притока, солнце за спиной', 'the whole storm in sight — the tower, the anvil, the base; under a clear sky on the inflow side, the sun behind you')}</small></button>
        <button class="ground-menu__item" data-stand="near"><b>${L('Ближе, 12 км', 'Closer, 12 km')}</b><small>${L('основание потока, полосы дождя и наковальня над головой', 'the updraught’s base, rain shafts and the anvil overhead')}</small></button>
        <button class="ground-menu__item" data-stand="station"><b>${L('У метеостанции', 'At the weather station')}</b><small data-station-note>${L('там, где стоит станция: смотреть на грозу и на её показания', 'where the station stands: watch the storm and its readings')}</small></button>
        <button class="ground-menu__item" data-stand="pick"><b>${L('Выбрать место…', 'Pick a place…')}</b><small>${L('щёлкните по земле в 3D-виде, где встать', 'click the ground in the 3D view where to stand')}</small></button>
        <button class="ground-menu__item" data-stand="leave"><b>${L('Вернуться к виду сверху', 'Back to the view from above')}</b><small>${L('камера там же, где была', 'the camera where it was')}</small></button>
      </div>
      <div class="viewport">
        <canvas id="sim" width="960" height="600"></canvas>
        <div class="cell-labels" id="cellLabels"></div>
        <div class="replay-bar" id="replayBar" hidden><button class="ov-toggle" id="replayPlay" title="${L('Проигрывать кадры подряд / остановить (пробел)', 'Play the frames in a row / stop (Space)')}">▶</button><input class="range replay-bar__range" id="replayRange" type="range" min="0" max="0" step="1" value="0" aria-label="${L('Кадр точного прогона', 'Frame of the precise run')}"><span class="ov-badge" id="replayTime">0:00</span><button class="ov-toggle" id="replayClose" title="${L('Выйти из проигрывания: расчёт начнётся заново с настройками файла', 'Leave the playback: the run starts again with the file’s settings')}">${L('Выйти', 'Leave')}</button></div>
        <div class="ov-pick" id="pickHint" hidden>${L('Щёлкните по земле, где встать · Esc — отмена', 'Click the ground where to stand · Esc — cancel')}</div>
        <button class="immersive-exit" id="immersiveExit" title="${L('Вернуть панели (Esc)', 'Bring the panels back (Esc)')}">✕ ${L('Выйти из полноэкранного', 'Exit full screen')}</button>
        <div class="cam" id="camera"><button class="cam__toggle" id="cameraToggle" aria-expanded="false" title="${L('Экспозиция, яркость, контраст и насыщенность кадра — только в полноэкранном режиме, снимок (P) их сохраняет', 'Exposure, brightness, contrast and saturation of the frame — in full screen only; a snapshot (P) keeps them')}">${L('Камера', 'Camera')}</button>
          <div class="cam__body" id="cameraBody" hidden>${GRADE_SLIDERS.map(s => `<label class="cam__row"><span>${s.label}</span><input type="range" data-grade="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}"><output data-grade-out="${s.key}"></output></label>`).join('')}
            <button class="cam__reset" id="cameraReset">${L('Сбросить', 'Reset')}</button></div></div>
        <div class="gl-lost" id="glLost" role="alert" hidden><div><p>${L('<b>3D-вид отключён браузером</b> — ему не хватило памяти видеокарты (так бывает на телефоне при многих открытых вкладках или после переключения приложений). Расчёт идёт дальше; вид может вернуться сам.', '<b>The browser turned the 3D view off</b> — it ran out of GPU memory (this happens on a phone with many open tabs or after switching apps). The run goes on; the view may come back by itself.')}</p><button class="btn btn--primary" id="glReload" type="button">${L('Перезапустить с теми же настройками', 'Restart with the same settings')}</button></div></div>
        <div class="gl-lost" id="glShader" role="alert" hidden><div><p id="glShaderText"></p><pre class="gl-log" id="glShaderLog"></pre><button class="btn btn--quiet" id="glShaderClose" hidden>${L('Понятно', 'OK')}</button></div></div>
        <div class="ov-tl"><button class="ov-toggle ov-toggle--menu" id="layersToggle" popovertarget="layersMenu" title="${L('Что показать поверх облаков: потоки, частицы осадков, мезоциклон, строение грозы, молнии, сумму осадков', 'What to show over the clouds: the flow, precipitation particles, the mesocyclone, the storm’s structure, lightning, the rain total')}">${L('Слои', 'Layers')} <span class="ov-toggle__count" id="layersCount"></span></button><div class="popover topmenu layers-menu" id="layersMenu" popover><button class="ov-toggle" id="flowToggle" aria-pressed="false">${L('Потоки →', 'Flow →')}</button><button class="ov-toggle" id="precipToggle" aria-pressed="false" title="${L('Частицы осадков: снежинки, опускаясь ниже уровня 0 °C, тают в капли', 'Precipitation particles: snowflakes melt into drops as they sink below the 0 °C level')}">${L('Снег и дождь', 'Snow and rain')}</button><button class="ov-toggle" id="mesoToggle" aria-pressed="true" title="${L('Мезоциклон столбом: кольцо на каждой высоте, где восходящий поток вращается (завихренность от 0,006 с⁻¹), шириной с вращающуюся область, цвет — сила вращения. Видно, как глубоко он идёт, как наклонён сдвигом и доходит ли до земли (низкий мезоциклон). Серый, пока вращение не продержалось 10 мин', 'The mesocyclone as a column: a ring at every height where the updraught rotates (vorticity from 0.006 s⁻¹), as wide as the rotating area, coloured by its strength. It shows how deep it goes, how the shear tilts it and whether it reaches the ground (a low-level mesocyclone). Grey until the rotation has held 10 min')}">${L('Мезоциклон', 'Mesocyclone')}</button><button class="ov-toggle" id="flankToggle" aria-pressed="true" title="${L('Строение суперячейки, как на схеме Lemon и Doswell: у земли — нисходящие потоки FFD (передний фланг, под ядром осадков) и RFD (тыловой, огибает мезоциклон) с их фронтами порывов (край оттока, на 1 K холоднее тёплого воздуха); подписи — приток, мезоциклон, наковальня, фронт порывов', 'The supercell’s structure, as on the Lemon and Doswell diagram: at the ground the FFD (the forward flank, under the precipitation core) and the RFD (the rear flank, wrapping around the mesocyclone) with their gust fronts (the outflow’s edge, 1 K colder than the warm air); labels — the inflow, the mesocyclone, the anvil, the gust front')}">${L('Строение', 'Structure')}</button><button class="ov-toggle" id="lightningToggle" aria-pressed="true" title="${L('Каналы молний в момент вспышки: видны там, где выходят из облака; внутри облака — только его свечение', 'Lightning channels at the moment of a flash: seen where they leave the cloud; inside the cloud only its glow')}">${L('Молнии', 'Lightning')}</button><button class="ov-toggle" id="lightningReplay" title="${L('Последний удар в землю ещё раз, в 20 раз медленнее, как на скоростной съёмке: видно, как слабый ступенчатый лидер ветвится вниз, как вспыхивает и за миллисекунды гаснет обратный удар и как идут повторные удары — чаще всего по тому же каналу (отсюда мерцание)', 'The last ground stroke again, 20 times slower, as on a high-speed camera: the faint stepped leader branching down, the return stroke flashing and fading within milliseconds, and the subsequent strokes — mostly down the same channel (hence the flicker)')}">${L('Повтор удара', 'Replay stroke')}</button><button class="ov-toggle" id="swathToggle" aria-pressed="false" title="${L('Сколько дождя выпало на землю с начала расчёта: голубой до 5 мм, зелёный до 10, жёлтый до 25, оранжевый до 50, красный больше', 'How much rain has fallen on the ground since the start: light blue up to 5 mm, green up to 10, yellow up to 25, orange up to 50, red more')}">${L('Сумма осадков', 'Rain total')}</button></div><button class="ov-toggle" id="groundToggle" aria-pressed="false" popovertarget="groundMenu" title="${L('Встать на землю и смотреть на грозу снизу, как наблюдатель: где встать — в меню. Клавиша G', 'Stand on the ground and watch the storm from below like an observer: where to stand — in the menu. Key G')}">${L('С земли', 'From the ground')}</button><button class="ov-toggle" id="handToggle" aria-pressed="false" popovertarget="handMenu" title="${L('Воздействие руками на ходу: нагреть, охладить, увлажнить, иссушить, положить холодный купол, закрутить вихрь — щелчком по земле. Клавиша H', 'Intervene by hand as it runs: warm, cool, moisten, dry, lay a cold pool, spin a vortex — with a click on the ground. Key H')}">${L('Руками', 'By hand')}</button><button class="ov-toggle" id="immersiveToggle" title="${L('Во весь экран без панелей и кнопок. Выйти — той же кнопкой в углу или Esc. Клавиша F', 'Full screen without panels and buttons. Exit with the button in the corner or Esc. Key F')}">${L('Во весь экран', 'Full screen')}</button><span hidden><button class="ov-toggle" id="snapshotButton" title="${L('Сохранить кадр 3D-вида картинкой PNG — без панелей, как он есть сейчас. Клавиша P', 'Save the 3D view as a PNG image — without the panels, as it is now. Key P')}">${L('Снимок', 'Snapshot')}</button><button class="ov-toggle" id="videoButton" title="${L('Записать видео 3D-вида кадр за кадром: ровные 30 или 60 кадров в секунду в нужном размере на любом устройстве, MP4. Клавиша V', 'Record a video of the 3D view frame by frame: an even 30 or 60 frames per second at the size you need on any device, MP4. Key V')}">${L('Видео', 'Video')}</button></span></div>
        <div class="ov-bl"><span class="ov-badge" id="surfaceReadout">${L('ТРАВА', 'GRASS')}</span><button class="ov-badge ov-quality" id="qualityToggle" title="${L('Качество картинки: облака считаются лучом по объёму, и это самая дорогая часть кадра. «Авто» само снижает качество, если кадры идут медленнее ~22 в секунду, и повышает, когда запас есть. Нажатие — следующий вариант', 'Picture quality: the clouds are ray-marched through the volume, the costliest part of a frame. “Auto” lowers the quality when frames come slower than ~22 a second and raises it when there is room. Click — the next option')}">${L('КАЧЕСТВО: АВТО', 'QUALITY: AUTO')}</button><span class="ov-chip">${L('ЛКМ — вращение · ПКМ — сдвиг · колесо — масштаб · 2× клик — термик', 'LMB — rotate · RMB — pan · wheel — zoom · double-click — thermal')}</span></div>
        <div class="ov-br"><div class="ov-legend" id="cloudLegend"><span><i style="--c:#d8e0e3"></i>${L('облачная вода', 'cloud water')}</span><span><i style="--c:#4e7692"></i>${L('осадки', 'precipitation')}</span><span><i style="--c:#b68b59"></i>${L('восходящий', 'updraught')}</span><span><i style="--c:#7189a5"></i>${L('нисходящий', 'downdraught')}</span></div></div>
        <div class="ov-tr" id="fieldPanel" hidden><div class="field-panel">
          <div class="field-panel__head"><span class="field-panel__title" id="fieldTitle"></span><button class="btn btn--quiet btn--s m-only" id="fieldSettingsToggle" aria-expanded="false" aria-controls="fieldSettings">${L('Настройки ▾', 'Settings ▾')}</button></div>
          <div class="colorbar"><div class="colorbar__bar" id="colorbar"></div><div class="colorbar__ticks"><span id="fieldMin"></span><span id="fieldMid"></span><span id="fieldMax"></span></div></div>
          <div class="field-panel__settings" id="fieldSettings">
            <div class="field" id="uhLayerRow" hidden title="${L('UH = Σ w·ζ·Δz по слою: насколько поднимающийся воздух вращается. 2–5 км — средний мезоциклон (как в цифрах модели); 0–1 и 0–3 км — нижний, главный признак опасности смерча; весь поток — вращается ли он целиком или только середина', 'UH = Σ w·ζ·Δz over a layer: how much the rising air rotates. 2–5 km — the mid-level mesocyclone (as in the model’s numbers); 0–1 and 0–3 km — the low-level one, the main sign of tornado danger; the whole updraught — whether it rotates throughout or only in the middle')}"><span class="field__label">${L('Слой вращения', 'Rotation layer')}</span><span class="select"><select id="uhLayer">${(Object.keys(UH_LAYERS) as UhLayer[]).map(k => `<option value="${k}">${UH_LAYERS[k].label}</option>`).join('')}</select></span></div>
            <label class="field"><span class="field__head"><span class="field__label">${L('Высота горизонтального среза', 'Horizontal slice height')}</span><output class="field__value" id="sliceHeightOut">2.0 ${L('км', 'km')}</output></span><input class="range" id="sliceHeight" type="range" min="0.1" max="18.5" step="0.1" value="2"></label>
            <label class="field"><span class="field__head"><span class="field__label">${L('Разрез север ↔ юг', 'Cross-section north ↔ south')}</span><output class="field__value" id="sliceNorthOut">0 ${L('км', 'km')}</output></span><input class="range" id="sliceNorth" type="range" min="-17.5" max="17.5" step="0.5" value="0"></label>
            <div class="field"><span class="field__label">${L('Отображение', 'Display')}</span><span class="select"><select id="layerMode"><option value="both">${L('Срезы + объём сильных отклонений', 'Slices + volume of strong anomalies')}</option><option value="slices">${L('Только срезы', 'Slices only')}</option><option value="volume">${L('Только объём (всё поле)', 'Volume only (the whole field)')}</option></select></span></div>
            <div id="volumeControls" hidden>
              <label class="field"><span class="field__head"><span class="field__label">${L('Порог прозрачности', 'Transparency threshold')}</span><output class="field__value" id="volumeThresholdOut">10 %</output></span><input class="range" id="volumeThreshold" type="range" min="0" max="0.8" step="0.02" value="0.1"></label>
              <label class="field"><span class="field__head"><span class="field__label">${L('Плотность объёма', 'Volume density')}</span><output class="field__value" id="volumeDensityOut">1.0×</output></span><input class="range" id="volumeDensity" type="range" min="0.2" max="4" step="0.1" value="1"></label>
            </div>
          </div>
        </div></div>
      </div>
      <div class="readout"><span>${L('Сетка', 'Grid')} <b id="gridSize">40 × 32 × 50</b></span><span>Δx / Δy <b id="gridSpacing">1.2 / 1.1 ${L('км', 'km')}</b></span><span>Δz <b>0.1 → 1 ${L('км', 'km')}</b></span><span>Δt <b>${DT} ${L('с', 's')}</b></span><span>${L('Область', 'Domain')} <b id="frameMotion">—</b></span><span>${L('Инсоляция', 'Insolation')} <b id="sun">—</b></span><span>${L('Солнце', 'Sun')} <b id="sunElevation">—</b></span></div>
    </section>

    <aside class="side side--right diagnostics" aria-label="${L('Диагностика', 'Diagnostics')}"><div class="diag">
      <section class="mode" id="modeCard"><div class="mode__head"><span class="label">${L('Режим грозы', 'Storm mode')}</span><span class="badge" id="mesoBadge" hidden>${L('мезоциклон', 'mesocyclone')}</span></div><div class="mode__title" id="cellType">—</div><div class="mode__reason" id="cellReason">${L('ожидание инициализации', 'waiting for initiation')}</div><div class="mode__reason" id="cloudGenus" title="${L('Самое высокое облако по международной классификации: кучевое по толщине, кучево-дождевое — когда вершина холоднее −20 °C (оледенела), с наковальней — когда растекается на уровне равновесия (EL)', 'The tallest cloud by the international classification: cumulus by its depth, cumulonimbus once the top is colder than −20 °C (glaciated), with an anvil once it spreads at the equilibrium level (EL)')}"></div><div class="mode__cell" id="cellStage"></div></section>
      <section class="cells"><div class="cells__head"><span class="label" id="cellCount">${L('Ячейки', 'Cells')}</span><button class="btn btn--quiet btn--s" id="cellAll" aria-pressed="true" title="${L('Показатели по всей области: максимумы по всем ячейкам', 'Values over the whole domain: maxima over all the cells')}">${L('Вся область', 'Whole domain')}</button></div><div class="cells__list" id="cellList"></div></section>
      <section class="chart"><div class="diag__scope"><span class="label" id="metricScope">${L('Показатели по всей области', 'Values over the whole domain')}</span>${csvButton('metrics')}</div>
        <table class="mtable"><thead><tr><th></th><th>${L('сейчас', 'now')}</th><th title="${L('Наибольшее с начала опыта (у выбранной ячейки — с её выбора)', 'The most since the run’s start (of a chosen cell — since it was chosen)')}">${L('макс.', 'max')}</th><th></th></tr></thead><tbody>
          ${mrow('updraft', L('Восходящий поток', 'Updraught'), L('м/с', 'm/s'))}
          ${mrow('uh', L('Вращение UH 2–5 км', 'Rotation UH 2–5 km'), L('м²/с²', 'm²/s²'), 'tip-uh')}
          ${mrow('rain', L('Дождь в ядре', 'Rain in the core'), L('мм/ч', 'mm/h'), 'tip-rain')}
          ${mrow('rainTotal', L('Сумма в самой мокрой точке', 'Total at the wettest point'), L('мм', 'mm'), 'tip-rainTotal')}
          ${mrow('gust', L('Ветер у земли', 'Surface wind'), L('м/с', 'm/s'), 'tip-gust')}
          ${mrow('hail', L('Град у земли', 'Hail at the ground'), L('см', 'cm'), 'tip-hail')}
        </tbody></table>
        <div class="mtable__notes t-caption"><span id="rainWord"></span> <span id="hailWord"></span> <span id="hailSwath"></span></div>
        </section>
      <section class="chart"><div class="chart__head"><span class="chart__title">${L('Ход грозы', 'Storm history')}</span><span class="chart__actions"><button class="btn btn--xs" id="timelineCsv" title="${L('Выгрузить ряды «Хода грозы» в CSV (таблица или скрипт): время, CAPE и CIN, поток, UH, дождь', 'Export the “Storm history” series to CSV (a spreadsheet or a script): time, CAPE and CIN, updraught, UH, rain')}">CSV</button></span></div>
        <canvas id="timeline" title="${L('Ход грозы по модельному времени (вся область, точка каждые 30 с): неустойчивость среды сейчас (CAPE и CIN частицы от земли по живому зондированию — вдали от гроз, раз в модельную минуту), самый сильный восходящий поток, вращение потока, дождь у земли и вспышки молний за последнюю минуту. Перезапуск начинает графики заново', 'The storm over model time (the whole domain, a point every 30 s): the instability of the environment now (CAPE and CIN of the surface parcel from the live sounding — away from the storms, once a model minute), the strongest updraught, its rotation, the rain at the ground and the lightning flashes in the last minute. A restart begins the charts anew')}"></canvas></section>
      <div class="diag__groups">
        ${group(L('Прогноз по среде: чего ждать', 'Forecast from the environment: what to expect'), `<ul class="expect" id="expectList"></ul><p class="t-caption" id="expectNote">${L('Прогноз по среде на старте опыта — по статистике настоящих гроз (источник у каждой строки); справа — что вышло в модели за этот прогон. Расхождение — тоже урок: среда даёт шанс, а не гарантию, и у модели свои пределы (сетка ~1 км, одномоментная микрофизика). У синоптических ситуаций среда меняется по сюжету — прогноз по ней на старте.', 'A forecast from the environment at the start of the run — by the statistics of real storms (the source on each row); on the right, what the model made of it this run. A mismatch is a lesson too: an environment gives a chance, not a guarantee, and the model has its limits (a ~1 km grid, one-moment microphysics). The synoptic situations change their environment as their story goes — the forecast is from the start.')}</p>`, { id: 'expect' })}
        ${group(L('Индексы среды (живое зондирование)', 'Environment indices (live sounding)'), `
          <div class="diag__tools">${csvButton('indices')}</div>
          ${pair(['cape', 'CAPE', JKG, L('Частица приложения: +0,5 K и вовлечение сухого воздуха (разбавленная CAPE)', 'The app’s parcel: +0.5 K and entrainment of dry air (dilute CAPE)')], ['cin', 'CIN', JKG])}
          ${pair(['mlcape', 'MLCAPE', JKG, L('Перемешанный слой 100 гПа (стандартная частица, без добавок)', 'The 100 hPa mixed layer (the standard parcel, nothing added)')], ['mlcin', 'MLCIN', JKG, L('CIN частицы перемешанного слоя', 'CIN of the mixed-layer parcel')])}
          ${pair(['mucape', 'MUCAPE', JKG, L('Наиболее неустойчивая частица в нижних 300 гПа', 'The most unstable parcel in the lowest 300 hPa')], ['dcape', 'DCAPE', JKG, L('Энергия нисходящего потока: сила холодных оттоков и микропорывов', 'Downdraught energy: the strength of cold outflows and microbursts')])}
          ${pair(['srh01', L('SRH 0–1 км', 'SRH 0–1 km'), L('м²/с²', 'm²/s²'), L('Спиральность относительно правой ячейки (движение по Банкерсу), слой 0–1 км: главный признак смерчеопасной среды', 'Helicity relative to the right mover (Bunkers motion), 0–1 km: the main sign of a tornadic environment')], ['srh03', L('SRH 0–3 км', 'SRH 0–3 km'), L('м²/с²', 'm²/s²'), L('Спиральность относительно правой ячейки, слой 0–3 км', 'Helicity relative to the right mover, 0–3 km')])}
          ${pair(['scp', 'SCP', '', L('Сложный параметр суперячейки (MUCAPE, SRH 0–3 км, сдвиг 0–6 км). Больше 1 — среда благоприятна для суперячеек', 'Supercell composite parameter (MUCAPE, SRH 0–3 km, 0–6 km shear). Above 1 — the environment favours supercells')], ['stp', 'STP', '', L('Параметр значимого смерча, фиксированный слой (SBCAPE, LCL, SRH 0–1 км, сдвиг 0–6 км). Больше 1 — благоприятно для сильных смерчей', 'Significant tornado parameter, fixed layer (SBCAPE, LCL, SRH 0–1 km, 0–6 km shear). Above 1 — favourable for strong tornadoes')])}
          ${pair(['ship', 'SHIP', '', L('Параметр значимого града (MUCAPE, влажность частицы, градиент 700–500 гПа, температура на 500 гПа, сдвиг 0–6 км). Больше 1 — вероятен град от 5 см', 'Significant hail parameter (MUCAPE, the parcel’s moisture, the 700–500 hPa lapse rate, the temperature at 500 hPa, 0–6 km shear). Above 1 — hail of 5 cm and larger is likely')], ['lapse75', L('Градиент 700–500', 'Lapse 700–500'), L('°C/км', '°C/km'), L('Падение температуры с высотой между 700 и 500 гПа: от 7 °C/км — крутой «сухой» слой, растит CAPE и град', 'How fast the temperature falls between 700 and 500 hPa: 7 °C/km and more is a steep layer that builds CAPE and hail')])}`, { count: 15, id: 'indices' })}
          ${pair(['dcp', 'DCP', '', L('Параметр деречо (DCAPE, MUCAPE, сдвиг и средний ветер 0–6 км, Evans и Doswell 2001). Больше 2 — холодные оттоки достаточно сильны, а поток достаточно быстр для долгого шквала (деречо, дугообразное эхо), если грозы соберутся в линию; соберутся ли — индекс не говорит', 'Derecho composite parameter (DCAPE, MUCAPE, 0–6 km shear and mean wind, Evans and Doswell 2001). Above 2 — cold outflows strong enough and a flow fast enough for a long-lived wind storm (a derecho, a bow echo) if storms organize into a line; whether they will, it does not say')])}
          ${pair(['esrh', L('Эфф. SRH', 'Eff. SRH'), L('м²/с²', 'm²/s²'), L('Спиральность в эффективном слое притока (Thompson и др. 2007): слое, откуда частицы дают CAPE ≥ 100 и CIN не сильнее −250 Дж/кг, — воздух, которым гроза действительно питается, даже если он над землёй. От 150 — среда суперячеек со смерчами', 'Helicity in the effective inflow layer (Thompson et al. 2007): the layer whose parcels give CAPE ≥ 100 and CIN no stronger than −250 J/kg — the air the storm really feeds on, even above the ground. From 150 — the environment of tornadic supercells')], ['eshear', L('Эфф. сдвиг', 'Eff. shear'), L('м/с', 'm/s'), L('Сдвиг от основания эффективного слоя до половины высоты EL частицы MU — глубина сдвига по самой грозе, а не всегда 0–6 км. От 18 м/с — суперячейки', 'Shear from the effective layer’s base to half the MU parcel’s EL — the shear over the storm’s own depth instead of always 0–6 km. From 18 m/s — supercells')])}
        ${group(L('Среда: зондирование и уровни', 'Environment: sounding and levels'), `
          <canvas id="sounding" class="side-chart"></canvas>
          <div class="legend"><span><i style="--c:#4f7180"></i>${L('среда', 'environment')}</span><span><i class="dash" style="--c:#5a9a6a"></i>${L('точка росы', 'dew point')}</span><span><i style="--c:#b46e43"></i>${L('частица', 'parcel')}</span><span><i class="area" style="--c:rgba(207,109,73,.55)"></i>CAPE</span><span><i class="area" style="--c:rgba(77,134,179,.5)"></i>CIN</span></div>
          <dl class="kv"><dt>LCL</dt><dd id="lcl">—</dd><dt>LFC</dt><dd id="lfc">—</dd><dt>EL</dt><dd id="el">—</dd><dt>0 °C</dt><dd id="freezing">—</dd></dl>`, { tag: 'Skew-T', id: 'sounding' })}
        ${group(L('Ветер: годограф и сдвиг', 'Wind: hodograph and shear'), `
          <canvas id="hodograph" class="side-chart side-chart--square"></canvas>
          <div class="legend"><span><i style="--c:#c4553a"></i>0–3 ${L('км', 'km')}</span><span><i style="--c:#4f8f5b"></i>3–6 ${L('км', 'km')}</span><span><i style="--c:#3f6fa3"></i>6–10 ${L('км', 'km')}</span></div>
          <div class="hodo-edit"><span class="t-caption" id="hodoHint"></span><button class="btn btn--quiet btn--xs" id="hodoReset" type="button" hidden>${L('Вернуть ветер', 'Restore the wind')}</button></div>
          <div><div class="stat"><span>${L('Сдвиг ветра 0–6 км', '0–6 km wind shear')}</span><span class="stat__v" id="shear">—</span></div><div class="t-caption" id="shearHint"></div></div>`, { id: 'hodograph' })}
        ${group(L('Все показатели грозы', 'All the storm’s values'), `<div>
          <div class="diag__tools">${csvButton('all')}</div>
          ${stat('downdraft', L('Макс. нисходящий поток', 'Max downdraught'), L('м/с', 'm/s'))}
          ${stat('uhLow', L('Низкое вращение (UH 0–1 / 0–3 км)', 'Low-level rotation (UH 0–1 / 0–3 km)'), L('м²/с²', 'm²/s²'), L('Вращение восходящего потока у земли: низкоуровневый мезоциклон — признак ячейки, опасной по смерчам. На сетке ~0,65 км слой 0–1 км — один уровень, 0–3 км — четыре', 'Rotation of the updraught near the ground: a low-level mesocyclone, the sign of a cell that may produce tornadoes. On the ~0.65 km grid the 0–1 km layer is one level, 0–3 km four'))}
          <div class="tornado" title="${L('Определитель признаков смерчеобразования по всей области: вращение у земли, держащееся несколько минут, мезоциклон над ним, среда (STP, SRH 0–1 км, низкое основание облака) и не слишком холодный отток. Сам смерч сетка ~1 км не разрешает — это признаки, по которым о нём судят синоптики', 'Tornadogenesis signs over the whole domain: rotation at the ground holding for several minutes, a mesocyclone above it, the environment (STP, SRH 0–1 km, a low cloud base) and an outflow not too cold. The ~1 km grid does not resolve the tornado itself — these are the signs forecasters judge it by')}">${stat('tornadoLevel', L('Признаки смерчеобразования', 'Tornadogenesis signs'), '')}<p class="t-caption" id="tornadoNote"></p><ul class="tornado__checks" id="tornadoChecks"></ul>
            <details class="tornado__more"><summary>${L('Пороги', 'Thresholds')}</summary><div class="tornado__grid"><label class="tornado__th"><span>${L('UH 0–1 км, м²/с²', 'UH 0–1 km, m²/s²')}</span><input type="number" step="1" data-tornado="uh01"></label><label class="tornado__th"><span>${L('держится, мин', 'holds, min')}</span><input type="number" step="0.5" data-tornado="held"></label><label class="tornado__th"><span>${L('STP от', 'STP from')}</span><input type="number" step="0.1" data-tornado="stp"></label><label class="tornado__th"><span>${L('SRH 0–1 км от', 'SRH 0–1 km from')}</span><input type="number" step="10" data-tornado="srh01"></label><label class="tornado__th"><span>${L('LCL до, км', 'LCL up to, km')}</span><input type="number" step="0.1" data-tornado="lcl"></label><label class="tornado__th" title="${L('Холод оттока θv′ в 2 км от вращения у земли', 'The outflow cold θv′ within 2 km of the rotation at the ground')}"><span>${L('отток до, K', 'outflow up to, K')}</span><input type="number" step="0.5" data-tornado="cold"></label></div><button class="btn btn--quiet btn--xs" id="tornadoReset" type="button">${L('По умолчанию', 'Defaults')}</button></details></div>
          <div class="chart" title="${L('Профиль w·ζ по высоте в ядре с наибольшим UH (среднее по 3×3 столбцам): на какой высоте и как глубоко вращается восходящий поток. Ниже — корреляция w и ζ по всей области на 2–6 км: в суперячейке поток и циклоническое вращение совпадают (на сетке ~1 км у WK 0,15–0,25), в обычной грозе они рядом, а не вместе (около 0)', 'The w·ζ profile by height in the core with the largest UH (mean over 3×3 columns): at what height and how deep the updraught rotates. Below — the correlation of w and ζ over the whole domain at 2–6 km: in a supercell the updraught and the cyclonic rotation coincide (WK 0.15–0.25 on the ~1 km grid), in an ordinary storm they lie side by side, not together (about 0)')}"><span class="chart__sub">${L('На какой высоте вращается поток (ядро с макс. UH)', 'At what height the updraught rotates (the core with max UH)')}</span><canvas id="spin"></canvas><span class="t-caption" id="spinNote">—</span></div>
          ${stat('cloudTop', L('Вершина облака', 'Cloud top'), L('км', 'km'))}
          ${stat('thermalTop', L('Вершина термика', 'Thermal top'), L('км', 'km'))}
          ${stat('cloudWater', L('Макс. облачная вода', 'Max cloud water'), L('г/кг', 'g/kg'))}
          ${stat('coldPool', L('Холод оттока θv′', 'Outflow cold θv′'), 'K', L('На сколько воздух у земли холоднее окружающего тёплого воздуха — по виртуальной потенциальной температуре θv, как меряют отток (Markowski и др. 2002). В природе обычно 2–8 K; у суперячеек модели 8–11 K — её отток холоднее природного (одномоментная микрофизика). Тёплый воздух — три четверти области у земли, так что дневной прогрев не путает. В определителе смерча — этот же холод в 2 км от вращения у земли', 'How much colder the air at the ground is than the warm air around — by the virtual potential temperature θv, as outflows are measured (Markowski et al. 2002). In nature usually 2–8 K; under the model’s supercells 8–11 K — its outflow is colder than nature’s (one-moment microphysics). The warm air is three quarters of the domain at the ground, so the day’s heating does not confuse it. The tornado detector reads the same cold within 2 km of the rotation at the ground'))}
          <div class="stat" id="rkwCard" title="${L('Критерий RKW (Rotunno, Klemp, Weisman 1988): скорость растекания холодного купола C = √(2∫(−B)dz) против разности ветра среды 0–2,5 км Δu. Около 1 — поток у фронта порывов стоит прямо, новые ячейки растут на нём (долгоживущие линии); больше — купол убегает вперёд, ячейки заваливаются над оттоком; меньше — сдвиг наклоняет ячейки, купол слишком слаб', 'The RKW criterion (Rotunno, Klemp, Weisman 1988): the cold pool’s spreading speed C = √(2∫(−B)dz) against the environmental wind difference over 0–2.5 km Δu. About 1 — the updraught at the gust front stands upright and new cells grow on it (long-lived lines); more — the pool runs ahead and the cells lean over the outflow; less — the shear tilts the cells, the pool is too weak')}"><span>${L('Купол / сдвиг 0–2,5 км (RKW)', 'Cold pool / 0–2.5 km shear (RKW)')}</span><span class="stat__v"><span id="rkw">—</span> <span class="unit" id="rkwNote">C/Δu</span></span></div>
          ${stat('clipped', L('Срабатывания ограничителей', 'Limiter hits'), L('с начала', 'since the start'), L('Сколько раз скорость упёрлась в предохранитель (|u|,|v| ≤ 120, |w| ≤ 100 м/с — заметно выше любых реальных гроз). Не ноль — расчёт пошёл вразнос, цифрам доверять нельзя.', 'How many times a velocity hit the safety limit (|u|,|v| ≤ 120, |w| ≤ 100 m/s — well above any real storm). Not zero — the run has blown up, the numbers cannot be trusted.'))}
        </div>`, { count: 9, id: 'all' })}
        ${group(L('Что происходит', 'What is happening'), `<p class="diag__logic" id="logicText">${L('Частица ещё не достигла уровня свободной конвекции.', 'The parcel has not reached the level of free convection yet.')}</p>`, { open: true, id: 'logic', bare: true })}
      </div>
    </div>
    ${tip('tip-uh', L('Вращение потока, UH 2–5 км', 'Updraught rotation, UH 2–5 km'), L('Спиральность восходящего потока: насколько поднимающийся воздух вращается циклонически в слое 2–5 км.', 'Updraft helicity: how much the rising air rotates cyclonically in the 2–5 km layer.'), `<dl class="popover__scale"><dt>≥ ${UH_ROTATING}</dt><dd>${L('поток вращается (подсветка в 3D)', 'the updraught rotates (highlighted in 3D)')}</dd></dl>`, L(`Мезоциклон решается не по UH, а по вращению ядра потока: завихренность на 2–5 км ≥ 3·10⁻³ с⁻¹ в течение ${MESO_PERSISTENCE / 60} мин.`, `A mesocyclone is decided not by UH but by the rotation of the updraught’s core: vorticity at 2–5 km ≥ 3·10⁻³ s⁻¹ for ${MESO_PERSISTENCE / 60} min.`))}
    ${tip('tip-rain', L('Дождь в ядре сейчас', 'Rain in the core now'), L('Самый сильный дождь у земли в эту минуту — где бы он ни шёл, обычно под ядром грозы (поток ρ·q_r·V_t). Ядро движется и проходит над одной точкой за 5–15 минут, поэтому 100 мм/ч в ядре дают в точке не 100 мм за час, а 5–20 мм. Сколько выпало в одном месте — «Сумма в самой мокрой точке» и метеостанция.', 'The heaviest rain at the ground this minute — wherever it falls, usually under the storm’s core (the flux ρ·q_r·V_t). The core moves and passes over one point in 5–15 minutes, so 100 mm/h in the core gives that point not 100 mm in an hour but 5–20 mm. How much fell in one place — “Total at the wettest point” and the weather station.'))}
    ${tip('tip-rainTotal', L('Сумма в самой мокрой точке', 'Total at the wettest point'), L('Наибольшая сумма дождя на земле с начала расчёта — в той точке, где выпало больше всего (полоса осадков на 3D-виде). В точке, над которой прошло ядро, сумма меньше: интенсивность в ядре держится там лишь минуты. Ход дождя в своей точке показывает метеостанция.', 'The largest rain total on the ground since the start — at the point where the most fell (the rain swath in the 3D view). Where the core passed over, the total is smaller: the core’s rate lasts only minutes there. The weather station shows the rain at its own point.'))}
    ${tip('tip-gust', L('Порыв у земли', 'Surface gust'), L('Самый сильный ветер у земли (нижний уровень модели, ~0–50 м — тот же, что у метеостанции): оттоки и микропорывы под грозой. Это среднее по клетке ~1 км: настоящий порыв в ней сильнее примерно в 1,3–1,5 раза.', 'The strongest wind near the ground (the model’s lowest level, ~0–50 m — the same as the weather station’s): outflows and microbursts under the storm. It is a mean over a ~1 km cell: a real gust in it is about 1.3–1.5 times stronger.'))}
    ${tip('tip-hail', L('Град у земли', 'Hail at the ground'), L('Крупнейшие градины, долетевшие до земли сейчас; ниже — крупнейшие за весь прогон.', 'The largest hailstones reaching the ground now; below — the largest of the whole run.'))}
    </aside>
  </main>
</div>
<dialog class="modal modal--wide sounding-dialog" id="soundingDialog"><form method="dialog" style="display:contents">
  <h2 class="modal__title">${L('Реальное зондирование', 'Real sounding')}</h2>
  <p class="modal__text">${L('Гроза в среде конкретного дня: температура, влажность и ветер по высоте берутся из зондирования, а не из ползунков. Форматы: текст Вайомингского университета (<a href="https://weather.uwyo.edu/upperair/sounding.shtml" target="_blank" rel="noopener">weather.uwyo.edu</a>, вид «Text: List» — можно скопировать страницу целиком), SHARPpy, <code>input_sounding</code> CM1 / WRF, CSV с заголовками (pres, hght, temp, dwpt, drct, sknt…). Нужны данные хотя бы до 10 км.', 'A storm in the environment of a given day: temperature, humidity and wind by height come from the sounding, not from the sliders. Formats: University of Wyoming text (<a href="https://weather.uwyo.edu/upperair/sounding.shtml" target="_blank" rel="noopener">weather.uwyo.edu</a>, “Text: List” — the whole page can be copied), SHARPpy, CM1 / WRF <code>input_sounding</code>, CSV with headers (pres, hght, temp, dwpt, drct, sknt…). Data up to 10 km at least are needed.')}</p>
  <div class="sounding-dialog__input"><button type="button" class="btn" id="soundingFileButton">${L('Выбрать файл…', 'Choose a file…')}</button><input type="file" id="soundingFile" accept=".txt,.csv,.dat,.sharppy,.oax,text/plain" hidden><span class="t-caption" id="soundingFileName"></span></div>
  <textarea class="input sounding-dialog__text" id="soundingText" spellcheck="false" placeholder="${L('…или вставьте текст зондирования сюда', '…or paste the sounding’s text here')}"></textarea>
  <div class="notice" id="soundingError" hidden></div>
  <div class="sounding-dialog__preview" id="soundingPreview" hidden>
    <div class="sounding-dialog__head"><b id="soundingName"></b><span class="t-caption" id="soundingInfo"></span></div>
    <div class="sounding-dialog__body"><canvas id="soundingChart" class="side-chart"></canvas><dl class="kv" id="soundingNums"></dl></div>
    <ul class="sounding-dialog__notes" id="soundingNotes"></ul>
    <div class="notice notice--warn" id="soundingCap" hidden><span class="notice__text"></span></div>
    <div class="notice notice--warn" id="soundingInversion" hidden><span class="notice__text"></span></div>
    <div class="field"><span class="field__label">${L('Запуск грозы', 'How the storm starts')}</span><span class="select"><select id="soundingStart"><option value="nudge">${L('Подталкивание потока, как в CM1 (Naylor & Gilmore 2012): 15–20 мин', 'Updraught nudging, as in CM1 (Naylor & Gilmore 2012): 15–20 min')}</option><option value="thermals">${L('Тёплый термик', 'A warm thermal')}</option></select></span></div>
    <label class="field"><span class="field__head"><span class="field__label">${L('Начальный термик (в реальном дне его нет — задайте сами; 0 — без термика)', 'Starting thermal (a real day has none — set it yourself; 0 — no thermal)')}</span><output class="field__value" id="soundingBubbleOut">1.00×</output></span><input class="range" id="soundingBubble" type="range" min="0" max="2.5" step="0.05" value="1"></label>
  </div>
  <div class="modal__actions"><button class="btn btn--quiet" value="cancel">${L('Отмена', 'Cancel')}</button><button class="btn btn--primary" value="run" id="soundingRun" disabled>${L('Запустить с этим зондированием', 'Run with this sounding')}</button></div>
</form></dialog>
<dialog class="modal" id="saveDialog"><form method="dialog" style="display:contents"><h2 class="modal__title">${L('Сохранить расчёт', 'Save the run')}</h2><p class="modal__text" id="saveText"></p><label class="field"><span class="label">${L('Имя файла', 'File name')}</span><input class="input" id="saveName" autocomplete="off" spellcheck="false"></label><div class="modal__actions"><button class="btn btn--quiet" value="cancel">${L('Отмена', 'Cancel')}</button><button class="btn btn--primary" value="save">${L('Сохранить', 'Save')}</button></div></form></dialog>`

const text = (id: string, value: string) => { document.querySelector(`#${id}`)!.textContent = value }
// The page opens on the first scenario ("Летний день"); the controls are synced to it below.
// The layout before the physics starts (its thread count depends on it): the remembered choice, else the screen's
// suggestion, with the question shown at the first visit.
applyLayout(savedLayout() ?? suggestedLayout(), false)
// Then, at the first visit, the offer of the guide.
if (!savedLayout()) askLayout(askGuide); else askGuide()
document.querySelector('#layoutToggle')!.addEventListener('click', () => applyLayout(isPhone() ? 'desktop' : 'phone'))
// Theme: Авто (the system's) / Светлая / Тёмная, in the header and in the phone's instruments menu.
const showThemeChoice = () => document.querySelectorAll<HTMLButtonElement>('[data-theme-set]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeSet === themeChoice())))
document.addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-theme-set]'); if (b) applyTheme(b.dataset.themeSet as ThemeChoice) })
addEventListener('themechange', showThemeChoice); showThemeChoice()
// The side charts redraw every 20 frames; a new theme, or a group opened, repaints them at once.
const drawCharts = () => { drawSounding(); drawHodograph(); drawSpin(); const { ctx, w, h } = prepareCanvas('timeline'); timeline.draw(ctx, w, h, compare.reference?.points) }
addEventListener('themechange', drawCharts)
// The right column's collapsible groups stay as they were left (localStorage), and draw their charts when opened.
const GROUPS_KEY = 'meteolab-groups'
{
  let open: Record<string, boolean> = {}
  try { open = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '{}') } catch { /* nothing remembered */ }
  document.querySelectorAll<HTMLDetailsElement>('details[data-group]').forEach(d => {
    const id = d.dataset.group!
    if (id in open) d.open = open[id]
    d.addEventListener('toggle', () => {
      open[id] = d.open
      try { localStorage.setItem(GROUPS_KEY, JSON.stringify(open)) } catch { /* private mode */ }
      if (d.open) drawCharts()
    })
  })
}
// The «i» hints (native popovers): placed beside their button, left of it in the right column.
document.querySelectorAll<HTMLElement>('.popover[popover]').forEach(pop => pop.addEventListener('toggle', e => {
  const button = document.querySelector<HTMLElement>(`[popovertarget="${pop.id}"]`), open = (e as ToggleEvent).newState === 'open'
  button?.setAttribute('aria-expanded', String(open))
  if (!open || !button) return
  const r = button.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight
  let left = r.left - w - 10, top = r.top - 12
  // On a phone (screen-wide) or wherever it does not fit on the left: under the button.
  if (isPhone()) { left = (innerWidth - w) / 2; top = r.bottom + 8 }
  // The menus over the 3D view (the view from the ground) and the top bar's open under their button.
  else if (pop.classList.contains('ground-menu') || pop.classList.contains('topmenu')) { left = Math.max(8, Math.min(r.left, innerWidth - w - 8)); top = r.bottom + 8 }
  else if (left < 8) { left = Math.max(8, Math.min(r.left, innerWidth - w - 8)); top = r.bottom + 8 }
  Object.assign(pop.style, { position: 'fixed', left: `${left}px`, top: `${Math.max(8, Math.min(top, innerHeight - h - 8))}px` })
}))
// The model's fields now as a CF NetCDF file (roadmap E2), with the version, the settings and the seed.
document.querySelector('#exportNetcdf')!.addEventListener('click', () => {
  const time = Math.round(sim.time)
  download(`meteolab-${config.seed}-t${time}s.nc`, modelNetCDF(sim.model, { version: MODEL_VERSION, seed: config.seed, scenario: document.querySelector('#scenarioName')!.textContent || '', config, link: stampLink() }), 'application/x-netcdf')
})
// The layers over the 3D view (one menu, it stays open while they are switched): how many are on, on its button.
const layersMenu = document.querySelector<HTMLElement>('#layersMenu')!
const countLayers = () => { text('layersCount', String(layersMenu.querySelectorAll('[aria-pressed="true"]').length)) }
new MutationObserver(countLayers).observe(layersMenu, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] })
countLayers()
// The top bar's menus (Опыт, Приборы, Эксперименты, Экспорт): an item closes its menu; one with data-tool presses that
// button (the run's own controls stay where they are).
document.querySelectorAll<HTMLElement>('.topmenu').forEach(menu => menu.addEventListener('click', e => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('.topmenu__item')
  if (!item) return
  menu.hidePopover()
  if (item.dataset.tool) document.querySelector<HTMLElement>(item.dataset.tool)!.click()
}))
// R, S, M open and close the instruments (not while typing, not with a modifier).
addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('input:not([type=range]):not([type=checkbox]), select, textarea, dialog')) return
  const target = ({ KeyR: '#radarOpen', KeyS: '#skewOpen', KeyM: '#stationOpen', KeyL: '#detectorOpen', KeyZ: '#zonesOpen', KeyA: '#analysisOpen', KeyI: '#satelliteOpen', KeyC: '#compareOpen', KeyE: '#ensembleOpen', KeyK: '#regimeOpen', KeyB: '#seriesOpen' } as Record<string, string>)[e.code]
  if (target) { e.preventDefault(); document.querySelector<HTMLButtonElement>(target)!.click() }
})
const config: SimConfig = { ...defaults, ...SCENARIOS[0].values }
// A shared link (?cfg=..., see share.ts) brings its scenario and settings; it is applied once and leaves the address.
let initialPreset: number | null = 0, baseScenario: number | null = 0
/** With a loaded sounding and no scenario: what the run started from (the sounding and its thermal), for markModified. */
let soundingBase: Partial<SimConfig> | null = null
{
  const url = new URL(location.href), shared = url.searchParams.get('cfg'), link = shared === null ? null : decodeSettings(shared, SCENARIOS.map(s => s.name))
  if (link) {
    Object.assign(config, defaults, link.scenario === null ? {} : SCENARIOS[link.scenario].values, link.values)
    baseScenario = link.scenario; initialPreset = Object.keys(link.values).length ? null : link.scenario
  }
  if (shared !== null) { url.searchParams.delete('cfg'); history.replaceState(null, '', url) }
  // A scenario card on the home page opens it by name (?scenario=...).
  const named = url.searchParams.get('scenario'), index = named === null ? -1 : SCENARIOS.findIndex(s => s.name === named)
  if (!link && index >= 0) { Object.assign(config, defaults, SCENARIOS[index].values); initialPreset = baseScenario = index }
  if (named !== null) { url.searchParams.delete('scenario'); history.replaceState(null, '', url) }
  // A link with a sounding: that is what the run started from.
  if (config.sounding && baseScenario === null) soundingBase = { sounding: config.sounding, start: config.start }
}
fillLowWind(config)
// Every start, restart and scenario gets a fresh random seed, so no two runs give the same storm. The seed is not shown,
// only kept in the address (?seed=...), so opening that link repeats the first run of the page.
const urlSeed = Number(new URLSearchParams(location.search).get('seed'))
const nextSeed = () => { const [x] = crypto.getRandomValues(new Uint32Array(1)); return x }
const useSeed = (seed: number) => { config.seed = seed; const url = new URL(location.href); url.searchParams.set('seed', String(seed)); history.replaceState(null, '', url) }
useSeed(Number.isInteger(urlSeed) && urlSeed > 0 ? urlSeed : nextSeed())
const canvas = document.querySelector<HTMLCanvasElement>('#sim')!
const view = { field: 'composite' as FieldMode, uhLayer: '2-5' as UhLayer, showVectors: false, showPrecip: false, showRainTotal: false, showMesocyclone: true, showFlanks: true, showLightning: true, layerMode: 'both' as LayerMode, volumeThreshold: .1, volumeDensity: 1, sliceHeight: 2, sliceNorth: 0 }
let sim = new Atmosphere(canvas, config)
// The picture's quality ('auto' or a level), kept in the browser; the view recreated with a restart keeps the level the
// automatic choice settled on.
const QUALITY_NAMES = { low: L('НИЗКОЕ', 'LOW'), medium: L('СРЕДНЕЕ', 'MEDIUM'), high: L('ВЫСОКОЕ', 'HIGH') } as const
const QUALITY_KEY = 'meteolab-quality'
let quality: Quality | 'auto' = (() => { try { const q = localStorage.getItem(QUALITY_KEY); return q === 'low' || q === 'medium' || q === 'high' ? q : 'auto' } catch { return 'auto' } })()
// When the automatic choice lowers the level, the badge says why for a few seconds.
const QUALITY_RANK = { low: 0, medium: 1, high: 2 } as const
let shownLevel: Quality | null = null, loweredUntil = 0
const showQuality = () => {
  const lowered = quality === 'auto' && shownLevel !== null && QUALITY_RANK[sim.level] < QUALITY_RANK[shownLevel]
  shownLevel = sim.level
  if (lowered) { loweredUntil = performance.now() + 3000; setTimeout(showQuality, 3050) }
  // On a phone the badge is not shown: the same words over the 3D view (hud.ts).
  const notice = document.querySelector<HTMLElement>('[data-hud="notice"]')
  if (notice) { notice.textContent = L('Качество снижено: кадры медленные', 'Quality lowered: slow frames'); notice.hidden = !(quality === 'auto' && performance.now() < loweredUntil) }
  document.querySelector('#qualityToggle')!.textContent = quality === 'auto' && performance.now() < loweredUntil ? `${L('КАЧЕСТВО СНИЖЕНО: КАДРЫ МЕДЛЕННЫЕ', 'QUALITY LOWERED: SLOW FRAMES')} · ${QUALITY_NAMES[sim.level]}`
    : quality === 'auto' ? `${L('КАЧЕСТВО: АВТО', 'QUALITY: AUTO')} · ${QUALITY_NAMES[sim.level]}` : `${L('КАЧЕСТВО', 'QUALITY')}: ${QUALITY_NAMES[quality]}`
  document.querySelectorAll<HTMLButtonElement>('[data-quality-set]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.qualitySet === quality)))
}
const chooseQuality = (q: Quality | 'auto') => {
  quality = q
  try { localStorage.setItem(QUALITY_KEY, quality) } catch { /* the choice lasts this visit */ }
  useQuality()
}
// The camera's settings (src/camera.ts): on the view only in the full screen, kept per viewer.
const cameraGrade = loadGrade()
const applyGrade = () => sim.setGrade(document.documentElement.classList.contains('immersive') ? cameraGrade : NEUTRAL_GRADE)
/** The parts of the 3D view by their shaders' names (view.ts, light.ts, lightning.ts, sprites.ts). */
const SHADER_PARTS: Record<string, string> = {
  cloudVolume: L('облака', 'the clouds'), sky: L('небо', 'the sky'), ground: L('земля', 'the ground'), precipitation: L('осадки', 'the precipitation'),
  fieldVolume: L('поля на 3D-виде', 'the fields in 3D'), fieldSlice: L('разрез поля', 'the field slice'), lightVolume: L('свет в облаке', 'the light in the cloud'),
  flashVolume: L('свечение вспышек', 'the flashes’ glow'), lightningChannels: L('каналы молний', 'the lightning channels'), sprite: L('спрайты', 'the sprites'),
}
document.querySelector('#glShaderClose')!.addEventListener('click', () => { document.querySelector<HTMLElement>('#glShader')!.hidden = true })
const useQuality = (start?: Quality) => {
  applyGrade()
  shownLevel = null; sim.onLevel = showQuality
  sim.onShaderError = (log, gpu, part) => {
    // Without the clouds the view has nothing to show: the whole view says so. Any other part (the sky, the rain, the
    // lightning…) is just left out, and a note at the bottom says which (a tester's Adreno 610, 22.10.2026).
    const whole = part === 'cloudVolume', name = SHADER_PARTS[part] ?? part, box = document.querySelector<HTMLElement>('#glShader')!
    document.querySelector('#glShaderText')!.innerHTML = whole
      ? L('<b>3D-вид не собрался на этой видеокарте</b> — расчёт и приборы работают. Пришлите, пожалуйста, снимок этого сообщения разработчику.', '<b>The 3D view could not be built on this GPU</b> — the run and the instruments work. Please send a screenshot of this message to the developer.')
      : L(`<b>Часть 3D-вида не собралась на этой видеокарте: ${name}.</b> Остальное работает; пришлите, пожалуйста, снимок разработчику.`, `<b>Part of the 3D view could not be built on this GPU: ${name}.</b> The rest works; please send a screenshot to the developer.`)
    document.querySelector('#glShaderLog')!.textContent = `${gpu} · ${part}\n${log.slice(0, 600)}`
    box.classList.toggle('gl-lost--note', !whole); document.querySelector<HTMLElement>('#glShaderClose')!.hidden = whole; box.hidden = false
  }
  sim.setQuality(quality, start); showQuality()
}
useQuality()
document.querySelector('#qualityToggle')!.addEventListener('click', () => { const order = ['auto', 'low', 'medium', 'high'] as const; chooseQuality(order[(order.indexOf(quality) + 1) % order.length]) })
// On a phone the choice is in the instruments' menu (hud.ts).
document.addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-quality-set]'); if (b) chooseQuality(b.dataset.qualitySet as Quality | 'auto') })
const radar = new RadarPanel(document.body); radar.attach(sim.model, sim.storm.rightMover)
document.querySelector('#radarOpen')!.addEventListener('click', () => radar.toggle())
const skewt = new SkewTPanel(document.body); skewt.attach(sim.model)
const station = new StationPanel(document.body)
/** The next click on the 3D view places a weather station; their ground positions survive restarts. */
let placingStation = false, stationGrounds: ({ x: number; y: number } | null)[] = []
station.onAdd = () => { placingStation = true }
station.seed = () => config.seed
station.onRemove = index => { placingStation = false; stationGrounds = index === 'all' ? [] : stationGrounds.map((g, k) => k === index ? null : g); while (stationGrounds.length && !stationGrounds[stationGrounds.length - 1]) stationGrounds.pop(); sim.placeStations(stationGrounds) }
document.querySelector('#stationOpen')!.addEventListener('click', () => station.toggle())
const detector = new DetectorPanel(document.body)
const zonesPanel = new ZonesPanel(document.body)
document.querySelector('#zonesOpen')!.addEventListener('click', () => zonesPanel.toggle())
document.querySelector('#detectorOpen')!.addEventListener('click', () => detector.toggle())
const analysis = new AnalysisPanel(document.body)
document.querySelector('#analysisOpen')!.addEventListener('click', () => analysis.toggle())
const satellite = new SatellitePanel(document.body)
document.querySelector('#satelliteOpen')!.addEventListener('click', () => satellite.toggle())
// Comparing two runs (2.9): the remembered run A beside the one going on; the echo maps of the run going on are kept for it.
const compare = new ComparePanel(document.body), echoMaps = new EchoMaps()
document.querySelector('#compareOpen')!.addEventListener('click', () => compare.toggle())
compare.onChange = () => drawCharts()
compare.onReseed = seed => { recreate(seed); running = true; updatePause() }
// The ensemble (2.9): the current settings with many seeds in workers of its own; the live run pauses meanwhile.
const ensemble = new EnsemblePanel(document.body)
document.querySelector('#ensembleOpen')!.addEventListener('click', () => ensemble.toggle())
ensemble.current = () => ({ config, name: document.querySelector('#scenarioName')!.textContent || '' })
// The ensemble and the regime map pause the live run while their runs take the cores, and resume it after.
let ranBefore = false
const pauseFor = (on: boolean) => { if (on) { ranBefore = running; running = false } else running = ranBefore; updatePause() }
ensemble.onRunning = pauseFor
// The regime map (2.9): the run going on over a grid of moisture and shear, in the ensemble's workers.
const regime = new RegimePanel(document.body)
document.querySelector('#regimeOpen')!.addEventListener('click', () => regime.toggle())
regime.current = ensemble.current
regime.onRunning = pauseFor
// Batch series (E3): runs from a series file in the ensemble's workers; its file starts from the settings going on.
const series = new SeriesPanel(document.body)
document.querySelector('#seriesOpen')!.addEventListener('click', () => series.toggle())
series.scenarios = () => SCENARIOS.map(s => s.name)
series.onRunning = pauseFor
series.template = () => {
  const name = baseScenario === null ? null : SCENARIOS[baseScenario].name, linkBase: SimConfig = { ...defaults, ...(baseScenario === null ? {} : SCENARIOS[baseScenario].values) }; fillLowWind(linkBase)
  const values = decodeSettings(encodeSettings(config, linkBase, name), SCENARIOS.map(s => s.name))?.values ?? {}
  return seriesTemplate(document.querySelector('#scenarioName')!.textContent || '', name, values, config.seed)
}
series.base = seriesBase
regime.onApply = c => { Object.assign(config, c); syncControls(); markPreset(null); recreate(config.seed); running = true; updatePause(); drawHodograph() }
document.querySelector('#skewOpen')!.addEventListener('click', () => skewt.toggle())
let running = true
let last = performance.now(), frameCount = 0
const recreate = (seed?: number) => { endReplay(); useSeed(seed ?? compare.seed ?? nextSeed()); const level = sim.level; sim.dispose(); sim = Object.assign(new Atmosphere(canvas, config), view); useQuality(level); if (groundToggle.getAttribute('aria-pressed') === 'true') sim.standSuggested(OBSERVER_BACK); radar.attach(sim.model, sim.storm.rightMover); skewt.attach(sim.model); sim.placeStations(stationGrounds); selectCell(null); showDomain() }
// Zones of the environment (2.4): applied from their screen, the run starts again with them.
zonesPanel.onApply = (zones, front) => { config.zones = zones.length ? zones : undefined; config.frontLine = front ?? undefined; recreate(); markModified() }
// Large-scale advection (2.6): changed in the left column, the run starts again with it.
const advection = new AdvectionEditor()
advection.onChange = changes => { config.largeScale = changes.length ? changes : undefined; recreate(); advection.show(config); markModified() }

const surfaceSelect = document.querySelector<HTMLSelectElement>('#surfaceType')!
const transportSelect = document.querySelector<HTMLSelectElement>('#transport')!
transportSelect.addEventListener('change', () => { config.transport = transportSelect.value as SimConfig['transport'] })
const followCheck = document.querySelector<HTMLInputElement>('#followStorm')!, domainSelect = document.querySelector<HTMLSelectElement>('#domain')!
followCheck.addEventListener('change', () => { config.followStorm = followCheck.checked; recreate() })
const lightningCheck = document.querySelector<HTMLInputElement>('#lightning')!
lightningCheck.addEventListener('change', () => { config.lightning = lightningCheck.checked; recreate() })
domainSelect.addEventListener('change', () => { config.domain = domainSelect.value as SimConfig['domain']; if (config.domain === 'custom') config.domainSize ??= [48, 36]; showDomainControls(); recreate() })
// The domain's own size (domain 'custom'): two sliders, the run restarts when one is let go.
const domainWidth = document.querySelector<HTMLInputElement>('#domainWidth')!, domainDepth = document.querySelector<HTMLInputElement>('#domainDepth')!
function showDomainControls() {
  const custom = config.domain === 'custom', [w, d] = config.domain === 'large' ? [96, 72] : custom ? config.domainSize ?? [48, 36] : [48, 36]
  ;(document.querySelector('#domainCustom') as HTMLElement).hidden = !custom
  domainWidth.value = String(w); domainDepth.value = String(d); fillRange(domainWidth); fillRange(domainDepth)
  text('domainWidthOut', `${w}${KM}`); text('domainDepthOut', `${d}${KM}`)
  ;(document.querySelector('#domainWarn') as HTMLElement).hidden = w * d <= 96 * 72
}
for (const input of [domainWidth, domainDepth]) {
  input.addEventListener('input', () => { fillRange(input); text(`${input.id}Out`, `${input.value}${KM}`); (document.querySelector('#domainWarn') as HTMLElement).hidden = Number(domainWidth.value) * Number(domainDepth.value) <= 96 * 72 })
  input.addEventListener('change', () => { config.domainSize = [Number(domainWidth.value), Number(domainDepth.value)]; recreate() })
}
const microSelect = document.querySelector<HTMLSelectElement>('#microphysics')!
microSelect.addEventListener('change', () => { config.microphysics = microSelect.value as SimConfig['microphysics']; markPreset(null); recreate() })
// Sliders: the value with its unit beside the label, the track filled up to the thumb (--p), the value in the accent
// colour while the thumb is held.
const fillRange = (input: HTMLInputElement) => input.style.setProperty('--p', `${(Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`)
const showOutput = (input: HTMLInputElement) => {
  const out = document.querySelector<HTMLOutputElement>(`[data-output="${input.dataset.key}"]`)!
  out.innerHTML = `${Number(input.value).toFixed(Number(input.dataset.digits))}<span class="u">${input.dataset.unit}</span>`
  fillRange(input)
}
document.querySelectorAll<HTMLInputElement>('input.range').forEach(input => {
  const field = input.closest('.field')!, release = () => field.classList.remove('is-dragging')
  input.addEventListener('input', () => fillRange(input))
  input.addEventListener('pointerdown', () => field.classList.add('is-dragging'))
  input.addEventListener('pointerup', release); input.addEventListener('pointercancel', release); input.addEventListener('blur', release)
  fillRange(input)
})
// With an analytic profile (the Weisman-Klemp scenario) the temperature, humidity and wind sliders do nothing: dim them.
const markProfileGroups = () => {
  const off = !!config.profile || !!config.sounding
  document.querySelectorAll<HTMLDetailsElement>('details[data-profile]').forEach(d => { d.classList.toggle('is-inactive', off); const tag = d.querySelector<HTMLElement>('.group__tag')!; tag.hidden = !off; tag.textContent = config.sounding ? L('зондирование', 'sounding') : L('формулы WK', 'WK formulas') })
  const locked = document.querySelector<HTMLElement>('#profileLocked')!
  locked.hidden = !off
  locked.textContent = config.sounding ? L('Профиль взят из зондирования — ползунки температуры, влажности и ветра не действуют. Вернуться к ползункам — выберите сценарий.', 'The profile comes from the sounding — the temperature, humidity and wind sliders have no effect. To go back to the sliders, choose a scenario.') : L('Профиль задан формулами — ползунки температуры, влажности и ветра не действуют.', 'The profile is set by formulas — the temperature, humidity and wind sliders have no effect.')
}
/** The scenario the settings started from (null: a run opened from a file), as a full config. */
const baseConfig = (): SimConfig => { const base: SimConfig = { ...defaults, ...(baseScenario === null ? built?.values ?? soundingBase ?? {} : SCENARIOS[baseScenario].values) }; fillLowWind(base); return base }
// A dot at a left group whose values differ from the scenario. Speed, the domain and its motion are kept when a
// scenario is chosen: not the scenario's.
const KEPT = new Set<keyof SimConfig>(['speed', 'followStorm', 'domain', 'domainSize', 'lightning'])
const SELECTS: [string, keyof SimConfig, string][] = [['#surfaceType', 'surfaceType', 'grass'], ['#transport', 'transport', 'weno'], ['#microphysics', 'microphysics', 'ice']]
function markModified() {
  const base = baseConfig()
  document.querySelectorAll<HTMLDetailsElement>('.side--left details.group').forEach(d => {
    const sliders = [...d.querySelectorAll<HTMLInputElement>('input[data-key]')].some(input => {
      const key = input.dataset.key as keyof SimConfig
      return !KEPT.has(key) && Math.abs(Number(config[key]) - Number(base[key])) > Number(input.step) / 2
    })
    const selects = SELECTS.some(([selector, key, fallback]) => d.querySelector(selector) && (config[key] ?? fallback) !== (base[key] ?? fallback))
    const advected = !!d.querySelector('#advList') && JSON.stringify(config.largeScale ?? []) !== JSON.stringify(base.largeScale ?? [])
    d.classList.toggle('is-modified', sliders || selects || advected)
  })
}
// The note under the scenario buttons: what the scenario shows, cut to four lines until «Подробнее».
const scenarioNote = document.querySelector<HTMLElement>('#scenarioNote')!, scenarioMore = document.querySelector<HTMLButtonElement>('#scenarioMore')!
scenarioMore.addEventListener('click', () => { const open = scenarioNote.classList.toggle('is-open'); scenarioMore.textContent = open ? L('Свернуть', 'Less') : L('Подробнее', 'More') })
function showScenario() {
  const p = baseScenario === null ? built : presets[baseScenario], s = config.sounding
  text('scenarioName', p ? p.title : s ? `${L('Зондирование', 'Sounding')}: ${s.name || L('без названия', 'untitled')}` : L('Расчёт из файла', 'Run from a file'))
  text('scenarioText', p ? `${p.hint.replace(/.$/, '')}.` : s ? L(`Температура, влажность и ветер — из реального зондирования (${s.levels.length} уровней до ${(s.levels[s.levels.length - 1].z / 1000).toFixed(1)} км над станцией). Термик, солнце, поверхность и расчёт — ползунками.`, `Temperature, humidity and wind come from a real sounding (${s.levels.length} levels up to ${(s.levels[s.levels.length - 1].z / 1000).toFixed(1)} km above the station). The thermal, the sun, the surface and the computation — by the sliders.`) : L('Настройки взяты из сохранённого файла и ни с одним сценарием не сравниваются.', 'The settings come from a saved file and are compared with no scenario.'))
  showStory(p?.story ?? null)
  scenarioNote.classList.remove('is-open'); scenarioMore.textContent = L('Подробнее', 'More')
  // «Подробнее» only when the text is cut.
  requestAnimationFrame(() => { const t = document.querySelector<HTMLElement>('#scenarioText')!; scenarioMore.hidden = t.scrollHeight <= t.clientHeight + 1 })
}
const markPreset = (index: number | null) => { document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.preset) === index))); markModified() }
document.querySelectorAll<HTMLInputElement>('input[data-key]').forEach(input => {
  const key = input.dataset.key as keyof SimConfig
  input.addEventListener('input', () => {
    ;(config[key] as number|string) = Number(input.value)
    showOutput(input)
    showEnvironment()
  })
  input.addEventListener('change', () => { if (resetKeys.has(key)) { markPreset(null); recreate(); advection.show(config) } else markModified() })
})
surfaceSelect.addEventListener('change', () => {
  config.surfaceType = surfaceSelect.value as SimConfig['surfaceType']
  markPreset(null)
  recreate()
})
/** The story of the situation shown (null: none) and its stage now, marked as the run goes. */
let story: StoryStage[] | null = null, storyNow = -2
function showStory(s: StoryStage[] | null) {
  story = s; storyNow = -2
  const list = document.querySelector<HTMLElement>('#story')!
  list.hidden = !s
  if (s) list.innerHTML = s.map(([h, t]) => `<li><span class="story__time">${timeOfDay(config.hour, h * 3600)}</span><span>${t}</span></li>`).join('')
  markStory()
}
function markStory() {
  if (!story) return
  const now = storyStage(story, sim.time)
  if (now === storyNow) return
  storyNow = now
  document.querySelectorAll('#story li').forEach((li, k) => { li.classList.toggle('is-now', k === now); li.classList.toggle('is-past', k < now) })
}
/** The story's stage now as one line (the phone shows it over the view), '' without a story or before its first stage. */
function storyText() {
  if (!story) return ''
  const k = storyStage(story, sim.time)
  return k < 0 ? '' : `${timeOfDay(config.hour, story[k][0] * 3600)} · ${story[k][1]}`
}
// A situation assembled from the choices (situations.ts): run like a scenario, but its own.
let built: { name: string; title: string; hint: string; nums: string; story: StoryStage[]; values: Partial<SimConfig> } | null = null
document.querySelector('#sitBuild')!.addEventListener('click', () => {
  const pick = (id: string) => document.querySelector<HTMLSelectElement>(`#${id}`)!.value
  const b = buildSituation({ mass: pick('sitMass') as keyof typeof AIR_MASSES, trigger: pick('sitTrigger') as keyof typeof TRIGGERS, shear: pick('sitShear') as keyof typeof SHEARS, hour: Number(pick('sitHour')) }, defaults)
  Object.assign(config, defaults, { speed: config.speed, followStorm: config.followStorm, lightning: config.lightning, domain: config.domain, domainSize: config.domainSize, wind05: undefined, wind1: undefined, windDir05: undefined, windDir1: undefined, profile: undefined, weismanKlemp: undefined, sounding: undefined, bubbleRadius: undefined, front: undefined, edges: undefined, start: undefined, nudge: undefined, frameMotion: undefined, top: undefined, spacing: undefined, nightInversion: undefined, zones: undefined, frontLine: undefined, largeScale: undefined, transport: 'weno' }, b.values)
  fillLowWind(config)
  built = { ...b, title: b.name, nums: environmentNums(config) }; baseScenario = null; soundingBase = null
  syncControls(); markPreset(null); showScenario()
  recreate(); running = true; updatePause()
})
document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => button.addEventListener('click', () => {
  const index = Number(button.dataset.preset)
  built = null
  Object.assign(config, defaults, { speed: config.speed, followStorm: config.followStorm, lightning: config.lightning, domain: config.domain, domainSize: config.domainSize, wind05: undefined, wind1: undefined, windDir05: undefined, windDir1: undefined, profile: undefined, weismanKlemp: undefined, sounding: undefined, bubbleRadius: undefined, front: undefined, edges: undefined, start: undefined, nudge: undefined, frameMotion: undefined, top: undefined, spacing: undefined, nightInversion: undefined, zones: undefined, frontLine: undefined, largeScale: undefined, transport: 'weno' }, presets[index].values)
  fillLowWind(config)
  baseScenario = index
  syncControls()
  markPreset(index); showScenario()
  recreate(); running = true; updatePause()
}))
function syncControls() {
  document.querySelectorAll<HTMLInputElement>('input[data-key]').forEach(input => {
    input.value = String(config[input.dataset.key as keyof SimConfig])
    showOutput(input)
  })
  surfaceSelect.value = config.surfaceType
  transportSelect.value = config.transport ?? 'weno'
  microSelect.value = config.microphysics ?? 'ice'
  followCheck.checked = config.followStorm !== false; lightningCheck.checked = config.lightning !== false; domainSelect.value = config.domain ?? 'standard'; showDomainControls()
  advection.show(config); markProfileGroups(); markModified(); showSimple()
}
// «Основные параметры» (2.9): a few knobs, each a change of the whole profile (src/settings/simple.ts).
const KNOBS = {
  simpleHeat: { show: (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${decimal(Math.abs(v), 1)} K`, apply: (c: SimConfig, v: number) => withHeat(c, v - (heatOf(c, baseConfig()) ?? 0)) },
  simpleMoisture: { show: (v: number) => `×${decimal(v, 2)}`, apply: (c: SimConfig, v: number) => withMoisture(c, v / moistureOf(c, baseConfig())) },
  simpleShear: { show: (v: number) => `${Math.round(v)}${MS}`, apply: (c: SimConfig, v: number) => withShear(c, v) },
  // Turning the low wind moves the 0-6 km difference too: the shear is set back as it was.
  simpleTurn: { show: (v: number) => `${Math.round(v)}°`, apply: (c: SimConfig, v: number) => withShear(withTurn(c, v), environmentOf(c).shear) },
} as const
type Knob = keyof typeof KNOBS
const knobInput = (id: Knob) => document.querySelector<HTMLInputElement>(`#${id}`)!
const showKnob = (id: Knob) => { const input = knobInput(id); document.querySelector(`#${id}Out`)!.textContent = KNOBS[id].show(Number(input.value)); fillRange(input) }
/** The knobs read from the settings as they are (the heat and the moisture as changes from the scenario). */
/** The starting environment's numbers (the always-visible summary), once a frame at most while a slider moves. */
let envFrame = 0
function showEnvironment() {
  if (envFrame) return
  envFrame = requestAnimationFrame(() => {
    envFrame = 0
    const grid = createGrid(), env = new Environment(config, grid, environmentProfile(config, grid.height)), p = parcelIndices(env, grid.height), k = stormIndices(env, p)
    const n = (v: number) => String(Math.round(v)).replace('-', '−'), km = (v: number | null) => v === null ? '—' : `${decimal(v, 2)} ${L('км', 'km')}`
    document.querySelector('#envSummary')!.innerHTML = ([
      ['ML CAPE', `${n(p.ml.cape)} ${JKG}`], ['ML CIN', `${n(p.ml.cin)} ${JKG}`], ['LCL', km(p.ml.lcl)], ['LFC', km(p.ml.lfc)],
      [L('Сдвиг 0–6 км', 'Shear 0–6 km'), `${n(k.shear06)}${MS}`], ['DCAPE', `${n(p.dcape)} ${JKG}`], ['SRH 0–1 км', `${n(k.srh01)} ${L('м²/с²', 'm²/s²')}`], ['SRH 0–3 км', `${n(k.srh03)} ${L('м²/с²', 'm²/s²')}`],
    ] as const).map(([a, b]) => `<div><dt>${a.replace(' км', L(' км', ' km'))}</dt><dd>${b}</dd></div>`).join('')
  })
}
function showSimple() {
  const base = baseConfig(), heat = heatOf(config, base), turn = turnOf(config), env = environmentOf(config)
  const set = (id: Knob, v: number | null) => { const input = knobInput(id); input.disabled = v === null; input.value = String(v ?? 0); showKnob(id) }
  set('simpleHeat', heat); set('simpleMoisture', moistureOf(config, base)); set('simpleShear', env.shear); set('simpleTurn', turn)
  showEnvironment()
  const note = document.querySelector<HTMLElement>('#simpleNote')!
  note.hidden = heat !== null && turn !== null
  note.textContent = config.profile ? L('Профиль задан формулами Weisman–Klemp: жары и поворота у них нет, влажность и сдвиг меняются.', 'The profile is set by the Weisman–Klemp formulas: they have no heat and no turning; the moisture and the shear change.')
    : L('Ветер — из зондирования: его поворот не меняется, сила сдвига — меняется.', 'The wind comes from the sounding: its turning stays, the shear’s strength changes.')
}
for (const id of Object.keys(KNOBS) as Knob[]) {
  knobInput(id).addEventListener('input', () => showKnob(id))
  knobInput(id).addEventListener('change', () => { Object.assign(config, KNOBS[id].apply(config, Number(knobInput(id).value))); markPreset(null); recreate(); syncControls(); drawHodograph() })
}
syncControls()
markPreset(initialPreset); showScenario()
document.querySelector('#restart')!.addEventListener('click', () => { recreate(); running = true; updatePause() })
// A short notice under the actions: gone after 4 s, or at once with «×».
const stateNote = document.querySelector<HTMLElement>('#stateNote')!, stateFile = document.querySelector<HTMLInputElement>('#stateFile')!
let noteTimer = 0
const note = (message: string, ok = false) => {
  stateNote.querySelector('.notice__text')!.textContent = message; stateNote.classList.toggle('notice--ok', ok); stateNote.hidden = false
  clearTimeout(noteTimer); noteTimer = window.setTimeout(() => { stateNote.hidden = true }, 4000)
}
stateNote.querySelector('.notice__close')!.addEventListener('click', () => { clearTimeout(noteTimer); stateNote.hidden = true })
// The link to this run: the settings that differ from the scenario (or the defaults) and the run's seed.
/** The link to this run: its settings relative to the scenario last chosen (changed sliders unmark it but it is still the starting point). */
const runLink = (c = config) => {
  const url = new URL(location.href)
  // The base a link is read against: the defaults and the scenario (not the loaded sounding — the link must carry it).
  const linkBase: SimConfig = { ...defaults, ...(baseScenario === null ? {} : SCENARIOS[baseScenario].values) }; fillLowWind(linkBase)
  url.searchParams.set('cfg', encodeSettings(c, linkBase, baseScenario === null ? null : SCENARIOS[baseScenario].name)); url.searchParams.set('seed', String(c.seed))
  return url
}
// Every export carries this link with the model's version (src/export/stamp.ts).
setRunLink(c => runLink(c).href)
document.querySelector('#share')!.addEventListener('click', () => {
  const url = runLink()
  navigator.clipboard.writeText(url.href).then(() => note(L('Ссылка на опыт скопирована', 'Link to the run copied'), true), () => { history.replaceState(null, '', url); note(L('Ссылка на опыт — в адресной строке', 'The link to the run is in the address bar')) })
})
// Saving and opening a run (.meteolab, src/core/state.ts). The state is taken when «Сохранить» is pressed; the dialog
// only names the file. The file's settings are outside input: only the known ones are read back.
const saveDialog = document.querySelector<HTMLDialogElement>('#saveDialog')!, saveName = document.querySelector<HTMLInputElement>('#saveName')!
let saved: { data: ArrayBuffer; time: number } | null = null
document.querySelector('#saveState')!.addEventListener('click', () => {
  saved = { data: sim.saveState(), time: sim.time }
  const name = baseScenario === null ? 'MeteoLab' : SCENARIOS[baseScenario].title
  const mb = Math.max(1, Math.round(saved.data.byteLength / 2 ** 20))
  text('saveText', L(`Файл .meteolab (~${mb} МБ): все поля модели на T+${runTime(saved.time)} и настройки — расчёт продолжится с того же места через «Открыть…». Имя уже подставлено, менять не обязательно.`, `A .meteolab file (~${mb} MB): all the model’s fields at T+${runTime(saved.time)} and the settings — the run continues from the same point via “Open…”. The name is filled in, no need to change it.`))
  saveName.value = `${name}${baseScenario !== null && markedModified() ? L(' (изменён)', ' (modified)') : ''}, T+${Math.floor(saved.time / 60)}.meteolab`
  saveDialog.showModal(); saveName.select()
})
const markedModified = () => !!document.querySelector('.side--left details.is-modified')
saveDialog.addEventListener('close', () => {
  if (saveDialog.returnValue === 'save' && saved) {
    const name = (saveName.value.trim() || 'meteolab').replace(/[\\/:*?"<>|]/g, '-'), file = name.endsWith('.meteolab') ? name : `${name}.meteolab`
    const url = URL.createObjectURL(new Blob([saved.data], { type: 'application/octet-stream' })), a = document.createElement('a')
    a.href = url; a.download = file; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    note(L(`Сохранено: ${Math.floor(saved.time / 60)}-я минута расчёта`, `Saved: minute ${Math.floor(saved.time / 60)} of the run`), true)
  }
  saved = null; saveDialog.returnValue = ''
})
document.querySelector('#loadState')!.addEventListener('click', () => stateFile.click())
// A real sounding (roadmap 2.2): a file or pasted text, read and checked at once (soundingfile.ts), its profile and
// numbers shown before the run; «Запустить» starts a run in it, like a scenario: the other settings back to the
// defaults (speed, domain and its motion kept), the thermal as chosen here.
const soundingDialog = document.querySelector<HTMLDialogElement>('#soundingDialog')!, soundingText = document.querySelector<HTMLTextAreaElement>('#soundingText')!
const soundingFile = document.querySelector<HTMLInputElement>('#soundingFile')!, soundingBubble = document.querySelector<HTMLInputElement>('#soundingBubble')!
// The nudging starts a storm through a cap; the thermal's strength matters only for the thermal.
const soundingStart = document.querySelector<HTMLSelectElement>('#soundingStart')!
const showSoundingStart = () => { soundingBubble.closest<HTMLElement>('.field')!.hidden = soundingStart.value !== 'thermals' }
soundingStart.addEventListener('change', showSoundingStart); showSoundingStart()
let loadedSounding: NonNullable<SimConfig['sounding']> | null = null
document.querySelector('#soundingOpen')!.addEventListener('click', () => { soundingDialog.showModal(); if (loadedSounding) requestAnimationFrame(() => previewSounding()) })
document.querySelector('#soundingFileButton')!.addEventListener('click', () => soundingFile.click())
soundingFile.addEventListener('change', async () => {
  const file = soundingFile.files?.[0]; soundingFile.value = ''
  if (!file) return
  text('soundingFileName', file.name); soundingText.value = await file.text(); readSounding(file.name.replace(/.[^.]+$/, ''))
})
let soundingTimer = 0
soundingText.addEventListener('input', () => { clearTimeout(soundingTimer); soundingTimer = window.setTimeout(() => { text('soundingFileName', ''); readSounding() }, 300) })
soundingBubble.addEventListener('input', () => { text('soundingBubbleOut', `${Number(soundingBubble.value).toFixed(2)}×`); fillRange(soundingBubble) })
function readSounding(fallbackName = '') {
  const error = document.querySelector<HTMLElement>('#soundingError')!, run = document.querySelector<HTMLButtonElement>('#soundingRun')!
  loadedSounding = null; run.disabled = true; error.hidden = true; document.querySelector<HTMLElement>('#soundingPreview')!.hidden = true
  if (!soundingText.value.trim()) return
  try {
    const file = parseSounding(soundingText.value), grid = createGrid(), sp = soundingProfile(file, grid.height + 2000)
    loadedSounding = { name: [file.station, file.time].filter(Boolean).join(' · ') || fallbackName, levels: file.levels }
    soundingNotes = [...file.notes, ...sp.notes]; soundingLatitude = file.latitude
    run.disabled = false; previewSounding()
  } catch (e) {
    error.textContent = e instanceof SoundingError ? e.message : `${L('Не удалось прочитать', 'Could not read it')}: ${(e as Error).message}`; error.hidden = false
  }
}
let soundingNotes: string[] = [], soundingLatitude: number | undefined
function previewSounding() {
  const s = loadedSounding!, c: SimConfig = { ...defaults, sounding: s }, grid = createGrid(), env = new Environment(c, grid, environmentProfile(c, grid.height))
  const i = parcelIndices(env, grid.height), k = stormIndices(env, i), top = s.levels[s.levels.length - 1].z
  document.querySelector<HTMLElement>('#soundingPreview')!.hidden = false
  text('soundingName', s.name || L('Зондирование', 'Sounding'))
  text('soundingInfo', L(`${s.levels.length} уровней · до ${(top / 1000).toFixed(1)} км над станцией · у земли ${(s.levels[0].p / 100).toFixed(0)} гПа`, `${s.levels.length} levels · up to ${(top / 1000).toFixed(1)} km above the station · ${(s.levels[0].p / 100).toFixed(0)} hPa at the ground`) + (soundingLatitude !== undefined ? ` · ${L('широта', 'latitude')} ${soundingLatitude.toFixed(1)}°` : ''))
  const n = (v: number) => String(Math.round(v)).replace('-', '−'), km = (v: number | null) => v === null ? '—' : `${v.toFixed(1)}${KM}`
  document.querySelector('#soundingNums')!.innerHTML = ([['SB CAPE / CIN', `${n(i.sb.cape)} / ${n(i.sb.cin)} ${JKG}`], ['ML CAPE / CIN', `${n(i.ml.cape)} / ${n(i.ml.cin)} ${JKG}`], ['MU CAPE', `${n(i.mu.cape)} ${JKG}`], ['LCL / LFC', `${km(i.ml.lcl)} / ${km(i.ml.lfc)}`], [L('Сдвиг 0–6 км', 'Shear 0–6 km'), `${Math.round(k.shear06)}${MS}`], [L('SRH 0–1 / 0–3 км', 'SRH 0–1 / 0–3 km'), `${n(k.srh01)} / ${n(k.srh03)} ${L('м²/с²', 'm²/s²')}`], [L('Эфф. слой · SRH · сдвиг', 'Eff. layer · SRH · shear'), k.effective ? `${(k.effective.base / 1000).toFixed(1)}–${(k.effective.top / 1000).toFixed(1)} ${L('км', 'km')} · ${k.effective.srh.toFixed(0)} · ${k.effective.shear.toFixed(0)} ${L('м/с', 'm/s')}` : L('нет', 'none')], ['SCP / STP / SHIP / DCP', `${k.scp.toFixed(1)} / ${k.stp.toFixed(1)} / ${k.ship.toFixed(1)} / ${k.dcp.toFixed(1)}`]] as const).map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')
  // A cap a warm thermal cannot break on this grid: the mixed-layer parcel's CIN, or a free convection level high up.
  const cap = document.querySelector<HTMLElement>('#soundingCap')!, lfc = i.ml.lfc ?? Infinity
  cap.hidden = !(i.ml.cin > CAP_CIN || (i.ml.cape > 100 && lfc > CAP_LFC))
  cap.querySelector('.notice__text')!.textContent = L(
    `Крышка: для частицы смешанного слоя CIN ${n(i.ml.cin)} Дж/кг, свободная конвекция с ${km(i.ml.lfc)}. CAPE у земли считается для самых нижних метров; термик перемешивает слой, и тёплый пузырь на сетке 1,2 км такую крышку не пробивает — в природе это делают фронт или граница оттока. Запуск подталкиванием потока её продавливает${i.ml.cin > 120 ? ' (при CIN больше ~120 Дж/кг так в природе без сильного подъёма не бывает — это опыт «что если»)' : ''}.`,
    `A cap: for the mixed-layer parcel CIN ${n(i.ml.cin)} J/kg, free convection from ${km(i.ml.lfc)}. The surface CAPE is the lowest metres'; a thermal mixes the layer, and a warm bubble on the 1.2 km grid does not break such a cap — in nature a front or an outflow boundary does. The updraught nudging forces it through${i.ml.cin > 120 ? ' (with CIN above ~120 J/kg nature would need strong lifting — this is a what-if experiment)' : ''}.`)
  // A second inversion inside the cloud: the mixed-layer parcel, free from its LFC, colder than the air again below
  // INVERSION_TOP. CIN counts only what lies below the LFC (MetPy's convention), so CIN near 0 can hide it.
  const inv = document.querySelector<HTMLElement>('#soundingInversion')!, low = inCloudInversion(env, grid.height)
  inv.hidden = !low
  if (low) inv.querySelector('.notice__text')!.textContent = L(
    `Вторая инверсия внутри облака: частица смешанного слоя свободна с ${km(i.ml.lfc)}, но на ${km(low.z)} снова холоднее среды на ${low.excess.toFixed(1).replace('.', ',')} K. CIN её не учитывает — он считается только ниже LFC, поэтому может быть почти нулевым. Молодой восходящий поток тормозится в этом слое и вовлекает сухой воздух; тёплый термик обычно гаснет, подталкивание проводит поток только пока действует (15–20 мин).`,
    `A second inversion inside the cloud: the mixed-layer parcel is free from ${km(i.ml.lfc)}, but at ${km(low.z)} it is colder than the air again, by ${low.excess.toFixed(1)} K. CIN does not count it — it is integrated only below the LFC, so it can be near zero. A young updraught slows in this layer and entrains dry air; a warm thermal usually dies, the nudging carries the updraught only while it acts (15–20 min).`)
  document.querySelector('#soundingNotes')!.innerHTML = soundingNotes.map(t => `<li>${t.replace(/[<>&]/g, ch => `&#${ch.charCodeAt(0)};`)}</li>`).join('')
  drawSounding('soundingChart', computeSounding(c, env, grid.height))
}
soundingDialog.addEventListener('close', () => {
  if (soundingDialog.returnValue !== 'run' || !loadedSounding) { soundingDialog.returnValue = ''; return }
  soundingDialog.returnValue = ''
  Object.assign(config, defaults, { speed: config.speed, followStorm: config.followStorm, lightning: config.lightning, domain: config.domain, domainSize: config.domainSize, wind05: undefined, wind1: undefined, windDir05: undefined, windDir1: undefined, profile: undefined, weismanKlemp: undefined, bubbleRadius: undefined, front: undefined, edges: undefined, start: undefined, nudge: undefined, frameMotion: undefined, top: undefined, spacing: undefined, nightInversion: undefined, zones: undefined, frontLine: undefined, largeScale: undefined, transport: 'weno' },
    { sounding: loadedSounding, bubble: Number(soundingBubble.value), ...(soundingStart.value === 'nudge' ? { start: 'nudge' as const } : {}), ...(soundingLatitude !== undefined ? { latitude: Math.round(Math.abs(soundingLatitude)) } : {}) })
  fillLowWind(config)
  baseScenario = null; built = null; soundingBase = { sounding: config.sounding, bubble: config.bubble, latitude: config.latitude, start: config.start }
  syncControls(); markPreset(null); showScenario()
  recreate(); running = true; updatePause()
  dispatchEvent(new Event('closesheet'))
  note(L(`Запущено в зондировании «${loadedSounding.name || 'без названия'}»`, `Running in the sounding “${loadedSounding.name || 'untitled'}”`), true)
})

// Rewind: the points the Atmosphere keeps, refreshed when their number changes.
const rewindSelect = document.querySelector<HTMLSelectElement>('#rewind')!
let rewindKey = ''
const listRewind = () => {
  const key = sim.history.map(h => h.time).join(',')
  if (key === rewindKey) return
  rewindKey = key
  rewindSelect.innerHTML = `<option value="">${L('Вернуться к минуте…', 'Go back to minute…')}</option>` + sim.history.map(h => `<option value="${h.time}">${L(`${Math.floor(h.time / 60)}-я минута`, `minute ${Math.floor(h.time / 60)}`)}${h.time === 0 ? L(' (начало)', ' (start)') : ''}</option>`).join('')
}
rewindSelect.addEventListener('change', () => {
  const time = Number(rewindSelect.value)
  if (rewindSelect.value === '') return
  sim.rewind(time); timeline.truncate(time); echoMaps.truncate(time); rewindSelect.value = ''; running = true; updatePause()
  note(L(`Расчёт вернулся к ${Math.floor(time / 60)}-й минуте`, `The run went back to minute ${Math.floor(time / 60)}`))
})
/** The settings of a saved run or of a precise run's frames: everything else back to the defaults, the left column shown. */
function takeSettings(saved: unknown) {
  Object.assign(config, defaults, { wind05: undefined, wind1: undefined, windDir05: undefined, windDir1: undefined, profile: undefined, weismanKlemp: undefined, sounding: undefined, bubbleRadius: undefined, front: undefined, edges: undefined, start: undefined, nudge: undefined, frameMotion: undefined, top: undefined, spacing: undefined, nightInversion: undefined, zones: undefined, frontLine: undefined, largeScale: undefined }, cleanSettings(saved))
  fillLowWind(config); baseScenario = null; built = null; soundingBase = config.sounding ? { sounding: config.sounding, start: config.start } : null; syncControls(); markPreset(null); showScenario()
}
stateFile.addEventListener('change', async () => {
  const file = stateFile.files?.[0]; stateFile.value = ''
  if (!file) return
  try {
    const buffer = await file.arrayBuffer(), state = readState(buffer)
    takeSettings(state.header.config)
    // The file's seed: the surface pattern under the domain comes from it and is not in the file.
    recreate(config.seed)
    timeline.points.length = 0; echoMaps.maps.length = 0
    sim.loadState(state, buffer); running = true; updatePause()
    note(L(`Открыт расчёт · с ${Math.floor(state.header.time / 60)}-й минуты`, `Run opened · from minute ${Math.floor(state.header.time / 60)}`))
  } catch (error) { note(`${L('Не удалось открыть', 'Could not open it')}: ${(error as Error).message}`) }
})
document.querySelector('#timelineCsv')!.addEventListener('click', () => download(`meteolab-hod-grozy-seed${config.seed}.csv`, toCsv(timeline.points, [
  ...stampColumns(() => config.seed), ['time_s', p => p.t], ['sb_cape_jkg', p => p.cape], ['sb_cin_jkg', p => p.cin], ['max_updraft_ms', p => p.updraft], ['uh_2_5km_m2s2', p => p.uh],
  ['rain_rate_mmh', p => p.rain], ['rain_total_mm', p => p.rainTotal], ['core_rotation_held_s', p => p.rotationHeld], ['flashes_per_min', p => p.flashes],
  ['surface_gust_ms', p => p.gust], ['hail_mm', p => p.hail],
])))
document.querySelector('#pause')!.addEventListener('click', () => { if (sim.replaying) { replayToggle(); return } running = !running; updatePause() })

// Playing back a precise run's frames (roadmap C2): the model built with the file's settings, its worker idle, a slider
// over the frames; every instrument reads the frame shown. The frames hold no flashes, so the lightning stays dark.
const framesFile = document.querySelector<HTMLInputElement>('#framesFile')!, replayBar = document.querySelector<HTMLElement>('#replayBar')!
const replayRange = document.querySelector<HTMLInputElement>('#replayRange')!, replayPlay = document.querySelector<HTMLButtonElement>('#replayPlay')!
/** Frames a second while playing in a row. */
const REPLAY_FPS = 4
let replayTimer = 0
function replayShow(k: number) {
  const frames = sim.replayFrames
  if (!frames.length) return
  k = Math.max(0, Math.min(frames.length - 1, k)); replayRange.value = String(k)
  // Back in time: the storm's course drops what came after.
  if (frames[k].time < sim.time) timeline.truncate(frames[k].time)
  text('replayTime', runTime(frames[k].time))
  void sim.showFrame(k)
}
function replayToggle(on = !replayTimer) {
  clearInterval(replayTimer); replayTimer = 0
  if (on && sim.replaying) {
    if (Number(replayRange.value) >= sim.replayFrames.length - 1) replayShow(0)
    replayTimer = window.setInterval(() => { const k = Number(replayRange.value) + 1; if (k >= sim.replayFrames.length) replayToggle(false); else replayShow(k) }, 1000 / REPLAY_FPS)
  }
  replayPlay.textContent = replayTimer ? '❚❚' : '▶'
  const status = document.querySelector<HTMLElement>('#statusText')!
  if (sim.replaying) { status.textContent = L('Проигрывание', 'Playback'); status.classList.toggle('is-paused', !replayTimer) }
}
/** Back from a playback (a new run was started): the bar goes. */
function endReplay() { clearInterval(replayTimer); replayTimer = 0; replayBar.hidden = true }
document.querySelector('#framesOpen')!.addEventListener('click', () => framesFile.click())
framesFile.addEventListener('change', async () => {
  const file = framesFile.files?.[0]; framesFile.value = ''
  if (!file) return
  try {
    takeSettings((await frameSettings(file)).config)
    recreate(config.seed)
    timeline.points.length = 0; echoMaps.maps.length = 0
    running = false; updatePause()
    await sim.startReplay(file)
    const frames = sim.replayFrames
    replayRange.max = String(frames.length - 1); replayBar.hidden = false; replayShow(0); replayToggle(false)
    note(L(`Точный прогон · ${frames.length} кадров до ${Math.round(frames[frames.length - 1].time / 60)}-й минуты, сетка ${sim.model.grid.nx} × ${sim.model.grid.ny}`, `Precise run · ${frames.length} frames to minute ${Math.round(frames[frames.length - 1].time / 60)}, grid ${sim.model.grid.nx} × ${sim.model.grid.ny}`), true)
  } catch (error) { endReplay(); note(`${L('Не удалось открыть', 'Could not open it')}: ${(error as Error).message}`) }
})
replayRange.addEventListener('input', () => { replayToggle(false); replayShow(Number(replayRange.value)) })
replayPlay.addEventListener('click', () => replayToggle())
document.querySelector('#replayClose')!.addEventListener('click', () => { recreate(config.seed); running = true; updatePause() })
const updatePause = () => {
  document.querySelector('#pause')!.textContent = running ? L('Пауза', 'Pause') : L('Продолжить', 'Continue')
  const status = document.querySelector<HTMLElement>('#statusText')!
  status.textContent = running ? L('Идёт расчёт', 'Running') : L('Пауза', 'Paused'); status.classList.toggle('is-paused', !running)
}
const setView = (patch: Partial<typeof view>) => { Object.assign(view, patch); Object.assign(sim, patch) }
const fieldPanel = document.querySelector<HTMLDivElement>('#fieldPanel')!
// On a phone the field panel shows only its title and colour bar over the view; the settings open on demand.
const fieldSettingsToggle = document.querySelector<HTMLButtonElement>('#fieldSettingsToggle')!
const showFieldSettings = (open: boolean) => { fieldPanel.classList.toggle('is-open', open); fieldSettingsToggle.setAttribute('aria-expanded', String(open)); fieldSettingsToggle.textContent = open ? L('Свернуть ▴', 'Hide ▴') : L('Настройки ▾', 'Settings ▾') }
fieldSettingsToggle.addEventListener('click', () => showFieldSettings(!fieldPanel.classList.contains('is-open')))
const formatValue = (v: number) => `${v > 0 ? '+' : ''}${Number.isInteger(v) ? v : v.toFixed(1)}`
document.querySelectorAll<HTMLButtonElement>('[data-field]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-field]').forEach(b => b.setAttribute('aria-selected', String(b === button)))
  const field = button.dataset.field as FieldMode
  setView({ field })
  fieldPanel.hidden = field === 'composite'
  document.querySelector<HTMLDivElement>('#cloudLegend')!.hidden = field !== 'composite'
  if (field === 'composite') return
  document.querySelector<HTMLElement>('#uhLayerRow')!.hidden = field !== 'helicity'
  if (field === 'helicity') aimSliceAtUhLayer()
  showFieldScale(field)
}))
/** The colour bar and title of a field (the helicity map's follow its layer). */
function showFieldScale(field: Exclude<FieldMode, 'composite'>) {
  const info = fieldInfo(field, view.uhLayer), signed = info.diverging
  text('fieldTitle', `${info.title}, ${info.units}`)
  document.querySelector<HTMLDivElement>('#colorbar')!.style.background = `linear-gradient(to right, ${info.stops.join(',')})`
  text('fieldMin', signed ? formatValue(info.min) : String(info.min))
  text('fieldMid', signed ? '0' : String((info.min + info.max) / 2))
  text('fieldMax', signed ? formatValue(info.max) : String(info.max))
}
/** Puts the horizontal slice inside the chosen UH layer (the map is drawn only there). */
function aimSliceAtUhLayer() {
  const l = UH_LAYERS[view.uhLayer], mid = view.uhLayer === 'deep' ? 3.5 : (l.from + l.to) / 2000
  if (view.uhLayer === 'deep' || view.sliceHeight < l.from / 1000 + .1 || view.sliceHeight > l.to / 1000 - .1) { sliceHeight.value = String(Math.max(.3, mid)); sliceHeight.dispatchEvent(new Event('input')) }
}
document.querySelector<HTMLSelectElement>('#uhLayer')!.addEventListener('change', event => {
  setView({ uhLayer: (event.target as HTMLSelectElement).value as UhLayer }); aimSliceAtUhLayer(); showFieldScale('helicity')
})
// Overlay switches on the 3D view.
for (const [id, key] of [['#flowToggle', 'showVectors'], ['#mesoToggle', 'showMesocyclone'], ['#flankToggle', 'showFlanks'], ['#lightningToggle', 'showLightning'], ['#swathToggle', 'showRainTotal'], ['#precipToggle', 'showPrecip']] as const)
  document.querySelector<HTMLButtonElement>(id)!.addEventListener('click', event => { setView({ [key]: !view[key] }); (event.currentTarget as HTMLElement).setAttribute('aria-pressed', String(view[key])) })
{
  const replay = document.querySelector<HTMLButtonElement>('#lightningReplay')!
  replay.addEventListener('click', () => {
    if (!view.showLightning) { setView({ showLightning: true }); document.querySelector('#lightningToggle')!.setAttribute('aria-pressed', 'true') }
    if (sim.replayLightning(1 / 20)) return
    replay.textContent = L('Молний ещё не было', 'No lightning yet'); setTimeout(() => { replay.textContent = L('Повтор удара', 'Replay stroke') }, 2000)
  })
}
const sliceHeight = document.querySelector<HTMLInputElement>('#sliceHeight')!, sliceNorth = document.querySelector<HTMLInputElement>('#sliceNorth')!
sliceHeight.addEventListener('input', () => { setView({ sliceHeight: Number(sliceHeight.value) }); text('sliceHeightOut', `${Number(sliceHeight.value).toFixed(1)}${KM}`) })
sliceNorth.addEventListener('input', () => {
  const km = Number(sliceNorth.value)
  setView({ sliceNorth: km }); text('sliceNorthOut', km === 0 ? `0${KM}` : `${Math.abs(km)}${KM} ${km > 0 ? L('к северу', 'north') : L('к югу', 'south')}`)
})
const layerMode = document.querySelector<HTMLSelectElement>('#layerMode')!, volumeControls = document.querySelector<HTMLDivElement>('#volumeControls')!
layerMode.addEventListener('change', () => { const mode = layerMode.value as LayerMode; setView({ layerMode: mode }); volumeControls.hidden = mode !== 'volume' })
const volumeThreshold = document.querySelector<HTMLInputElement>('#volumeThreshold')!, volumeDensity = document.querySelector<HTMLInputElement>('#volumeDensity')!
volumeThreshold.addEventListener('input', () => { setView({ volumeThreshold: Number(volumeThreshold.value) }); text('volumeThresholdOut', `${Math.round(Number(volumeThreshold.value) * 100)} %`) })
volumeDensity.addEventListener('input', () => { setView({ volumeDensity: Number(volumeDensity.value) }); text('volumeDensityOut', `${Number(volumeDensity.value).toFixed(1)}×`) })
// Cell selection: a click (not a drag of the camera) on the 3D view picks the nearest cell; so do the list and the labels.
let selectedCell: number | null = null, cellNote = '', cellListKey = '', pressed: { x: number; y: number } | null = null
function selectCell(id: number | null) { selectedCell = id; cellNote = ''; cellListKey = '' }
canvas.addEventListener('pointerdown', event => { pressed = event.button === 0 ? { x: event.clientX, y: event.clientY } : null })
canvas.addEventListener('pointerup', event => {
  if (!pressed || Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 4) { pressed = null; return }
  pressed = null
  const r = canvas.getBoundingClientRect(), nx = (event.clientX - r.left) / r.width, ny = (event.clientY - r.top) / r.height
  if (placingStation) { placingStation = false; const slot = stationGrounds.indexOf(null), g = sim.stationPoint(nx, ny); stationGrounds = slot < 0 ? [...stationGrounds, g] : stationGrounds.map((p, k) => k === slot ? g : p); station.chosen = slot < 0 ? stationGrounds.length - 1 : slot; sim.placeStations(stationGrounds); station.refresh(sim.stations, false); station.toggle(true); return }
  if (handTool) { if (sim.fromGround) pickHint.textContent = L('Руками — только в виде сверху · Esc — выключить', 'By hand — from above only · Esc turns it off'); else sim.intervene(handTool, nx, ny, handStrength); return }
  if (pickingGround) { if (sim.standAt(nx, ny)) { picking(false); showGround() } else pickHint.textContent = L('Здесь нет земли области — щёлкните по земле · Esc — отмена', 'No ground of the domain here — click the ground · Esc — cancel'); return }
  const g = sim.groundPoint(nx, ny), cell = sim.cells.nearest(g.x, g.y, sim.model)
  if (cell) selectCell(cell.id)
})
document.querySelector('#cellAll')!.addEventListener('click', () => selectCell(null))
document.querySelector('#cellList')!.addEventListener('click', event => { const b = (event.target as HTMLElement).closest<HTMLElement>('[data-cell]'); if (b) selectCell(Number(b.dataset.cell)) })
const cellLabels = document.querySelector<HTMLDivElement>('#cellLabels')!
cellLabels.addEventListener('click', event => { const b = (event.target as HTMLElement).closest<HTMLElement>('[data-cell]'); if (b) selectCell(Number(b.dataset.cell)) })
const COMPASS = L('С СВ В ЮВ Ю ЮЗ З СЗ', 'N NE E SE S SW W NW').split(' ')
const heading = (u: number, v: number) => COMPASS[Math.round(((Math.atan2(u, v) * 180 / Math.PI + 360) % 360) / 45) % 8]
const ORIGIN = { thermal: L('возникла из термика', 'grew from a thermal'), split: L('отделилась при расщеплении', 'split off'), 'gust-front': L('возникла на фронте порывов', 'grew on the gust front') } as const
/** Cell list, labels over the 3D view, the selection ring and, for a selected cell, its own numbers in the panel. */
function updateCells() {
  const tracker = sim.cells
  if (selectedCell !== null && !tracker.find(selectedCell)) {
    // The selected cell merged into another (follow it there) or decayed (back to the whole domain).
    const end = tracker.ended.find(e => e.id === selectedCell)
    if (end?.into) { const from = selectedCell; selectCell(end.into); cellNote = L(`№${from} слилась с №${end.into}`, `#${from} merged into #${end.into}`) }
    else { const from = selectedCell; selectCell(null); cellNote = L(`ячейка №${from} распалась`, `cell #${from} dissipated`) }
  }
  const cell = tracker.find(selectedCell)
  sim.setSelection(cell ? { x: cell.x, y: cell.y } : null)
  // The list is rebuilt when cells or stages change; the updraughts are written into it every frame.
  const cumulus = tracker.unnumbered, key = tracker.cells.map(c => `${c.id}:${c.stage}:${cellDot(c)}`).join() + `|${selectedCell}|${cumulus}`
  if (key !== cellListKey) {
    cellListKey = key
    document.querySelector('#cellList')!.innerHTML = (tracker.cells.length
      ? tracker.cells.map(c => `<button class="cell" data-cell="${c.id}" aria-pressed="${c.id === selectedCell}" title="${CELL_STAGES[c.stage].hint}"><span class="cell__id">${NO}${c.id}</span><span class="cell__kind"><span class="dot${cellDot(c)}"></span>${CELL_STAGES[c.stage].name}</span><span class="cell__val"><span data-cell-w></span> <span class="unit">${L('м/с', 'm/s')}</span></span></button>`).join('')
      : `<div class="cells__empty">${L('Ячеек пока нет. Щелчок по ячейке на 3D-виде или в списке закрепляет за ней показатели ниже', 'No cells yet. A click on a cell in the 3D view or in the list ties the values below to it')}</div>`)
      + (cumulus ? `<div class="cells__more" title="${L('Восходящие ядра, ещё не ставшие грозой: номер получает ядро, чей поток поднялся выше 6 км и окреп до 10 м/с', 'Updraught cores not yet storms: a core gets a number once its updraught rises above 6 km and reaches 10 m/s')}">+ ${cumulus} ${L('кучевых без номера', 'cumulus without a number')}</div>` : '')
    document.querySelector('#cellAll')!.setAttribute('aria-pressed', String(selectedCell === null))
    text('cellCount', tracker.cells.length ? `${L('Ячейки', 'Cells')} · ${tracker.cells.length}` : L('Ячейки', 'Cells'))
  }
  for (const c of tracker.cells) { const w = document.querySelector(`#cellList [data-cell="${c.id}"] [data-cell-w]`); if (w) w.textContent = c.stats.updraft.toFixed(0) }
  // Labels over the cloud tops.
  const seen = new Set<string>()
  for (const c of tracker.cells) {
    const id = String(c.id), p = sim.screenPoint(c.x, c.y, (Math.max(c.stats.cloudTop, 2) + .8) * 1000)
    let label = cellLabels.querySelector<HTMLButtonElement>(`[data-cell="${id}"]`)
    if (!label) { label = document.createElement('button'); label.className = 'ov-cell'; label.dataset.cell = id; label.textContent = `№${id}`; cellLabels.appendChild(label) }
    label.setAttribute('aria-pressed', String(c.id === selectedCell)); label.hidden = !p
    if (p) label.style.transform = `translate(${p.x.toFixed(0)}px, ${p.y.toFixed(0)}px) translate(-50%, -100%)`
    seen.add(id)
  }
  cellLabels.querySelectorAll<HTMLElement>('[data-cell]').forEach(l => { if (!seen.has(l.dataset.cell!)) l.remove() })
  text('metricScope', (cell ? L(`Показатели ячейки №${cell.id}`, `Values of cell #${cell.id}`) : L('Показатели по всей области', 'Values over the whole domain')) + (cellNote ? ` (${cellNote})` : ''))
  const stage = document.querySelector<HTMLElement>('#cellStage')!
  if (!cell) {
    // The whole domain: the strongest cell's stage under the storm mode.
    const top = tracker.cells.reduce<typeof tracker.cells[number] | null>((a, b) => !a || b.stats.updraft > a.stats.updraft ? b : a, null)
    const html = top ? `${L('сильнейшая', 'strongest')} — <span class="num">${NO}${top.id}</span> · ${CELL_STAGES[top.stage].name}<small>${CELL_STAGES[top.stage].hint}</small>` : ''
    if (stage.innerHTML !== html) stage.innerHTML = html
    return
  }
  // Motion only once the centre has been followed for 2 min since the last split or merger (before that it jumps about).
  // The tracker follows cells in the domain's frame; over the ground they also move with the domain.
  const [fu, fv] = sim.model.frame, gu = cell.u + fu, gv = cell.v + fv
  const s = cell.stats, age = Math.floor((sim.time - cell.born) / 60), speed = Math.hypot(gu, gv), followed = cell.trail[cell.trail.length - 1].t - cell.trail[0].t >= 120
  // The cell's own cloud genus (describe.ts), by its top against the live sounding's levels.
  const live = sim.live, genus = cloudGenus(s.cloudTop, live.sounding.lcl, live.env.temperatureEnv(s.cloudTop * 1000), live.sounding.el)
  const html = `<span class="num">${NO}${cell.id}</span> · ${CELL_STAGES[cell.stage].name}<small>${genus ? `${genus}; ` : ''}${CELL_STAGES[cell.stage].hint}. ${L(`Возраст ${age} мин`, `Age ${age} min`)}, ${ORIGIN[cell.origin]}${cell.parent ? L(` (от №${cell.parent})`, ` (from #${cell.parent})`) : ''}; ${!followed ? L('движение уточняется', 'motion being estimated') : speed < 1 ? L('почти стоит', 'nearly stationary') : L(`движется на ${heading(gu, gv)}, ${speed.toFixed(0)} м/с`, `moving ${heading(gu, gv)}, ${speed.toFixed(0)} m/s`)}${flankText(cell.flanks)}</small>`
  if (stage.innerHTML !== html) stage.innerHTML = html
  text('updraft', s.updraft.toFixed(1)); text('downdraft', s.downdraft.toFixed(1)); text('uh', s.uh.toFixed(0)); text('uhLow', `${s.uh01.toFixed(0)} / ${s.uh03.toFixed(0)}`)
  text('cloudTop', s.cloudTop.toFixed(1)); text('coldPool', s.coldPool.toFixed(1)); showRain(s.rainRate)
}
/** The most of each value so far, beside it: of the run over the domain, or of the chosen cell since it was chosen. */
const peaks: Record<string, number> = {}
let peakScope = '', peakTime = 0
function trackPeaks() {
  const scope = document.querySelector('#metricScope')!.textContent!.replace(/ \(.*\)$/, '')
  if (scope !== peakScope || sim.time < peakTime) { for (const k in peaks) delete peaks[k]; peakScope = scope }
  peakTime = sim.time
  document.querySelectorAll<HTMLElement>('.mtable tr[data-metric]').forEach(row => {
    const id = row.dataset.metric!, now = Number.parseFloat(document.querySelector(`#${id}`)!.textContent!.replace(',', '.'))
    if (Number.isFinite(now)) peaks[id] = Math.max(peaks[id] ?? -Infinity, now)
    const most = peaks[id], digits = (document.querySelector(`#${id}`)!.textContent!.split(/[.,]/)[1] ?? '').length
    text(`${id}Max`, most === undefined ? '—' : most.toFixed(digits))
  })
}
/** A block's quantities as CSV rows: the values table (now and max), the indices' pairs, the stats. */
function blockCsv(block: string, button: HTMLElement) {
  const root = button.closest('section, details')!, rows: { quantity: string; now: string; max: string; unit: string }[] = []
  const clean = (e: Element | null) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim()
  // Numbers as numbers (for a spreadsheet or pandas), a dash as empty; «8 / 27» and words stay text.
  const value = (t: string) => t === '—' ? '' : /^[−-]?\d+([.,]\d+)?$/.test(t) ? Number(t.replace(',', '.').replace('−', '-')) : t
  root.querySelectorAll('.mtable tr[data-metric]').forEach(tr => rows.push({ quantity: clean(tr.querySelector('.label')), now: clean(tr.querySelector('.mtable__now')), max: clean(tr.querySelector('.mtable__max')), unit: clean(tr.querySelector('.unit')) }))
  root.querySelectorAll('.pair > div').forEach(d => rows.push({ quantity: clean(d.querySelector('.label')), now: clean(d.querySelector('.metric__num')), max: '', unit: clean(d.querySelector('.unit')) }))
  root.querySelectorAll('.stat').forEach(d => rows.push({ quantity: clean(d.firstElementChild), now: clean(d.querySelector('.stat__v [id]') ?? d.querySelector('.stat__v')), max: '', unit: clean(d.querySelector('.stat__v .unit')) }))
  const time = Math.round(sim.time), seed = config.seed
  download(`meteolab-${block}-t${time}s.csv`, toCsv(rows, [...stampColumns(() => seed), ['model_time_s', () => time], ['quantity', r => r.quantity], ['value', r => value(r.now)], ['max_this_run', r => value(r.max)], ['unit', r => r.unit]]))
}
document.querySelectorAll<HTMLElement>('[data-csv]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); blockCsv(b.dataset.csv!, b) }))
/** A rotating cell's downdraughts in a few words (core/flanks.ts), for its card. */
function flankText(f: StormFlanks | null) {
  if (!f || !(f.ffd || f.rfd)) return ''
  const one = (name: string, x: Flank | null) => x ? L(`${name}: вниз ${x.down.toFixed(0)} м/с, θv′ ${decimal(x.cold, 1)} K`, `${name}: down ${x.down.toFixed(0)} m/s, θv′ ${decimal(x.cold, 1)} K`) : ''
  return '. ' + [one('FFD', f.ffd), one('RFD', f.rfd)].filter(Boolean).join('; ')
}
/** The rain rate with its word (describe.ts). */
function showRain(rate: number) { text('rain', rate.toFixed(1)); text('rainWord', rainWord(rate)) }
/** The alarm colour of the storm mode and the UH card: only on the model's signal that the mesocyclone has held
 *  MESO_PERSISTENCE, never on the UH number alone. The mode is the domain's; the UH card follows the selected cell. */
function showMode(hail: boolean) {
  const cell = sim.cells.find(selectedCell), meso = sim.model.rotation.persisted >= MESO_PERSISTENCE
  document.querySelector('#modeCard')!.classList.toggle('is-meso', meso)
  document.querySelector<HTMLElement>('#mesoBadge')!.hidden = !meso
  document.querySelector('[data-metric="uh"]')!.classList.toggle('metric--danger', cell ? cell.meso >= MESO_PERSISTENCE : meso)
  document.querySelector('[data-metric="hail"]')!.classList.toggle('is-empty', !hail)
}
/** The dot of a cell in the list: a mesocyclone now, rotation (or a left mover), or neither. */
const cellDot = (c: { meso: number; supercell: boolean; leftMover: boolean; stage: string }) => c.meso >= MESO_PERSISTENCE ? ' dot--danger' : c.supercell || c.leftMover || c.stage === 'rotating' ? ' dot--warn' : ''
// An instrument screen covers the 3D view: the view is not drawn meanwhile (the ray-marched clouds are the heaviest
// drawing of the page; behind the radar they made it lag even on a computer). The physics runs on.
// Signs of tornadogenesis (core/tornado.ts) over the whole domain, once a second: how long the rotation at the ground
// has held is counted here, from the snapshots; the thresholds are the user's (kept in the browser).
const TORNADO_KEY = 'meteolab-tornado'
let tornado: TornadoThresholds = { ...TORNADO_DEFAULTS }
try { const saved = JSON.parse(localStorage.getItem(TORNADO_KEY) ?? 'null'); if (saved && typeof saved === 'object') for (const k of Object.keys(TORNADO_DEFAULTS) as (keyof TornadoThresholds)[]) if (Number.isFinite(saved[k])) tornado[k] = saved[k] } catch { /* defaults */ }
const tornadoInputs = [...document.querySelectorAll<HTMLInputElement>('[data-tornado]')]
const showThresholds = () => { for (const input of tornadoInputs) input.value = String(tornado[input.dataset.tornado as keyof TornadoThresholds]) }
for (const input of tornadoInputs) input.addEventListener('change', () => {
  const v = Number(input.value)
  if (Number.isFinite(v) && v >= 0) { tornado[input.dataset.tornado as keyof TornadoThresholds] = v; try { localStorage.setItem(TORNADO_KEY, JSON.stringify(tornado)) } catch { /* this visit only */ } }
  showThresholds(); tornadoShown = 0
})
document.querySelector('#tornadoReset')!.addEventListener('click', () => { tornado = { ...TORNADO_DEFAULTS }; try { localStorage.removeItem(TORNADO_KEY) } catch { /* nothing kept */ } showThresholds(); tornadoShown = 0 })
showThresholds()
let tornadoShown = 0, lowHeld = 0, lowAt = 0
/**
 * «What to expect» (core/expect.ts), once a second with the tornado signs: the forecast from the run's starting
 * environment (the model's own, which the run does not change) and, beside it, the run's outcome so far.
 */
let expectFor: { model: unknown; list: Expectation[] } | null = null, outcome = { time: 0, supercell: 0, tornado: 0, hail: 0, gust: 0, cells: 0 }
function showExpect(tornadoLevel: number) {
  const m = sim.model, d = sim.diagnostics()
  if (expectFor?.model !== m) { const p = parcelIndices(m.env, m.grid.height); expectFor = { model: m, list: expectations(p, stormIndices(m.env, p)) } }
  if (m.time < outcome.time || m.time === 0) outcome = { time: 0, supercell: 0, tornado: 0, hail: 0, gust: 0, cells: 0 }
  outcome.time = m.time
  // A supercell: a tracked one, or the model's mesocyclone that has held MESO_PERSISTENCE (also right after a file is opened).
  if (!outcome.supercell && (sim.cells.cells.some(c => c.supercell) || m.rotation.persisted >= MESO_PERSISTENCE)) outcome.supercell = Math.max(1, m.time - m.rotation.persisted)
  outcome.tornado = Math.max(outcome.tornado, tornadoLevel); outcome.hail = Math.max(outcome.hail, d.hailSwath); outcome.gust = Math.max(outcome.gust, d.gust)
  outcome.cells = Math.max(outcome.cells, sim.cells.cells.filter(c => c.id).length)
  const minutes = (t: number) => L(`с ${Math.round(t / 60)}-й мин`, `from minute ${Math.round(t / 60)}`), early = m.time < 600
  const got: Record<string, string> = early ? {} : {
    [L('Гроза', 'Thunderstorm')]: outcome.cells ? L(`была: ячеек до ${outcome.cells}`, `yes: up to ${outcome.cells} cells`) : outcome.supercell ? L('была', 'yes') : d.cloudTop > 6 ? L('глубокое облако', 'a deep cloud') : L('нет', 'no'),
    [L('Режим', 'Mode')]: outcome.supercell ? L('суперячейка', 'a supercell') : outcome.cells > 1 ? L('многоячейковая', 'multicell') : outcome.cells ? L('одиночная', 'single cell') : '—',
    [L('Суперячейка', 'Supercell')]: outcome.supercell ? minutes(outcome.supercell) : L('нет', 'no'),
    [L('Значимый смерч', 'Significant tornado')]: TORNADO_LEVELS[outcome.tornado as 0 | 1 | 2 | 3],
    [L('Крупный град', 'Large hail')]: outcome.hail >= 1 ? L(`до ${decimal(outcome.hail / 10, 1)} см`, `up to ${decimal(outcome.hail / 10, 1)} cm`) : L('нет', 'no'),
    [L('Долгий шквал', 'Long-lived wind storm')]: L(`порыв до ${outcome.gust.toFixed(0)} м/с`, `gusts up to ${outcome.gust.toFixed(0)} m/s`),
  }
  const html = expectFor.list.map(e => `<li class="expect--${e.level}"><span class="expect__head"><b>${e.topic}</b> — <span class="expect__verdict">${e.verdict}</span></span><em title="${L('вышло в модели', 'what the model made')}">${got[e.topic] ?? (early ? L('ждём…', 'waiting…') : '')}</em><small>${e.detail} · ${e.source}</small></li>`).join('')
  const list = document.querySelector('#expectList')!
  if (list.innerHTML !== html) list.innerHTML = html
}
function showTornado() {
  const m = sim.model, now = performance.now()
  // The rotation at the ground: held while at the threshold, counted in model time (back to 0 on a restart).
  if (m.time < lowAt) lowHeld = 0
  lowHeld = m.rotation.uh01 >= tornado.uh01 ? lowHeld + Math.max(0, m.time - lowAt) : 0; lowAt = m.time
  if (now - tornadoShown < 1000) return
  tornadoShown = now
  const live = sim.live, signs = tornadoSigns({ uh01: m.rotation.uh01, lowHeld, mesoHeld: m.rotation.persisted, stp: live.storm.stp, srh01: live.storm.srh01, lcl: live.indices.sb.lcl, cold: sim.diagnostics().outflowLow }, tornado)
  text('tornadoLevel', TORNADO_LEVELS[signs.level]); text('tornadoNote', TORNADO_NOTES[signs.level]); showExpect(signs.level)
  document.querySelector('#tornadoLevel')?.closest('.stat')?.classList.toggle('stat--warn', signs.level === 2)
  document.querySelector('#tornadoLevel')?.closest('.stat')?.classList.toggle('stat--danger', signs.level === 3)
  const html = signs.checks.map(c => `<li class="${c.ok ? 'is-ok' : ''}"><span>${c.ok ? '✓' : '·'} ${c.name}</span><b>${c.value}</b></li>`).join('')
  const list = document.querySelector('#tornadoChecks')!
  if (list.innerHTML !== html) list.innerHTML = html
}
/**
 * The speed the computer keeps up, under the speed slider, once a second; a warning when it is well below the chosen
 * one (the model cannot run faster than it is computed).
 */
let speedShown = 0
function showSpeed() {
  const now = performance.now()
  if (now - speedShown < 1000) return
  speedShown = now
  const real = sim.realSpeed, warn = document.querySelector<HTMLElement>('#speedWarn')!, low = running && real > 0 && real < .7 * config.speed
  text('speedReal', running && real > 0 ? `${L('фактически', 'actually')} ×${real < 10 ? real.toFixed(1) : real.toFixed(0)}` : '')
  warn.hidden = !low
  if (low) warn.querySelector('.notice__text')!.textContent = L(`Компьютер успевает только ×${real.toFixed(real < 10 ? 1 : 0)}: модель идёт медленнее выбранной скорости. Быстрее — меньше область или расчёт на видеокарте (WebGPU, в плане).`, `The computer keeps up only ×${real.toFixed(real < 10 ? 1 : 0)}: the model runs slower than the chosen speed. Faster — a smaller domain, or the computation on the GPU (WebGPU, planned).`)
}
/** Domain size and grid in the header and footer, and how fast the domain moves with the storm. */
function showDomain() {
  const { nx, ny, nz, width, depth, height } = sim.model.grid, [fu, fv] = sim.model.frame, speed = Math.hypot(fu, fv)
  text('domainSize', `${width / 1000} × ${depth / 1000} × ${Math.round(height / 1000)}${KM}`); text('gridSize', `${nx} × ${ny} × ${nz}`); const km = (m: number) => decimal(m / 1000, 2).replace(/[.,]?0+$/, ''); text('gridSpacing', `${km(width / nx)} / ${km(depth / ny)}${KM}`)
  text('frameMotion', speed < .1 ? L('неподвижна', 'fixed') : L(`движется на ${heading(fu, fv)}, ${speed.toFixed(1)} м/с`, `moving ${heading(fu, fv)}, ${speed.toFixed(1)} m/s`))
}
// A thermal where the surface is double-clicked, or double-tapped on a touch screen: the taps are matched here, since
// mobile browsers (iOS above all) do not reliably send dblclick; the dblclick that may still follow a double tap is
// ignored.
const thermalAt = (x: number, y: number) => {
  const r = canvas.getBoundingClientRect(), nx = (x - r.left) / r.width, ny = (y - r.top) / r.height
  // From the ground a double click goes there, keeping the look (the point must be on the domain's ground).
  if (sim.fromGround) sim.standAt(nx, ny, true); else sim.perturb(nx, ny, 1.25)
}
let lastTap: { x: number; y: number; t: number } | null = null, tappedAt = -Infinity
canvas.addEventListener('pointerup', event => {
  if (event.pointerType !== 'touch') return
  const now = performance.now()
  if (lastTap && now - lastTap.t < 350 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 30) { thermalAt(event.clientX, event.clientY); lastTap = null; tappedAt = now; return }
  lastTap = { x: event.clientX, y: event.clientY, t: now }
})
// The view from the ground: the toggle (and G) opens a menu of where to stand — beside the storm (far or near), at the
// weather station, or a point picked on the ground with a click — and back to the view from above. From the ground a
// double click or tap on the ground goes there instead of starting a thermal; the wheel narrows the field of view.
const groundToggle = document.querySelector<HTMLButtonElement>('#groundToggle')!, groundMenu = document.querySelector<HTMLElement>('#groundMenu')!
const pickHint = document.querySelector<HTMLElement>('#pickHint')!
/** Waiting for a click on the ground to stand there (the menu's «Выбрать место»). */
let pickingGround = false
const showGround = () => groundToggle.setAttribute('aria-pressed', String(sim.fromGround))
/** The station to stand at: the one chosen on the station screen (the first standing when all are compared). */
const standingStation = () => station.chosen === 'all' ? Math.max(0, sim.stations.findIndex(Boolean)) : station.chosen
const picking = (on: boolean) => { pickingGround = on; pickHint.hidden = !on; pickHint.textContent = L('Щёлкните по земле, где встать · Esc — отмена', 'Click the ground where to stand · Esc — cancel') }
groundMenu.addEventListener('beforetoggle', e => {
  if ((e as ToggleEvent).newState !== 'open') return
  const at = standingStation(), letter = STATION_LETTERS[at], standing = sim.stations.filter(Boolean).length
  groundMenu.querySelector<HTMLButtonElement>('[data-stand="station"]')!.disabled = !standing
  groundMenu.querySelector('[data-station-note]')!.textContent = !standing ? L('сначала поставьте станцию (прибор «Станция»)', 'place a station first (the “Station” instrument)')
    : standing > 1 ? L(`у станции ${letter} (выбранной на её экране): смотреть на грозу и на её показания`, `at station ${letter} (the one chosen on its screen): watch the storm and its readings`)
    : L('там, где стоит станция: смотреть на грозу и на её показания', 'where the station stands: watch the storm and its readings')
  groundMenu.querySelector<HTMLElement>('[data-stand="leave"]')!.hidden = !sim.fromGround
})
groundMenu.addEventListener('click', e => {
  const choice = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-stand]')?.dataset.stand
  if (!choice) return
  groundMenu.hidePopover(); picking(false)
  if (choice === 'far') sim.standSuggested(OBSERVER_BACK)
  else if (choice === 'near') sim.standSuggested(OBSERVER_NEAR)
  else if (choice === 'station') sim.standAtStation(standingStation())
  else if (choice === 'pick') picking(true)
  else sim.leaveGround()
  showGround()
})
// Interventions by hand (2.9): a tool chosen in the menu, applied by clicks on the ground until Esc or «Выключить».
const handToggle = document.querySelector<HTMLButtonElement>('#handToggle')!, handMenu = document.querySelector<HTMLElement>('#handMenu')!
let handTool: InterventionKind | null = null, handStrength = 1, handShown = -1
const handName = (kind: InterventionKind) => HAND.find(([k]) => k === kind)![1]
/** What has been put in by hand this run, against what the storm itself did (the rain fallen). */
function handLedger() {
  const a = sim.model.added, { dx, dy } = sim.model.grid
  if (!a.count) return L('В этом опыте руками пока ничего не внесено.', 'Nothing has been put in by hand in this run yet.')
  let rain = 0; for (const mm of sim.model.precipitation) rain += mm * dx * dy
  const n = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${decimal(Math.abs(v), Math.abs(v) < 10 ? 1 : 0)}`
  const heat = a.heat ? L(` тепло ${n(a.heat / 1e12)} ТДж — столько даёт конденсация ${decimal(Math.abs(a.heat) / 2.5e6 / 1e6, 1)} тыс. т пара;`, ` heat ${n(a.heat / 1e12)} TJ — what ${decimal(Math.abs(a.heat) / 2.5e6 / 1e6, 1)} kt of vapour gives condensing;`) : ''
  const vapour = a.vapour ? L(` пар ${n(a.vapour / 1e6)} тыс. т;`, ` vapour ${n(a.vapour / 1e6)} kt;`) : ''
  return L(`Внесено руками (${a.count}):${heat}${vapour} дождя выпало ${decimal(rain / 1e6, 1)} тыс. т.`, `Put in by hand (${a.count}):${heat}${vapour} rain fallen: ${decimal(rain / 1e6, 1)} kt.`)
}
function showHand() {
  handShown = sim.model.added.count
  handToggle.setAttribute('aria-pressed', String(!!handTool))
  handToggle.textContent = handTool ? `${L('Руками', 'By hand')}: ${handName(handTool).toLowerCase()}` : L('Руками', 'By hand')
  handMenu.querySelectorAll<HTMLElement>('[data-hand-strength] button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.value) === handStrength)))
  handMenu.querySelector<HTMLElement>('[data-hand="off"]')!.hidden = !handTool
  text('handLedger', handLedger())
  // Over the view, short: the tool, its strength and what is in so far.
  const a = sim.model.added, so = a.count ? ` · ${L('внесено', 'put in')}: ${decimal(a.heat / 1e12, 0)} ${L('ТДж', 'TJ')}${a.vapour ? `, ${decimal(a.vapour / 1e6, 1)} ${L('тыс. т пара', 'kt of vapour')}` : ''}` : ''
  if (handTool) { picking(false); pickHint.hidden = false; pickHint.textContent = `${handName(handTool)} ×${decimal(handStrength, handStrength < 1 ? 1 : 0)}: ${L('щелчок по земле · Esc — выключить', 'click the ground · Esc turns it off')}${so}` }
  else if (!pickingGround) pickHint.hidden = true
}
handMenu.addEventListener('beforetoggle', e => { if ((e as ToggleEvent).newState === 'open') showHand() })
handMenu.addEventListener('click', e => {
  const t = e.target as HTMLElement, kind = t.closest<HTMLElement>('[data-hand]')?.dataset.hand, strength = t.closest<HTMLElement>('[data-hand-strength] button')?.dataset.value
  if (strength) handStrength = Number(strength)
  if (kind) { handTool = kind === 'off' ? null : kind as InterventionKind; handMenu.hidePopover() }
  showHand()
})
canvas.addEventListener('wheel', event => { if (sim.zoomFromGround(event.deltaY)) event.preventDefault() }, { passive: false })
// A pinch from the ground narrows or widens the field of view, as the wheel (the field of view scales with the fingers'
// spread: zoomFromGround takes exp(delta / 1000)).
const touches = new Map<number, { x: number; y: number }>()
let pinchSpread = 0
const spread = () => { const [a, b] = [...touches.values()]; return Math.hypot(a.x - b.x, a.y - b.y) }
canvas.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') { touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (touches.size === 2) pinchSpread = spread() } })
canvas.addEventListener('pointermove', e => {
  if (!touches.has(e.pointerId)) return
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (touches.size !== 2 || !sim.fromGround || pinchSpread <= 0) return
  const now = spread()
  if (now > 0) { sim.zoomFromGround(1000 * Math.log(pinchSpread / now)); pinchSpread = now }
})
for (const type of ['pointerup', 'pointercancel'] as const) canvas.addEventListener(type, e => { touches.delete(e.pointerId); pinchSpread = touches.size === 2 ? spread() : 0 })
// A snapshot of the 3D view (PNG), named by the run's local time.
document.querySelector('#snapshotButton')!.addEventListener('click', async () => {
  const shot = await sim.snapshot()
  if (!shot) return
  const blob = await stampPngBlob(shot, mediaStamp(L(`3D-вид модели, T+${runTime(sim.time)}, ${timeOfDay(config.hour, sim.time)} по местному`, `The model's 3D view, T+${runTime(sim.time)}, ${timeOfDay(config.hour, sim.time)} local`)))
  const a = document.createElement('a'), local = timeOfDay(config.hour, sim.time).replace(':', '-')
  a.href = URL.createObjectURL(blob); a.download = `meteolab-${local}.png`; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
})
// A video of the 3D view, frame by frame (src/record/recorder.ts); from the ground — where the menu's «far» puts the observer.
// Its captions (M4): the scenario, the model and local time, what the storm is and its numbers, from the model now.
const recorder = new VideoRecorder(() => sim, () => config.hour, () => { sim.standSuggested(OBSERVER_BACK); showGround() }, () => {
  const d = sim.diagnostics(), parts = [d.updraft >= 1 ? L(`поток ${Math.round(d.updraft)} м/с`, `updraught ${Math.round(d.updraft)} m/s`) : '', d.rain >= 1 ? L(`дождь ${Math.round(d.rain)} мм/ч`, `rain ${Math.round(d.rain)} mm/h`) : '',
    d.hail >= 5 ? L(`град ${decimal(d.hail / 10, 1)} см`, `hail ${decimal(d.hail / 10, 1)} cm`) : '', d.mesocyclone ? `UH ${Math.round(d.updraftHelicity)} ${L('м²/с²', 'm²/s²')}` : '']
  return { title: document.querySelector('#scenarioName')!.textContent || 'MeteoLab', time: L(`T+${runTime(sim.time)} · ${timeOfDay(config.hour, sim.time)} по местному`, `T+${runTime(sim.time)} · ${timeOfDay(config.hour, sim.time)} local`), event: d.cellType, numbers: parts.filter(Boolean).join(' · ') }
})
document.querySelector('#videoButton')!.addEventListener('click', () => recorder.open())
// The language switch: the same page in the other language, with the run's settings (the address's query and hash).
document.addEventListener('click', e => {
  if (!(e.target as Element).closest('#langSwitch, [data-lang-switch]')) return
  e.preventDefault(); rememberLang(lang() === 'en' ? 'ru' : 'en')
  location.href = otherLanguagePath(location.pathname, import.meta.env.BASE_URL) + location.search + location.hash
})
// Full screen without the interface (users' request 14.10.2026): the page's own fullscreen where the browser has it (not
// iOS Safari: there the view just fills the window), the panels hidden; out by the corner button, Esc or F again.
const immersive = (on: boolean) => {
  document.documentElement.classList.toggle('immersive', on)
  if (on) document.documentElement.requestFullscreen?.().catch(() => { /* the view fills the window anyway */ })
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  if (!on) showCamera(false)
  applyGrade(); wakeExit()
}
const cameraBody = document.querySelector<HTMLElement>('#cameraBody')!, cameraToggle = document.querySelector<HTMLButtonElement>('#cameraToggle')!
const showCamera = (open: boolean) => { cameraBody.hidden = !open; cameraToggle.setAttribute('aria-expanded', String(open)); document.documentElement.classList.toggle('camera-open', open) }
const showGrade = () => GRADE_SLIDERS.forEach(s => {
  document.querySelector<HTMLInputElement>(`[data-grade="${s.key}"]`)!.value = String(cameraGrade[s.key])
  const v = cameraGrade[s.key]; document.querySelector(`[data-grade-out="${s.key}"]`)!.textContent = s.unit === 'EV' ? `${v > 0 ? '+' : ''}${v.toFixed(1)} EV` : `${v} %`
})
showGrade()
cameraToggle.addEventListener('click', () => showCamera(cameraBody.hidden !== false))
cameraBody.addEventListener('input', e => {
  const input = e.target as HTMLInputElement, key = input.dataset.grade as keyof CameraGrade | undefined
  if (!key) return
  cameraGrade[key] = Number(input.value); saveGrade(cameraGrade); showGrade(); applyGrade()
})
document.querySelector('#cameraReset')!.addEventListener('click', () => { Object.assign(cameraGrade, NEUTRAL_GRADE); saveGrade(cameraGrade); showGrade(); applyGrade() })
// The exit button fades after a few still seconds and comes back with any move or touch.
let exitTimer = 0
const wakeExit = () => { document.documentElement.classList.remove('immersive-still'); clearTimeout(exitTimer); exitTimer = window.setTimeout(() => document.documentElement.classList.add('immersive-still'), 2500) }
addEventListener('pointermove', () => { if (document.documentElement.classList.contains('immersive')) wakeExit() })
addEventListener('pointerdown', () => { if (document.documentElement.classList.contains('immersive')) wakeExit() })
document.querySelector('#immersiveToggle')!.addEventListener('click', () => immersive(true))
document.querySelector('#immersiveExit')!.addEventListener('click', () => immersive(false))
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.documentElement.classList.contains('immersive')) immersive(false) })
addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('input:not([type=range]):not([type=checkbox]), select, textarea, dialog')) return
  if (e.code === 'Escape' && handTool) { handTool = null; showHand() }
  else if (e.code === 'Escape' && pickingGround) picking(false)
  else if (e.code === 'Escape' && document.documentElement.classList.contains('immersive')) immersive(false)
  else if (e.code === 'KeyF') { e.preventDefault(); immersive(!document.documentElement.classList.contains('immersive')) }
  else if (e.code === 'KeyG') { e.preventDefault(); groundToggle.click() }
  // Space pauses and resumes (unless a button has the focus: there it presses the button).
  else if (e.code === 'Space' && !(e.target as HTMLElement).closest('button, a')) { e.preventDefault(); document.querySelector<HTMLButtonElement>('#pause')!.click() }
  else if (e.code === 'KeyH') { e.preventDefault(); handToggle.click() }
  else if (e.code === 'KeyP') { e.preventDefault(); document.querySelector<HTMLButtonElement>('#snapshotButton')!.click() }
  else if (e.code === 'KeyV') { e.preventDefault(); document.querySelector<HTMLButtonElement>('#videoButton')!.click() }
})
// The browser may take the WebGL context away (a phone short of GPU memory): say so instead of a silent black view.
// Three.js keeps the context restorable; if the browser gives it back, the view simply goes on. Otherwise the run can
// be started again with the same settings (a fresh page gets a fresh context).
const glLost = document.querySelector<HTMLElement>('#glLost')!
canvas.addEventListener('webglcontextlost', () => { glLost.hidden = false })
canvas.addEventListener('webglcontextrestored', () => { glLost.hidden = true })
document.querySelector('#glReload')!.addEventListener('click', () => { location.href = runLink().href })
canvas.addEventListener('dblclick', event => { if (performance.now() - tappedAt > 600) thermalAt(event.clientX, event.clientY) })

const prepareCanvas = (id: string) => {
  const c = document.querySelector<HTMLCanvasElement>(`#${id}`)!, dpr = Math.min(devicePixelRatio, 2), w = c.clientWidth, h = c.clientHeight
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
  const ctx = c.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); ctx.font = `11px ${MONO}`
  return { ctx, w, h }
}
const T_MIN = -75, T_MAX = 45, Z_MAX = 18
/** The sounding chart: the environment, dew point and parcel by height, CAPE and CIN shaded (the side column's, or the sounding dialog's preview). */
function drawSounding(canvas = 'sounding', s: Sounding = sim.sounding()){
  const { ctx, w, h } = prepareCanvas(canvas)
  const x0 = 22, R = w - 30, T = 6, B = h - 14
  const X = (t: number) => x0 + (t - T_MIN) / (T_MAX - T_MIN) * (R - x0), Y = (z: number) => T + (1 - z / Z_MAX) * (B - T)
  const c = chartPalette()
  ctx.strokeStyle = c.grid; ctx.lineWidth = 1; ctx.fillStyle = c.label
  for (let z = 0; z <= Z_MAX; z += 5) { ctx.beginPath(); ctx.moveTo(x0, Y(z)); ctx.lineTo(R, Y(z)); ctx.stroke(); ctx.fillText(`${z}`, 4, Y(z) + 3) }
  for (let t = -60; t <= 40; t += 20) { ctx.beginPath(); ctx.moveTo(X(t), T); ctx.lineTo(X(t), B); ctx.stroke(); ctx.fillText(`${t}°`, X(t) - 8, h - 3) }
  ctx.strokeStyle = '#8fbcd4'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(X(0), T); ctx.lineTo(X(0), B); ctx.stroke(); ctx.setLineDash([])
  // CAPE: parcel warmer than environment between LFC and EL; CIN: parcel colder below LFC.
  for (let i = 0; i + 1 < s.profile.length; i++) {
    const a = s.profile[i], b = s.profile[i + 1]
    const cape = s.lfc !== null && a.z >= s.lfc && (s.el === null || a.z < s.el) && a.buoyancy > 0
    const cin = s.lfc !== null && a.z < s.lfc && a.buoyancy < 0
    if (!cape && !cin) continue
    ctx.fillStyle = cape ? 'rgba(207,109,73,.38)' : 'rgba(77,134,179,.3)'
    ctx.beginPath(); ctx.moveTo(X(a.env), Y(a.z)); ctx.lineTo(X(a.parcel), Y(a.z)); ctx.lineTo(X(b.parcel), Y(b.z)); ctx.lineTo(X(b.env), Y(b.z)); ctx.fill()
  }
  const curve = (value: (p: typeof s.profile[number]) => number, color: string, dash: number[] = []) => {
    ctx.beginPath(); s.profile.forEach((p, i) => { const x = Math.max(x0, X(value(p))), y = Y(p.z); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) })
    ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([])
  }
  curve(p => p.dew, '#5a9a6a', [4, 3]); curve(p => p.env, '#4f7180'); curve(p => p.parcel, '#b46e43')
  const levels: [string, number | null, string][] = [['LCL', s.lcl, '#6f9fb0'], ['LFC', s.lfc, '#c39a4f'], ['EL', s.el, '#c0735b']]
  for (const [name, z, color] of levels) {
    if (z === null) continue
    ctx.strokeStyle = color; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(x0, Y(z)); ctx.lineTo(R, Y(z)); ctx.stroke(); ctx.setLineDash([])
    ctx.fillStyle = color; ctx.fillText(name, R + 3, Y(z) + 3)
  }
}
/** The rotation profile of the most rotating core (spin.ts) and the w-ζ correlation. */
function drawSpin(){
  const { ctx, w, h } = prepareCanvas('spin'), p = spinProfile(sim.model), top = 14, x0 = 22, R = w - 6, T = 4, B = h - 12
  const peak = Math.max(50, ...p.wz), X = (v: number) => x0 + (R - x0) * Math.max(0, v) / peak, Y = (z: number) => B - (B - T) * z / top
  const colors = chartPalette()
  ctx.strokeStyle = colors.grid; ctx.fillStyle = colors.label; ctx.lineWidth = 1
  for (let z = 0; z <= top; z += 2) { ctx.beginPath(); ctx.moveTo(x0, Y(z)); ctx.lineTo(R, Y(z)); ctx.stroke(); if (z % 4 === 0) ctx.fillText(`${z}`, 4, Y(z) + 3) }
  ctx.fillText(L(`w·ζ до ${peak.toFixed(0)}·10⁻³ м/с²`, `w·ζ up to ${peak.toFixed(0)}·10⁻³ m/s²`), R - 92, h - 2)
  ctx.fillStyle = 'rgba(123, 63, 160, .55)'
  for (let k = 1; k + 1 < p.z.length && p.z[k] <= top; k++) if (p.wz[k] > 0) ctx.fillRect(x0, Y(p.z[k + 1]), X(p.wz[k]) - x0, Y(p.z[k]) - Y(p.z[k + 1]))
  const c = p.correlation, layer = rotationSummary(sim.model.rotation, p)
  text('spinNote', c === null ? layer : `${layer}. ${L('Корреляция w–ζ 2–6 км', 'w–ζ correlation 2–6 km')} ${c.toFixed(2)}: ${c >= SPIN_SUPERCELL ? L('поток и вращение совпадают, как в суперячейке', 'the updraught and the rotation coincide, as in a supercell') : L('вращение рядом с потоком, не в нём', 'the rotation is beside the updraught, not in it')}`)
}
// The hodograph editor (hodograph.ts): handles at the wind nodes of 0-10 km. A drag shows the new hodograph and storm
// motion at once; the drop restarts the run, as a wind slider does. The handles show the wind the settings ask for, the
// line the live one (the domain mean, which the storm slowly changes).
/** The environment the settings ask for, without the storm: for the handles and the drag's preview. */
const settingsEnv = (c: SimConfig) => new Environment(c, sim.model.grid, environmentProfile(c, sim.model.grid.height))
const nodeWinds = (env: Environment) => HODOGRAPH_NODES.map(n => env.windUV(n.z))
let handles: { key: string; sounding: SimConfig['sounding']; winds: (readonly [number, number])[] } | null = null
const handleWinds = () => {
  const key = JSON.stringify(HODOGRAPH_NODES.map(n => [config[n.speed], config[n.dir]]))
  if (!handles || handles.key !== key || handles.sounding !== config.sounding) handles = { key, sounding: config.sounding, winds: nodeWinds(settingsEnv(config)) }
  return handles.winds
}
interface HodoDrag { k: number; maxRing: number; start: readonly [number, number]; config: SimConfig; preview: { wind: Sounding['wind']; right: readonly [number, number]; left: readonly [number, number]; winds: (readonly [number, number])[] } | null }
let hodoDrag: HodoDrag | null = null, hodoGeometry = { cx: 0, cy: 0, scale: 1, maxRing: 20 }
/** The sounding before the hodograph was first edited, while the edited one is in use (for «Вернуть ветер»). */
let windOriginal: { edited: SimConfig['sounding']; original: SimConfig['sounding'] } | null = null
const hodoCanvas = document.querySelector<HTMLCanvasElement>('#hodograph')!
const hodoPoint = (e: PointerEvent) => { const r = hodoCanvas.getBoundingClientRect(), g = hodoGeometry; return [(e.clientX - r.left - g.cx) / g.scale, (g.cy - (e.clientY - r.top)) / g.scale] as const }
/** The handle under the pointer (within 14 px), or -1. */
const handleAt = (e: PointerEvent) => {
  const [u, v] = hodoPoint(e), winds = handleWinds()
  let best = -1, near = 14 / hodoGeometry.scale
  winds.forEach(([hu, hv], k) => { const d = Math.hypot(hu - u, hv - v); if (d < near) { near = d; best = k } })
  return best
}
const dragTo = (drag: HodoDrag, u: number, v: number): SimConfig => {
  if (!config.sounding) {
    const max = Number(document.querySelector<HTMLInputElement>(`input[data-key="${HODOGRAPH_NODES[drag.k].speed}"]`)!.max)
    return { ...config, ...sliderNode(drag.k, u, v, max) }
  }
  return { ...config, sounding: { ...config.sounding, levels: nudgeSounding(config.sounding.levels, drag.k, u - drag.start[0], v - drag.start[1]) } }
}
hodoCanvas.addEventListener('pointerdown', e => {
  if (config.profile) return
  // Drawn now, so the hit test uses the scale of what is on the screen.
  drawHodograph(); const k = handleAt(e)
  if (k < 0) return
  e.preventDefault(); hodoCanvas.setPointerCapture(e.pointerId)
  hodoDrag = { k, maxRing: hodoGeometry.maxRing, start: handleWinds()[k], config, preview: null }
})
hodoCanvas.addEventListener('pointermove', e => {
  if (!hodoDrag) { hodoCanvas.style.cursor = !config.profile && handleAt(e) >= 0 ? 'grab' : ''; return }
  const [u, v] = hodoPoint(e), c = dragTo(hodoDrag, u, v), env = settingsEnv(c), m = stormMotion(env)
  hodoDrag.config = c; hodoDrag.preview = { wind: computeSounding(c, env, sim.model.grid.height).wind, right: m.rightMover, left: m.leftMover, winds: nodeWinds(env) }
  hodoCanvas.style.cursor = 'grabbing'; drawHodograph()
})
const endDrag = (apply: boolean) => {
  const drag = hodoDrag
  hodoDrag = null; hodoCanvas.style.cursor = ''
  if (!drag) return
  if (apply && drag.preview) {
    if (config.sounding) {
      const original = windOriginal?.edited === config.sounding ? windOriginal.original : config.sounding
      config.sounding = drag.config.sounding; windOriginal = { edited: config.sounding, original }
    } else { Object.assign(config, drag.config); syncControls(); markPreset(null) }
    recreate(); running = true; updatePause()
  }
  drawHodograph()
}
hodoCanvas.addEventListener('pointerup', () => endDrag(true))
hodoCanvas.addEventListener('pointercancel', () => endDrag(false))
hodoCanvas.addEventListener('lostpointercapture', () => endDrag(true))
/** The wind of the scenario (sliders) or of the sounding as loaded, when the hodograph has moved it. */
const windChanged = () => {
  if (config.profile) return false
  if (config.sounding) return windOriginal?.edited === config.sounding
  const base = baseConfig()
  return HODOGRAPH_NODES.some(n => Math.abs(Number(config[n.speed]) - Number(base[n.speed])) > .05 || Math.abs(Number(config[n.dir]) - Number(base[n.dir])) > .5)
}
document.querySelector('#hodoReset')!.addEventListener('click', () => {
  if (config.sounding) { if (windOriginal?.edited === config.sounding) config.sounding = windOriginal.original; windOriginal = null }
  else { const base = baseConfig(); for (const n of HODOGRAPH_NODES) Object.assign(config, { [n.speed]: base[n.speed], [n.dir]: base[n.dir] }); syncControls() }
  recreate(); running = true; updatePause(); drawHodograph()
})
function drawHodograph(){
  const { ctx, w, h } = prepareCanvas('hodograph'), preview = hodoDrag?.preview, wind = preview?.wind ?? sim.sounding().wind
  // Hidden (a narrow window, the panel folded) the canvas has no size: nothing to draw, and the rings would get a negative radius.
  if (Math.min(w, h) < 30) return
  const editable = !config.profile, winds = editable ? preview?.winds ?? handleWinds() : []
  const maxSpeed = Math.max(...wind.map(p => Math.hypot(p.u, p.v)), ...winds.map(([u, v]) => Math.hypot(u, v)))
  // The rings stay put while a handle is dragged (they would run away from the pointer).
  const maxRing = hodoDrag?.maxRing ?? Math.max(20, Math.ceil(maxSpeed / 10) * 10)
  const cx = w / 2, cy = h / 2, scale = (Math.min(w, h) / 2 - 12) / maxRing
  hodoGeometry = { cx, cy, scale, maxRing }
  const c = chartPalette()
  ctx.strokeStyle = c.grid; ctx.fillStyle = c.label; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(cx - maxRing * scale, cy); ctx.lineTo(cx + maxRing * scale, cy); ctx.moveTo(cx, cy - maxRing * scale); ctx.lineTo(cx, cy + maxRing * scale); ctx.stroke()
  for (let r = 10; r <= maxRing; r += 10) { ctx.beginPath(); ctx.arc(cx, cy, r * scale, 0, Math.PI * 2); ctx.stroke(); ctx.fillText(`${r}`, cx + r * scale * .71 + 2, cy - r * scale * .71 - 2) }
  ctx.fillText(COMPASS[0], cx + 3, 10); ctx.fillText(COMPASS[2], w - 10, cy - 3)
  const P = (p: { u: number, v: number }) => [cx + p.u * scale, cy - p.v * scale] as const
  // Bunkers right (RM) and left (LM) movers.
  for (const [label, [u, v]] of [['RM', preview?.right ?? sim.storm.rightMover], ['LM', preview?.left ?? sim.storm.leftMover]] as const) { const [x, y] = P({ u, v }); ctx.fillStyle = '#7b3fa0'; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.fillText(label, x + 4, y + 9) }
  ctx.fillStyle = c.label
  ctx.lineWidth = 2.2; ctx.lineCap = 'round'
  for (let i = 0; i + 1 < wind.length; i++) {
    const a = wind[i], b = wind[i + 1]
    ctx.strokeStyle = a.z < 3 ? '#c4553a' : a.z < 6 ? '#4f8f5b' : '#3f6fa3'
    ctx.beginPath(); ctx.moveTo(...P(a)); ctx.lineTo(...P(b)); ctx.stroke()
  }
  ctx.fillStyle = c.text
  for (const z of [0, 1, 3, 6, 10]) { const p = wind.find(q => Math.abs(q.z - z) < 1e-6); if (!p) continue; const [x, y] = P(p); ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill(); ctx.fillText(`${z}`, x + 4, y - 3) }
  // Handles: rings at the wind the settings ask for, the dragged one filled.
  ctx.lineWidth = 1.5
  winds.forEach(([u, v], k) => { const [x, y] = P({ u, v }); ctx.strokeStyle = c.text; ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.stroke(); if (hodoDrag?.k === k) { ctx.globalAlpha = .35; ctx.fillStyle = c.text; ctx.fill(); ctx.globalAlpha = 1 } })
  text('hodoHint', !editable ? L('Ветер задан формулами WK и здесь не меняется.', 'The wind is set by the WK formulas and cannot be changed here.') : config.sounding ? L('Кружки 0; 0,5; 1; 3; 6 и 10 км можно тянуть: ветер зондирования поправится между соседними кружками, расчёт начнётся заново.', 'The circles at 0, 0.5, 1, 3, 6 and 10 km can be dragged: the sounding’s wind is adjusted between neighbouring circles and the run starts again.') : L('Кружки 0; 0,5; 1; 3; 6 и 10 км можно тянуть, как ползунки ветра: расчёт начнётся заново.', 'The circles at 0, 0.5, 1, 3, 6 and 10 km can be dragged like the wind sliders: the run starts again.'))
  document.querySelector<HTMLElement>('#hodoReset')!.hidden = !windChanged()
  const w0 = wind[0], w6 = wind.find(p => Math.abs(p.z - 6) < 1e-6)!, shear = Math.hypot(w6.u - w0.u, w6.v - w0.v)
  text('shear', `${shear.toFixed(0)}${MS}`)
  text('shearHint', shear < 10 ? L('слабый: одиночные ячейки', 'weak: single cells') : shear < 20 ? L('умеренный: мультиячейки', 'moderate: multicells') : L('сильный: возможны суперячейки', 'strong: supercells possible'))
}
const timeline = new Timeline()
// The phone layout's overlay and bottom bar (hud.ts; hidden on a desktop by CSS).
const speedInput = document.querySelector<HTMLInputElement>('input[data-key="speed"]')!
const hud = new Hud(document.querySelector<HTMLElement>('.viewport')!, document.querySelector<HTMLElement>('.app')!, speed => { speedInput.value = String(speed); speedInput.dispatchEvent(new Event('input')) })
showQuality()
showThemeChoice()
/** A sounding's cap that a warm thermal does not break on this grid (the real soundings, 24.10.2026): the mixed-layer
 * parcel's CIN, J/kg, or its free convection level, km. Measured: CIN 64 J/kg with the LFC at 2.35 km stopped it. */
const CAP_CIN = 25, CAP_LFC = 2, INVERSION_TOP = 3
/** The coldest point of the mixed-layer parcel against the air between its LFC (+ 100 m) and INVERSION_TOP km, if negative. */
function inCloudInversion(env: Environment, height: number): { z: number, excess: number } | null {
  const p = liftParcel(env, height, 'ml')
  if (p.lfc === null) return null
  let low: { z: number, excess: number } | null = null
  for (const q of p.profile) {
    if (q.z <= p.lfc + .1 || q.z > INVERSION_TOP) continue
    const excess = (q.tv ?? q.parcel) - (q.envTv ?? q.env)
    if (excess < 0 && (!low || excess < low.excess)) low = { z: q.z, excess }
  }
  return low
}
/** The live sounding last handed to the Skew-T screen (a new one every LIVE_EVERY s of model time). */
let shownLive: Live | null = null
function frame(now:number){
  // The ledger of what was put in by hand follows the snapshots (an intervention shows once the worker has made it).
  if (handTool && sim.model.added.count !== handShown) showHand()
  const elapsed=Math.min(.2,(now-last)/1000);last=now;if(running)sim.advance(elapsed);if(!(radar.open||skewt.open||station.open||detector.open||zonesPanel.open||analysis.open||satellite.open||compare.open||ensemble.open||regime.open||series.open))sim.render();const d=sim.diagnostics()
  trackPeaks()
  text('cape',d.cape.toFixed(0));text('mlcape',d.indices.ml.cape.toFixed(0));text('mlcin',d.indices.ml.cin.toFixed(0));text('mucape',d.indices.mu.cape.toFixed(0));text('dcape',d.indices.dcape.toFixed(0));text('srh01',d.storm.srh01.toFixed(0));text('srh03',d.storm.srh03.toFixed(0));text('scp',d.storm.scp.toFixed(1));text('stp',d.storm.stp.toFixed(1));text('ship',d.storm.ship.toFixed(1));text('dcp',d.storm.dcp.toFixed(1));text('esrh',d.storm.effective?d.storm.effective.srh.toFixed(0):'—');text('eshear',d.storm.effective?d.storm.effective.shear.toFixed(0):'—');text('lapse75',d.storm.lapse75.toFixed(1));text('cin',d.cin.toFixed(0));text('updraft',d.updraft.toFixed(1));text('downdraft',d.downdraft.toFixed(1));text('uh',d.updraftHelicity.toFixed(0));text('uhLow',`${d.uh01.toFixed(0)} / ${d.uh03.toFixed(0)}`);text('cloudTop',d.cloudTop.toFixed(1));text('thermalTop',d.thermalTop.toFixed(1));text('cloudWater',d.cloudWater.toFixed(2));text('coldPool',d.coldPool.toFixed(1));text('gust',d.gust.toFixed(1));text('hail',d.hail>=1?(d.hail/10).toFixed(1):'—');text('hailSwath',d.hailSwath>=1?L(`за прогон до ${(d.hailSwath/10).toFixed(1)} см`,`up to ${(d.hailSwath/10).toFixed(1)} cm this run`):'');showMode(d.hail>=1);text('clipped',String(d.clipped));showRain(d.rain);text('hailWord',hailWord(d.hail));text('cloudGenus',d.cloud);text('rainTotal',d.rainTotal.toFixed(1));text('lcl',d.lcl===null?'—':`${d.lcl.toFixed(1)}${KM}`);text('lfc',d.lfc===null?'—':`${d.lfc.toFixed(1)}${KM}`);text('el',d.el===null?'—':`${d.el.toFixed(1)}${KM}`);text('cellType',d.cellType);text('cellReason',d.cellReason);text('logicText',d.logic);text('sun',`${d.insolation.toFixed(0)} ${L('Вт/м²','W/m²')}`);text('sunElevation',d.sunElevation>0?L(`${d.sunElevation.toFixed(0)}° над горизонтом`,`${d.sunElevation.toFixed(0)}° above the horizon`):L('ночь','night'))
  text('surfaceReadout',({grass:L('ТРАВА','GRASS'),dry:L('СУХАЯ ПОЧВА','DRY SOIL'),water:L('ВОДА','WATER'),urban:L('ГОРОД','CITY')})[config.surfaceType])
  const b=sim.balance;text('rkw',b?b.ratio.toFixed(1):'—');text('rkwNote',b?`C ${b.c.toFixed(0)} / Δu ${b.deltaU.toFixed(0)}${MS}`:L('купола нет','no cold pool'));const card=document.querySelector<HTMLElement>('#rkwCard')!;card.dataset.base??=card.title;card.title=b?`${card.dataset.base}\n\n${L('Сейчас','Now')}: ${describeBalance(b)}.`:card.dataset.base
  text('time',runTime(sim.time));text('localTime',timeOfDay(config.hour,sim.time));text('threads',String(sim.threads));text('freezing',d.freezing===null?'—':`${d.freezing.toFixed(1)}${KM}`);if(sim.live!==shownLive){shownLive=sim.live;skewt.setLive(shownLive.env,shownLive)}const sampled=timeline.record({t:sim.time,cape:sim.live.indices.sb.cape,cin:sim.live.indices.sb.cin,updraft:d.updraft,uh:d.updraftHelicity,rain:d.rain,rainTotal:d.rainTotal,rotationHeld:sim.model.rotation.persisted,flashes:sim.model.flashes.filter(f=>f.time>sim.time-60).length,gust:d.gust,hail:d.hail});if(frameCount++%20===0){drawSounding();drawHodograph();drawSpin()}if(sampled||frameCount%20===1){const{ctx,w,h}=prepareCanvas('timeline');timeline.draw(ctx,w,h,compare.reference?.points)}updateCells();radar.refresh();const probe=sim.cells.find(selectedCell);skewt.refresh(probe?{id:probe.id,x:probe.x,y:probe.y,u:probe.u+sim.model.frame[0],v:probe.v+sim.model.frame[1]}:null);station.refresh(sim.stations,placingStation);echoMaps.record(sim.model);compare.refresh({name:document.querySelector('#scenarioName')!.textContent||'',config,points:timeline.points,maps:echoMaps.maps,time:sim.time});detector.refresh(sim.model);analysis.refresh(sim.model);satellite.refresh(sim.model);showSpeed();showTornado();zonesPanel.refresh(sim.model);listRewind();markStory();hud.update({time:sim.time,local:timeOfDay(config.hour,sim.time),updraft:d.updraft,rain:d.rain,uh:d.updraftHelicity,mesocyclone:sim.model.rotation.persisted>=MESO_PERSISTENCE,regime:document.querySelector('#cellType')!.textContent??'',running,speed:config.speed,story:storyText(),sky:[d.cloud.split(' — ')[0],rainWord(d.rain)].filter(Boolean).join(' · ')});canvas.style.cursor=placingStation||pickingGround?'crosshair':'';requestAnimationFrame(frame)
}
showDomain()
requestAnimationFrame(frame)
