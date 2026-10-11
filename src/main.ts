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
import { applyTheme, chartPalette, MONO, themeChoice, type ThemeChoice } from './theme'
import { Atmosphere, type Live } from './atmosphere'
import { RadarPanel } from './radar/panel'
import { SkewTPanel } from './skewt/panel'
import { StationPanel } from './station/panel'
import { CELL_STAGES, MESO_PERSISTENCE, UH_ROTATING, readState, createGrid, describeBalance, DT, Environment, parcelIndices, SCENARIOS, type SimConfig, SPIN_SUPERCELL, spinProfile, stormIndices, UH_LAYERS, type UhLayer, weismanKlemp } from './core'
import { type FieldMode, fieldInfo } from './render/fields'
import type { LayerMode } from './render/view'
import { cleanSettings, decodeSettings, download, encodeSettings, toCsv } from './share'
import { applyLayout, askLayout, Hud, isPhone, savedLayout, suggestedLayout } from './hud'
import { Timeline } from './timeline'

// Settings whose change restarts the run (the rest act on the running model): marked ↻ at their label.
const resetKeys = new Set<keyof SimConfig>(['surfaceTemp','lapseLow','lapseMid','lapseUpper','tropopause','stratoWarming','capStrength','capHeight','rhSurface','rhLow','rhMid','rhUpper','moistLayer','wind0','wind05','wind1','wind3','wind6','wind10','windDir0','windDir05','windDir1','windDir3','windDir6','windDir10','latitude','bubble','surfaceType'])
const RESTART = '<span class="field__restart" title="Изменение перезапускает расчёт">↻</span>'

// Markup pieces of the design system (styles/components.css).
const slider = (key: keyof SimConfig, label: string, min: number, max: number, step: number, value: number, unit: string, digits = 0) => `
  <label class="field"><span class="field__head"><span class="field__label">${label}${resetKeys.has(key) ? RESTART : ''}</span><output class="field__value" data-output="${key}"></output></span>
    <input class="range" data-key="${key}" data-unit="${unit}" data-digits="${digits}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"></label>`
/** A collapsible group; `profile` groups are dimmed when the scenario's profile is analytic, `id` ones remember being open. */
const group = (title: string, body: string, o: { count?: number; tag?: string; open?: boolean; profile?: boolean; id?: string; bare?: boolean } = {}) => `
  <details class="group"${o.open ? ' open' : ''}${o.profile ? ' data-profile' : ''}${o.id ? ` data-group="${o.id}"` : ''}><summary><span class="group__title">${title}</span>${o.profile ? '<span class="group__tag" hidden>формулы WK</span>' : ''}${o.count || o.tag ? `<span class="group__count">${o.count ?? o.tag}</span>` : ''}</summary>${o.bare ? body : `<div class="group__body">${body}</div>`}</details>`
const info = (tip: string) => `<button class="info" popovertarget="${tip}" aria-expanded="false" aria-label="Что это">i</button>`
const metric = (id: string, label: string, unit: string, tip?: string, extra = '') =>
  `<div class="metric" data-metric="${id}"><div class="metric__head"><span class="label">${label}</span>${tip ? info(tip) : ''}</div><div class="metric__value"><span class="metric__num" id="${id}">—</span><span class="unit">${unit}</span></div>${extra}</div>`
type PairItem = [id: string, label: string, unit: string, title?: string]
const pair = (...items: PairItem[]) => `<div class="pair">${items.map(([id, label, unit, title]) =>
  `<div${title ? ` title="${title}"` : ''}><span class="label">${label}</span><span class="metric__value"><span class="metric__num" id="${id}">—</span><span class="unit">${unit}</span></span></div>`).join('')}</div>`
const stat = (id: string, label: string, unit: string, title?: string) =>
  `<div class="stat"${title ? ` title="${title}"` : ''}><span>${label}</span><span class="stat__v"><span id="${id}">—</span> <span class="unit">${unit}</span></span></div>`
const tip = (id: string, title: string, text: string, scale = '', foot = '') =>
  `<div id="${id}" popover class="popover"><div class="popover__title">${title}</div><div class="popover__text">${text}</div>${scale}${foot ? `<div class="popover__foot">${foot}</div>` : ''}</div>`

const defaults: SimConfig = {
  surfaceTemp:30,lapseLow:8.4,lapseMid:7.2,lapseUpper:6.5,tropopause:11,stratoWarming:1.2,capHeight:1.5,capStrength:0,moistLayer:0,
  rhSurface:72,rhLow:60,rhMid:42,rhUpper:28,
  wind0:2,wind3:10,wind6:20,wind10:28,windDir0:160,windDir3:185,windDir6:215,windDir10:235,
  latitude:45,turbulence:.55,
  hour:13.5,dayOfYear:80,solarMax:1000,soilMoisture:45,surfaceType:'grass',
  speed:8,seed:42,bubble:1
}
// The scenario note under the buttons ends with the environment's own numbers (standard parcels, MetPy conventions).
const presets = SCENARIOS.map(s => {
  const c: SimConfig = { ...defaults, ...s.values }, grid = createGrid()
  const env = new Environment(c, grid, c.profile === 'weisman-klemp' ? weismanKlemp({ qvMax: .016 }) : undefined), p = parcelIndices(env, grid.height), k = stormIndices(env, p)
  const minus = (v: number) => String(Math.round(v)).replace('-', '−')
  return { ...s, nums: `ML CAPE ${minus(p.ml.cape)} Дж/кг · ML CIN ${minus(p.ml.cin)} · сдвиг 0–6 км ${Math.round(k.shear06)} м/с · SRH 0–1 км ${Math.round(k.srh01)} м²/с²` }
})

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `<div class="app">
  <header class="topbar">
    <span class="logo"><span class="logo__mark"></span>MeteoLab</span>
    <span class="topbar__sep"></span>
    <span class="status" id="statusText">Идёт расчёт</span>
    <span class="topbar__stats"><span>T+<b id="time">00:00</b></span><span title="Потоки расчёта физики"><b id="threads">—</b> потоков</span><span class="faint" id="domainSize">48 × 36 × 19 км</span></span>
    <span class="topbar__spacer"></span>
    <span class="topbar__group"><button class="btn" id="radarOpen" title="Доплеровский радар: отражаемость на выбранном угле наклона луча">Радар <span class="kbd">R</span></button><button class="btn" id="skewOpen" title="Аэрологическая диаграмма Skew-T log-p: профиль среды, частица, CAPE/CIN, ветер и зонд в модели у выбранной ячейки">Skew-T <span class="kbd">S</span></button><button class="btn" id="stationOpen" title="Виртуальная метеостанция: поставьте её щелчком на земле и смотрите метеограмму — температуру, давление, ветер с порывами и осадки, когда гроза проходит над ней">Станция <span class="kbd">M</span></button></span>
    <span class="topbar__sep"></span>
    <button class="btn btn--quiet" id="layoutToggle" title="Телефонный вид: 3D во весь экран, крупные цифры, панель под палец. Выбор запоминается">Телефонный вид</button>
    <div class="seg seg--text" role="group" aria-label="Тема" id="themeSwitch"><button data-theme-set="auto" title="Как в системе">Авто</button><button data-theme-set="light">Светлая</button><button data-theme-set="dark">Тёмная</button></div>
  </header>
  <main class="app__main">
    <aside class="side side--left" aria-label="Обстановка">
      <div class="side__scroll">
        <div class="side__block">
          <h2 class="side__title">Сценарии</h2>
          <div class="scenarios">${presets.map((p, i) => `<button class="btn${p.name.length > 16 ? ' is-wide' : ''}" data-preset="${i}" aria-pressed="false">${p.name}</button>`).join('')}</div>
          <div class="scenario-note" id="scenarioNote">
            <div class="scenario-note__head"><span class="scenario-note__name" id="scenarioName"></span><button class="btn btn--quiet btn--xs" id="scenarioMore">Подробнее</button></div>
            <div class="scenario-note__text" id="scenarioText"></div>
            <div class="scenario-note__nums" id="scenarioNums"></div>
          </div>
          <div class="notice" id="profileLocked" hidden>Профиль задан формулами — ползунки температуры, влажности и ветра не действуют.</div>
        </div>
        ${group('Температурный профиль', `
          ${slider('surfaceTemp','Температура у земли',15,40,.5,30,' °C',1)}
          ${slider('lapseLow','Градиент 0–3 км',3,11,.1,8.4,' K/км',1)}
          ${slider('lapseMid','Градиент 3–8 км',3,11,.1,7.2,' K/км',1)}
          ${slider('lapseUpper','Градиент 8 км–TP',3,11,.1,6.5,' K/км',1)}
          ${slider('tropopause','Тропопауза',8,17,.5,11,' км',1)}
          ${slider('stratoWarming','Стратосферный градиент',-1,4,.1,1.2,' K/км',1)}
          ${slider('capStrength','Задерживающий слой (инверсия)',0,6,.25,0,' K',2)}
          ${slider('capHeight','Высота инверсии',.5,4,.1,1.5,' км',1)}`, { count: 8, open: true, profile: true })}
        ${group('Влажность по слоям', `
          ${slider('rhSurface','У земли',20,100,1,72,' %')}
          ${slider('rhLow','1–3 км',10,100,1,60,' %')}
          ${slider('rhMid','3–7 км',5,100,1,42,' %')}
          ${slider('rhUpper','7 км–TP',5,100,1,28,' %')}
          ${slider('moistLayer','Влажный перемешанный слой',0,2.5,.1,0,' км',1)}`, { count: 5, open: true, profile: true })}
        ${group('Профиль ветра', `
          ${slider('wind0','Ветер у земли',-20,30,1,2,' м/с')}
          ${slider('wind05','Ветер на 0,5 км',-20,35,1,3,' м/с')}
          ${slider('wind1','Ветер на 1 км',-20,40,1,5,' м/с')}
          ${slider('wind3','Ветер на 3 км',-10,45,1,10,' м/с')}
          ${slider('wind6','Ветер на 6 км',-10,60,1,20,' м/с')}
          ${slider('wind10','Ветер на 10 км',-10,75,1,28,' м/с')}
          ${slider('windDir0','Направление у земли',0,360,5,160,'°')}
          ${slider('windDir05','Направление на 0,5 км',0,360,5,165,'°')}
          ${slider('windDir1','Направление на 1 км',0,360,5,170,'°')}
          ${slider('windDir3','Направление на 3 км',0,360,5,185,'°')}
          ${slider('windDir6','Направление на 6 км',0,360,5,215,'°')}
          ${slider('windDir10','Направление на 10 км',0,360,5,235,'°')}`, { count: 12, profile: true })}
        ${group('3D-динамика', `
          ${slider('latitude','Широта / Кориолис',0,75,1,45,'°')}
          ${slider('turbulence','Субсеточная турбулентность',0,2,.05,.55,'×',2)}`, { count: 2 })}
        ${group('Поверхность и радиация', `
          <div class="field"><span class="field__label">Тип поверхности${RESTART}</span><span class="select"><select id="surfaceType"><option value="grass">Трава</option><option value="dry">Сухая почва</option><option value="water">Вода</option><option value="urban">Город</option></select></span></div>
          ${slider('hour','Местное солнечное время',5,21,.25,13.5,' ч',2)}
          ${slider('dayOfYear','День года: 80 — равноденствие, 172 — 21 июня, 355 — 21 декабря',1,365,1,80,'',0)}
          ${slider('solarMax','Солнце в зените',300,1200,25,1000,' Вт/м²')}
          ${slider('soilMoisture','Влажность почвы',0,100,1,45,' %')}`, { count: 5 })}
        ${group('Расчёт', `
          <div class="field" title="Точный перенос (WENO 5-го порядка, по умолчанию) почти не размывает восходящие потоки и сам сохраняет массу воды. Быстрый (полулагранжев) примерно вдвое дешевле, но размывает потоки: в сильном сдвиге термик не стартует"><span class="field__label">Перенос</span><span class="select"><select id="transport"><option value="weno">Точный (WENO5)</option><option value="semi-lagrangian">Быстрый (полулагранжев)</option></select></span></div>
          <label class="check" title="Область сдвигается вместе с грозой (правая ячейка по Банкерсу при сдвиге 0–6 км от 15 м/с, иначе средний ветер 0–6 км): гроза остаётся внутри и не въезжает с другой стороны в собственный холодный отток. Ветер, годограф и радар — относительно земли"><input type="checkbox" id="followStorm" checked> Область движется вместе с грозой${RESTART}</label>
          <div class="field" title="Большая область — 96 × 72 км с тем же шагом: ячейкам просторнее, но расчёт примерно в 4 раза медленнее"><span class="field__label">Размер области${RESTART}</span><span class="select"><select id="domain"><option value="standard">Стандарт — 48 × 36 км</option><option value="large">Большая — 96 × 72 км (в ~4 раза медленнее)</option></select></span></div>
          <div class="field" title="Со льдом (по умолчанию): облачный лёд, снег и крупа (Lin et al. 1983) — наковальня из кристаллов, теплота замерзания, таяние крупы в дождь. Тёплый дождь (Кесслер) — только капли: дешевле, но без наковальни и теплоты замерзания"><span class="field__label">Микрофизика${RESTART}</span><span class="select"><select id="microphysics"><option value="ice">Со льдом — лёд, снег, крупа</option><option value="warm">Тёплый дождь (Кесслер)</option></select></span></div>
          ${slider('speed','Ускорение времени',1,30,1,8,'×')}
          ${slider('bubble','Сила начального термика (0 — без термика)',0,2.5,.05,1,'×',2)}`, { count: 6 })}
        ${group('Что рассчитано, а что нет', `<div class="model-notes">
          <p><b>Рассчитано по уравнениям</b> на сетке ~1,2 км по горизонтали (у земли 100 м по вертикали, выше — растянуто): ветер во всех трёх направлениях, давление (анеластическое приближение), плавучесть с учётом пара и веса капель, перенос тепла, пара, облака и осадков (WENO 5-го порядка), сила Кориолиса. Потоки шире ~6–8 км (5–7 шагов сетки) разрешены хорошо, более узкие сглажены.</p>
          <p><b>Параметризовано</b> — заменено упрощённой формулой, потому что меньше ячейки сетки: турбулентность мельче сетки (Смагоринский, отдельно по горизонтали и вертикали), микрофизика (объёмная: тёплый дождь по Кесслеру, лёд, снег, крупа и град по Лину — каждая частица описана только массой), потоки тепла и пара от поверхности (баланс энергии, трение по шероховатости), солнце (греет только землю; облака его не заслоняют, ночного выхолаживания нет), губка у верха области, периодические края.</p>
          <p><b>Только картинка</b>, в расчёт не входит: мелкие детали облаков (фрактальный шум мельче сетки), частицы дождя и снега, тени облаков на земле. Радар, станция и индексы считаются по полям модели; давление станции — гидростатическая оценка.</p>
        </div>`)}
      </div>
      <div class="side__actions">
        <div class="side__row"><button class="btn btn--primary btn--l" id="restart">Перезапустить</button><button class="btn btn--l" id="pause">Пауза</button></div>
        <button class="btn btn--block" id="share" title="Скопировать ссылку на этот опыт: все настройки и сид, так что по ней откроется тот же расчёт">Ссылка на опыт</button>
        <div class="side__row"><button class="btn" id="saveState" title="Сохранить расчёт в файл .meteolab (все поля модели в этот момент, ~4 МБ): его можно открыть позже и продолжить с того же места">Сохранить</button><button class="btn" id="loadState" title="Открыть сохранённый файл .meteolab и продолжить расчёт с сохранённого момента">Открыть…</button></div>
        <span class="select"><select id="rewind" title="Перемотка назад: состояние запоминается каждые 5 модельных минут (последние ~60 МБ). Выбранная минута — и расчёт идёт оттуда заново; более поздние точки забываются"><option value="">Вернуться к минуте…</option></select></span>
        <input id="stateFile" type="file" accept=".meteolab" hidden>
        <div class="notice" id="stateNote" role="status" hidden><span class="notice__text"></span><button class="notice__close" aria-label="Закрыть">×</button></div>
      </div>
    </aside>

    <section class="workspace">
      <nav class="tabs" role="tablist" aria-label="Отображаемое поле">${([['composite', 'Облака'], ['updraft', 'Вертикальные потоки'], ['theta', 'Температура'], ['moisture', 'Влажность'], ['vorticity', 'Завихренность'], ['helicity', 'Вращение (UH)'], ['coldpool', 'Холодный купол']] as const).map(([f, name]) => `<button class="tab" role="tab" data-field="${f}" aria-selected="${f === 'composite'}"${f === 'helicity' ? ' title="Спиральность восходящего потока: где поднимающийся воздух вращается (слой 2–5 км)"' : ''}>${name}</button>`).join('')}</nav>
      <div class="viewport">
        <canvas id="sim" width="960" height="600"></canvas>
        <div class="cell-labels" id="cellLabels"></div>
        <div class="ov-tl"><button class="ov-toggle" id="flowToggle" aria-pressed="false">Потоки →</button><button class="ov-toggle" id="precipToggle" aria-pressed="false" title="Снежинки выше уровня 0 °C тают в капли по пути вниз">Снег и дождь</button><button class="ov-toggle" id="mesoToggle" aria-pressed="true" title="Кольцо над вращающимся восходящим потоком (UH 2–5 км выше порога вращения)">Мезоциклон</button><button class="ov-toggle" id="swathToggle" aria-pressed="false" title="Сколько дождя выпало на землю с начала расчёта: голубой до 5 мм, зелёный до 10, жёлтый до 25, оранжевый до 50, красный больше">Сумма осадков</button></div>
        <div class="ov-bl"><span class="ov-badge" id="surfaceReadout">ТРАВА</span><span class="ov-chip">ЛКМ — вращение · ПКМ — сдвиг · колесо — масштаб · 2× клик — термик</span></div>
        <div class="ov-br"><div class="ov-legend" id="cloudLegend"><span><i style="--c:#d8e0e3"></i>облачная вода</span><span><i style="--c:#4e7692"></i>осадки</span><span><i style="--c:#b68b59"></i>восходящий</span><span><i style="--c:#7189a5"></i>нисходящий</span></div></div>
        <div class="ov-tr" id="fieldPanel" hidden><div class="field-panel">
          <div class="field-panel__head"><span class="field-panel__title" id="fieldTitle"></span></div>
          <div class="colorbar"><div class="colorbar__bar" id="colorbar"></div><div class="colorbar__ticks"><span id="fieldMin"></span><span id="fieldMid"></span><span id="fieldMax"></span></div></div>
          <div class="field" id="uhLayerRow" hidden title="UH = Σ w·ζ·Δz по слою: насколько поднимающийся воздух вращается. 2–5 км — средний мезоциклон (как в цифрах модели); 0–1 и 0–3 км — нижний, главный признак опасности смерча; весь поток — вращается ли он целиком или только середина"><span class="field__label">Слой вращения</span><span class="select"><select id="uhLayer">${(Object.keys(UH_LAYERS) as UhLayer[]).map(k => `<option value="${k}">${UH_LAYERS[k].label}</option>`).join('')}</select></span></div>
          <label class="field"><span class="field__head"><span class="field__label">Высота горизонтального среза</span><output class="field__value" id="sliceHeightOut">2.0 км</output></span><input class="range" id="sliceHeight" type="range" min="0.1" max="18.5" step="0.1" value="2"></label>
          <label class="field"><span class="field__head"><span class="field__label">Разрез север ↔ юг</span><output class="field__value" id="sliceNorthOut">0 км</output></span><input class="range" id="sliceNorth" type="range" min="-17.5" max="17.5" step="0.5" value="0"></label>
          <div class="field"><span class="field__label">Отображение</span><span class="select"><select id="layerMode"><option value="both">Срезы + объём сильных отклонений</option><option value="slices">Только срезы</option><option value="volume">Только объём (всё поле)</option></select></span></div>
          <div id="volumeControls" hidden>
            <label class="field"><span class="field__head"><span class="field__label">Порог прозрачности</span><output class="field__value" id="volumeThresholdOut">10 %</output></span><input class="range" id="volumeThreshold" type="range" min="0" max="0.8" step="0.02" value="0.1"></label>
            <label class="field"><span class="field__head"><span class="field__label">Плотность объёма</span><output class="field__value" id="volumeDensityOut">1.0×</output></span><input class="range" id="volumeDensity" type="range" min="0.2" max="4" step="0.1" value="1"></label>
          </div>
        </div></div>
      </div>
      <div class="readout"><span>Сетка <b id="gridSize">40 × 32 × 50</b></span><span>Δx / Δy <b>1.2 / 1.1 км</b></span><span>Δz <b>0.1 → 1 км</b></span><span>Δt <b>${DT} с</b></span><span>Область <b id="frameMotion">—</b></span><span>Инсоляция <b id="sun">—</b></span><span>Солнце <b id="sunElevation">—</b></span></div>
    </section>

    <aside class="side side--right diagnostics" aria-label="Данные"><div class="diag">
      <section class="mode" id="modeCard"><div class="mode__head"><span class="label">Режим грозы</span><span class="badge" id="mesoBadge" hidden>мезоциклон</span></div><div class="mode__title" id="cellType">—</div><div class="mode__reason" id="cellReason">ожидание инициализации</div><div class="mode__cell" id="cellStage"></div></section>
      <section class="cells"><div class="cells__head"><span class="label" id="cellCount">Ячейки</span><button class="btn btn--quiet btn--s" id="cellAll" aria-pressed="true" title="Показатели по всей области: максимумы по всем ячейкам">Вся область</button></div><div class="cells__list" id="cellList"></div></section>
      <section class="chart"><div class="diag__scope"><span class="label" id="metricScope">Показатели по всей области</span></div>
        <div class="metrics">
          ${metric('updraft', 'Восх. поток, макс.', 'м/с')}
          ${metric('uh', 'Вращение UH 2–5 км', 'м²/с²', 'tip-uh')}
          ${metric('rain', 'Интенсивность дождя', 'мм/ч', 'tip-rain')}
          ${metric('rainTotal', 'Сумма осадков, макс.', 'мм', 'tip-rainTotal')}
          ${metric('gust', 'Порыв у земли', 'м/с', 'tip-gust')}
          ${metric('hail', 'Град у земли', 'см', 'tip-hail', '<div class="t-caption" id="hailSwath"></div>')}
        </div></section>
      <section class="chart"><div class="chart__head"><span class="chart__title">Ход грозы</span><button class="btn btn--xs" id="timelineCsv" title="Выгрузить ряды «Хода грозы» в CSV (таблица или скрипт): время, CAPE и CIN, поток, UH, дождь">CSV</button></div>
        <canvas id="timeline" title="Ход грозы по модельному времени (вся область, точка каждые 30 с): неустойчивость среды сейчас (CAPE и CIN частицы от земли по живому зондированию — вдали от гроз, раз в модельную минуту), самый сильный восходящий поток, вращение потока и дождь у земли. Перезапуск начинает графики заново"></canvas></section>
      <div class="diag__groups">
        ${group('Индексы неустойчивости', `
          ${pair(['cape', 'CAPE', 'Дж/кг', 'Частица приложения: +0,5 K и вовлечение сухого воздуха (разбавленная CAPE)'], ['cin', 'CIN', 'Дж/кг'])}
          ${pair(['mlcape', 'MLCAPE', 'Дж/кг', 'Перемешанный слой 100 гПа (стандартная частица, без добавок)'], ['mlcin', 'MLCIN', 'Дж/кг', 'CIN частицы перемешанного слоя'])}
          ${pair(['mucape', 'MUCAPE', 'Дж/кг', 'Наиболее неустойчивая частица в нижних 300 гПа'], ['dcape', 'DCAPE', 'Дж/кг', 'Энергия нисходящего потока: сила холодных оттоков и микропорывов'])}
          ${pair(['srh01', 'SRH 0–1 км', 'м²/с²', 'Спиральность относительно правой ячейки (движение по Банкерсу), слой 0–1 км: главный признак смерчеопасной среды'], ['srh03', 'SRH 0–3 км', 'м²/с²', 'Спиральность относительно правой ячейки, слой 0–3 км'])}
          ${pair(['scp', 'SCP', '', 'Сложный параметр суперячейки (MUCAPE, SRH 0–3 км, сдвиг 0–6 км). Больше 1 — среда благоприятна для суперячеек'], ['stp', 'STP', '', 'Параметр значимого смерча, фиксированный слой (SBCAPE, LCL, SRH 0–1 км, сдвиг 0–6 км). Больше 1 — благоприятно для сильных смерчей'])}`, { count: 10, id: 'indices' })}
        ${group('Среда: зондирование и уровни', `
          <canvas id="sounding" class="side-chart"></canvas>
          <div class="legend"><span><i style="--c:#4f7180"></i>среда</span><span><i class="dash" style="--c:#5a9a6a"></i>точка росы</span><span><i style="--c:#b46e43"></i>частица</span><span><i class="area" style="--c:rgba(207,109,73,.55)"></i>CAPE</span><span><i class="area" style="--c:rgba(77,134,179,.5)"></i>CIN</span></div>
          <dl class="kv"><dt>LCL</dt><dd id="lcl">—</dd><dt>LFC</dt><dd id="lfc">—</dd><dt>EL</dt><dd id="el">—</dd><dt>0 °C</dt><dd id="freezing">—</dd></dl>`, { tag: 'Skew-T', id: 'sounding' })}
        ${group('Ветер: годограф и сдвиг', `
          <canvas id="hodograph" class="side-chart side-chart--square"></canvas>
          <div class="legend"><span><i style="--c:#c4553a"></i>0–3 км</span><span><i style="--c:#4f8f5b"></i>3–6 км</span><span><i style="--c:#3f6fa3"></i>6–10 км</span></div>
          <div><div class="stat"><span>Сдвиг ветра 0–6 км</span><span class="stat__v" id="shear">—</span></div><div class="t-caption" id="shearHint"></div></div>`, { id: 'hodograph' })}
        ${group('Все показатели грозы', `<div>
          ${stat('downdraft', 'Макс. нисходящий поток', 'м/с')}
          ${stat('uhLow', 'Низкое вращение (UH 0–1 / 0–3 км)', 'м²/с²', 'Вращение восходящего потока у земли: низкоуровневый мезоциклон — признак ячейки, опасной по смерчам. На сетке ~0,65 км слой 0–1 км — один уровень, 0–3 км — четыре')}
          <div class="chart" title="Профиль w·ζ по высоте в ядре с наибольшим UH (среднее по 3×3 столбцам): на какой высоте и как глубоко вращается восходящий поток. Ниже — корреляция w и ζ по всей области на 2–6 км: в суперячейке поток и циклоническое вращение совпадают (на сетке ~1 км у WK 0,15–0,25), в обычной грозе они рядом, а не вместе (около 0)"><span class="chart__sub">Вращение по высоте (ядро с макс. UH)</span><canvas id="spin"></canvas><span class="t-caption" id="spinNote">—</span></div>
          ${stat('cloudTop', 'Вершина облака', 'км')}
          ${stat('thermalTop', 'Вершина термика', 'км')}
          ${stat('cloudWater', 'Макс. облачная вода', 'г/кг')}
          ${stat('coldPool', 'Холодный купол Δθ', 'K')}
          <div class="stat" id="rkwCard" title="Критерий RKW (Rotunno, Klemp, Weisman 1988): скорость растекания холодного купола C = √(2∫(−B)dz) против разности ветра среды 0–2,5 км Δu. Около 1 — поток у фронта порывов стоит прямо, новые ячейки растут на нём (долгоживущие линии); больше — купол убегает вперёд, ячейки заваливаются над оттоком; меньше — сдвиг наклоняет ячейки, купол слишком слаб"><span>Купол / сдвиг 0–2,5 км (RKW)</span><span class="stat__v"><span id="rkw">—</span> <span class="unit" id="rkwNote">C/Δu</span></span></div>
          ${stat('clipped', 'Срабатывания ограничителей', 'с начала', 'Сколько раз скорость упёрлась в предохранитель (|u|,|v| ≤ 120, |w| ≤ 100 м/с — заметно выше любых реальных гроз). Не ноль — расчёт пошёл вразнос, цифрам доверять нельзя.')}
        </div>`, { count: 9, id: 'all' })}
        ${group('Что происходит', `<p class="diag__logic" id="logicText">Частица ещё не достигла уровня свободной конвекции.</p>`, { open: true, id: 'logic', bare: true })}
      </div>
    </div>
    ${tip('tip-uh', 'Вращение потока, UH 2–5 км', 'Спиральность восходящего потока: насколько поднимающийся воздух вращается циклонически в слое 2–5 км.', `<dl class="popover__scale"><dt>≥ ${UH_ROTATING}</dt><dd>поток вращается (подсветка в 3D)</dd></dl>`, `Мезоциклон решается не по UH, а по вращению ядра потока: завихренность на 2–5 км ≥ 3·10⁻³ с⁻¹ в течение ${MESO_PERSISTENCE / 60} мин.`)}
    ${tip('tip-rain', 'Интенсивность дождя', 'Самый сильный дождь у земли сейчас: поток ρ·q_r·V_t.')}
    ${tip('tip-rainTotal', 'Сумма осадков, макс.', 'Наибольшая сумма дождя на земле с начала расчёта.')}
    ${tip('tip-gust', 'Порыв у земли', 'Самый сильный ветер на высоте 100 м: оттоки и микропорывы под грозой.')}
    ${tip('tip-hail', 'Град у земли', 'Крупнейшие градины, долетевшие до земли сейчас; ниже — крупнейшие за весь прогон.')}
    </aside>
  </main>
</div>
<dialog class="modal" id="saveDialog"><form method="dialog" style="display:contents"><h2 class="modal__title">Сохранить расчёт</h2><p class="modal__text" id="saveText"></p><label class="field"><span class="label">Имя файла</span><input class="input" id="saveName" autocomplete="off" spellcheck="false"></label><div class="modal__actions"><button class="btn btn--quiet" value="cancel">Отмена</button><button class="btn btn--primary" value="save">Сохранить</button></div></form></dialog>`

const text = (id: string, value: string) => { document.querySelector(`#${id}`)!.textContent = value }
// The page opens on the first scenario ("Летний день"); the controls are synced to it below.
// The layout before the physics starts (its thread count depends on it): the remembered choice, else the screen's
// suggestion, with the question shown at the first visit.
applyLayout(savedLayout() ?? suggestedLayout(), false)
if (!savedLayout()) askLayout()
document.querySelector('#layoutToggle')!.addEventListener('click', () => applyLayout(isPhone() ? 'desktop' : 'phone'))
// Theme: Авто (the system's) / Светлая / Тёмная in the header.
const themeSwitch = document.querySelector<HTMLElement>('#themeSwitch')!, showThemeChoice = () => themeSwitch.querySelectorAll<HTMLButtonElement>('[data-theme-set]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeSet === themeChoice())))
themeSwitch.addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-theme-set]'); if (b) applyTheme(b.dataset.themeSet as ThemeChoice) })
addEventListener('themechange', showThemeChoice); showThemeChoice()
// The side charts redraw every 20 frames; a new theme, or a group opened, repaints them at once.
const drawCharts = () => { drawSounding(); drawHodograph(); drawSpin(); const { ctx, w, h } = prepareCanvas('timeline'); timeline.draw(ctx, w, h) }
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
  if (left < 8) { left = Math.min(r.left, innerWidth - w - 8); top = r.bottom + 8 }
  Object.assign(pop.style, { position: 'fixed', left: `${left}px`, top: `${Math.max(8, Math.min(top, innerHeight - h - 8))}px` })
}))
// R, S, M open and close the instruments (not while typing, not with a modifier).
addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('input:not([type=range]):not([type=checkbox]), select, textarea, dialog')) return
  const target = ({ KeyR: '#radarOpen', KeyS: '#skewOpen', KeyM: '#stationOpen' } as Record<string, string>)[e.code]
  if (target) { e.preventDefault(); document.querySelector<HTMLButtonElement>(target)!.click() }
})
const config: SimConfig = { ...defaults, ...SCENARIOS[0].values }
// A shared link (?cfg=..., see share.ts) brings its scenario and settings; it is applied once and leaves the address.
let initialPreset: number | null = 0, baseScenario: number | null = 0
{
  const url = new URL(location.href), shared = url.searchParams.get('cfg'), link = shared === null ? null : decodeSettings(shared, SCENARIOS.map(s => s.name))
  if (link) {
    Object.assign(config, defaults, link.scenario === null ? {} : SCENARIOS[link.scenario].values, link.values)
    baseScenario = link.scenario; initialPreset = Object.keys(link.values).length ? null : link.scenario
  }
  if (shared !== null) { url.searchParams.delete('cfg'); history.replaceState(null, '', url) }
}
// Scenarios without the 0.5 and 1 km wind nodes get them on the straight 0-3 km line, so their hodograph is unchanged
// and the sliders show where the nodes are.
const fillLowWind = (c: SimConfig) => {
  const along = (a: number, b: number, t: number) => a + (b - a) * t, turn = (a: number, b: number, t: number) => ((a + (((b - a + 540) % 360) - 180) * t) % 360 + 360) % 360
  c.wind05 ??= along(c.wind0, c.wind3, 1 / 6); c.wind1 ??= along(c.wind0, c.wind3, 1 / 3)
  c.windDir05 ??= turn(c.windDir0, c.windDir3, 1 / 6); c.windDir1 ??= turn(c.windDir0, c.windDir3, 1 / 3)
}
fillLowWind(config)
// Every start, restart and scenario gets a fresh random seed, so no two runs give the same storm. The seed is not shown,
// only kept in the address (?seed=...), so opening that link repeats the first run of the page.
const urlSeed = Number(new URLSearchParams(location.search).get('seed'))
const nextSeed = () => { const [x] = crypto.getRandomValues(new Uint32Array(1)); return x }
const useSeed = (seed: number) => { config.seed = seed; const url = new URL(location.href); url.searchParams.set('seed', String(seed)); history.replaceState(null, '', url) }
useSeed(Number.isInteger(urlSeed) && urlSeed > 0 ? urlSeed : nextSeed())
const canvas = document.querySelector<HTMLCanvasElement>('#sim')!
const view = { field: 'composite' as FieldMode, uhLayer: '2-5' as UhLayer, showVectors: false, showPrecip: false, showRainTotal: false, showMesocyclone: true, layerMode: 'both' as LayerMode, volumeThreshold: .1, volumeDensity: 1, sliceHeight: 2, sliceNorth: 0 }
let sim = new Atmosphere(canvas, config)
const radar = new RadarPanel(document.body); radar.attach(sim.model, sim.storm.rightMover)
document.querySelector('#radarOpen')!.addEventListener('click', () => radar.toggle())
const skewt = new SkewTPanel(document.body); skewt.attach(sim.model)
const station = new StationPanel(document.body)
/** The next click on the 3D view places the weather station; its ground position survives restarts. */
let placingStation = false, stationGround: { x: number; y: number } | null = null
station.onPlace = place => { placingStation = place; if (!place) { stationGround = null; sim.placeStationAt(null) } }
document.querySelector('#stationOpen')!.addEventListener('click', () => station.toggle())
document.querySelector('#skewOpen')!.addEventListener('click', () => skewt.toggle())
let running = true
let last = performance.now(), frameCount = 0
const recreate = (seed?: number) => { useSeed(seed ?? nextSeed()); sim.dispose(); sim = Object.assign(new Atmosphere(canvas, config), view); radar.attach(sim.model, sim.storm.rightMover); skewt.attach(sim.model); sim.placeStationAt(stationGround); selectCell(null); showDomain() }

const surfaceSelect = document.querySelector<HTMLSelectElement>('#surfaceType')!
const transportSelect = document.querySelector<HTMLSelectElement>('#transport')!
transportSelect.addEventListener('change', () => { config.transport = transportSelect.value as SimConfig['transport'] })
const followCheck = document.querySelector<HTMLInputElement>('#followStorm')!, domainSelect = document.querySelector<HTMLSelectElement>('#domain')!
followCheck.addEventListener('change', () => { config.followStorm = followCheck.checked; recreate() })
domainSelect.addEventListener('change', () => { config.domain = domainSelect.value as SimConfig['domain']; recreate() })
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
  const off = !!config.profile
  document.querySelectorAll<HTMLDetailsElement>('details[data-profile]').forEach(d => { d.classList.toggle('is-inactive', off); d.querySelector<HTMLElement>('.group__tag')!.hidden = !off })
  document.querySelector<HTMLElement>('#profileLocked')!.hidden = !off
}
/** The scenario the settings started from (null: a run opened from a file), as a full config. */
const baseConfig = (): SimConfig => { const base: SimConfig = { ...defaults, ...(baseScenario === null ? {} : SCENARIOS[baseScenario].values) }; fillLowWind(base); return base }
// A dot at a left group whose values differ from the scenario. Speed, the domain and its motion are kept when a
// scenario is chosen: not the scenario's.
const KEPT = new Set<keyof SimConfig>(['speed', 'followStorm', 'domain'])
const SELECTS: [string, keyof SimConfig, string][] = [['#surfaceType', 'surfaceType', 'grass'], ['#transport', 'transport', 'weno'], ['#microphysics', 'microphysics', 'ice']]
function markModified() {
  const base = baseConfig()
  document.querySelectorAll<HTMLDetailsElement>('.side--left details.group').forEach(d => {
    const sliders = [...d.querySelectorAll<HTMLInputElement>('input[data-key]')].some(input => {
      const key = input.dataset.key as keyof SimConfig
      return !KEPT.has(key) && Math.abs(Number(config[key]) - Number(base[key])) > Number(input.step) / 2
    })
    const selects = SELECTS.some(([selector, key, fallback]) => d.querySelector(selector) && (config[key] ?? fallback) !== (base[key] ?? fallback))
    d.classList.toggle('is-modified', sliders || selects)
  })
}
// The note under the scenario buttons: what the scenario shows, cut to four lines until «Подробнее».
const scenarioNote = document.querySelector<HTMLElement>('#scenarioNote')!, scenarioMore = document.querySelector<HTMLButtonElement>('#scenarioMore')!
scenarioMore.addEventListener('click', () => { const open = scenarioNote.classList.toggle('is-open'); scenarioMore.textContent = open ? 'Свернуть' : 'Подробнее' })
function showScenario() {
  const p = baseScenario === null ? null : presets[baseScenario]
  text('scenarioName', p ? p.name : 'Расчёт из файла')
  text('scenarioText', p ? `${p.hint}.` : 'Настройки взяты из сохранённого файла и ни с одним сценарием не сравниваются.')
  text('scenarioNums', p ? p.nums : '')
  scenarioNote.classList.remove('is-open'); scenarioMore.textContent = 'Подробнее'
  // «Подробнее» only when the text is cut.
  requestAnimationFrame(() => { const t = document.querySelector<HTMLElement>('#scenarioText')!; scenarioMore.hidden = t.scrollHeight <= t.clientHeight + 1 })
}
const markPreset = (index: number | null) => { document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.preset) === index))); markModified() }
document.querySelectorAll<HTMLInputElement>('input[data-key]').forEach(input => {
  const key = input.dataset.key as keyof SimConfig
  input.addEventListener('input', () => {
    ;(config[key] as number|string) = Number(input.value)
    showOutput(input)
  })
  input.addEventListener('change', () => { if (resetKeys.has(key)) { markPreset(null); recreate() } else markModified() })
})
surfaceSelect.addEventListener('change', () => {
  config.surfaceType = surfaceSelect.value as SimConfig['surfaceType']
  markPreset(null)
  recreate()
})
document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => button.addEventListener('click', () => {
  const index = Number(button.dataset.preset)
  Object.assign(config, defaults, { speed: config.speed, followStorm: config.followStorm, domain: config.domain, wind05: undefined, wind1: undefined, windDir05: undefined, windDir1: undefined, profile: undefined, bubbleRadius: undefined, front: undefined, edges: undefined, start: undefined, frameMotion: undefined, top: undefined, nightInversion: undefined, transport: 'weno' }, presets[index].values)
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
  followCheck.checked = config.followStorm !== false; domainSelect.value = config.domain ?? 'standard'
  markProfileGroups(); markModified()
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
document.querySelector('#share')!.addEventListener('click', () => {
  // Relative to the scenario last chosen (changed sliders unmark it but it is still the starting point).
  const url = new URL(location.href)
  url.searchParams.set('cfg', encodeSettings(config, baseConfig(), baseScenario === null ? null : SCENARIOS[baseScenario].name)); url.searchParams.set('seed', String(config.seed))
  navigator.clipboard.writeText(url.href).then(() => note('Ссылка на опыт скопирована', true), () => { history.replaceState(null, '', url); note('Ссылка на опыт — в адресной строке') })
})
// Saving and opening a run (.meteolab, src/core/state.ts). The state is taken when «Сохранить» is pressed; the dialog
// only names the file. The file's settings are outside input: only the known ones are read back.
const saveDialog = document.querySelector<HTMLDialogElement>('#saveDialog')!, saveName = document.querySelector<HTMLInputElement>('#saveName')!
let saved: { data: ArrayBuffer; time: number } | null = null
const clock = (seconds: number) => { const s = Math.floor(seconds); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
document.querySelector('#saveState')!.addEventListener('click', () => {
  saved = { data: sim.saveState(), time: sim.time }
  const name = baseScenario === null ? 'MeteoLab' : SCENARIOS[baseScenario].name
  text('saveText', `Файл .meteolab (~${Math.max(1, Math.round(saved.data.byteLength / 2 ** 20))} МБ): все поля модели на T+${clock(saved.time)} и настройки — расчёт продолжится с того же места через «Открыть…». Имя уже подставлено, менять не обязательно.`)
  saveName.value = `${name}${baseScenario !== null && markedModified() ? ' (изменён)' : ''}, T+${Math.floor(saved.time / 60)}.meteolab`
  saveDialog.showModal(); saveName.select()
})
const markedModified = () => !!document.querySelector('.side--left details.is-modified')
saveDialog.addEventListener('close', () => {
  if (saveDialog.returnValue === 'save' && saved) {
    const name = (saveName.value.trim() || 'meteolab').replace(/[\\/:*?"<>|]/g, '-'), file = name.endsWith('.meteolab') ? name : `${name}.meteolab`
    const url = URL.createObjectURL(new Blob([saved.data], { type: 'application/octet-stream' })), a = document.createElement('a')
    a.href = url; a.download = file; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    note(`Сохранено: ${Math.floor(saved.time / 60)}-я минута расчёта`, true)
  }
  saved = null; saveDialog.returnValue = ''
})
document.querySelector('#loadState')!.addEventListener('click', () => stateFile.click())
// Rewind: the points the Atmosphere keeps, refreshed when their number changes.
const rewindSelect = document.querySelector<HTMLSelectElement>('#rewind')!
let rewindKey = ''
const listRewind = () => {
  const key = sim.history.map(h => h.time).join(',')
  if (key === rewindKey) return
  rewindKey = key
  rewindSelect.innerHTML = '<option value="">Вернуться к минуте…</option>' + sim.history.map(h => `<option value="${h.time}">${Math.floor(h.time / 60)}-я минута${h.time === 0 ? ' (начало)' : ''}</option>`).join('')
}
rewindSelect.addEventListener('change', () => {
  const time = Number(rewindSelect.value)
  if (rewindSelect.value === '') return
  sim.rewind(time); timeline.truncate(time); rewindSelect.value = ''; running = true; updatePause()
  note(`Расчёт вернулся к ${Math.floor(time / 60)}-й минуте`)
})
stateFile.addEventListener('change', async () => {
  const file = stateFile.files?.[0]; stateFile.value = ''
  if (!file) return
  try {
    const buffer = await file.arrayBuffer(), state = readState(buffer)
    Object.assign(config, defaults, { wind05: undefined, wind1: undefined, windDir05: undefined, windDir1: undefined, profile: undefined, bubbleRadius: undefined, front: undefined, edges: undefined, start: undefined, frameMotion: undefined, top: undefined, nightInversion: undefined }, cleanSettings(state.header.config))
    fillLowWind(config); baseScenario = null; syncControls(); markPreset(null); showScenario()
    // The file's seed: the surface pattern under the domain comes from it and is not in the file.
    recreate(config.seed)
    timeline.points.length = 0
    sim.loadState(state, buffer); running = true; updatePause()
    note(`Открыт расчёт · с ${Math.floor(state.header.time / 60)}-й минуты`)
  } catch (error) { note(`Не удалось открыть: ${(error as Error).message}`) }
})
document.querySelector('#timelineCsv')!.addEventListener('click', () => download(`meteolab-hod-grozy-seed${config.seed}.csv`, toCsv(timeline.points, [
  ['time_s', p => p.t], ['sb_cape_jkg', p => p.cape], ['sb_cin_jkg', p => p.cin], ['max_updraft_ms', p => p.updraft], ['uh_2_5km_m2s2', p => p.uh],
  ['rain_rate_mmh', p => p.rain], ['rain_total_mm', p => p.rainTotal], ['core_rotation_held_s', p => p.rotationHeld],
])))
document.querySelector('#pause')!.addEventListener('click', () => { running = !running; updatePause() })
const updatePause = () => {
  document.querySelector('#pause')!.textContent = running ? 'Пауза' : 'Продолжить'
  const status = document.querySelector<HTMLElement>('#statusText')!
  status.textContent = running ? 'Идёт расчёт' : 'Пауза'; status.classList.toggle('is-paused', !running)
}
const setView = (patch: Partial<typeof view>) => { Object.assign(view, patch); Object.assign(sim, patch) }
const fieldPanel = document.querySelector<HTMLDivElement>('#fieldPanel')!
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
for (const [id, key] of [['#flowToggle', 'showVectors'], ['#mesoToggle', 'showMesocyclone'], ['#swathToggle', 'showRainTotal'], ['#precipToggle', 'showPrecip']] as const)
  document.querySelector<HTMLButtonElement>(id)!.addEventListener('click', event => { setView({ [key]: !view[key] }); (event.currentTarget as HTMLElement).setAttribute('aria-pressed', String(view[key])) })
const sliceHeight = document.querySelector<HTMLInputElement>('#sliceHeight')!, sliceNorth = document.querySelector<HTMLInputElement>('#sliceNorth')!
sliceHeight.addEventListener('input', () => { setView({ sliceHeight: Number(sliceHeight.value) }); text('sliceHeightOut', `${Number(sliceHeight.value).toFixed(1)} км`) })
sliceNorth.addEventListener('input', () => {
  const km = Number(sliceNorth.value)
  setView({ sliceNorth: km }); text('sliceNorthOut', km === 0 ? '0 км' : `${Math.abs(km)} км ${km > 0 ? 'к северу' : 'к югу'}`)
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
  if (placingStation) { placingStation = false; stationGround = sim.placeStation(nx, ny); station.toggle(true); return }
  const g = sim.groundPoint(nx, ny), cell = sim.cells.nearest(g.x, g.y, sim.model)
  if (cell) selectCell(cell.id)
})
document.querySelector('#cellAll')!.addEventListener('click', () => selectCell(null))
document.querySelector('#cellList')!.addEventListener('click', event => { const b = (event.target as HTMLElement).closest<HTMLElement>('[data-cell]'); if (b) selectCell(Number(b.dataset.cell)) })
const cellLabels = document.querySelector<HTMLDivElement>('#cellLabels')!
cellLabels.addEventListener('click', event => { const b = (event.target as HTMLElement).closest<HTMLElement>('[data-cell]'); if (b) selectCell(Number(b.dataset.cell)) })
const COMPASS = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ']
const heading = (u: number, v: number) => COMPASS[Math.round(((Math.atan2(u, v) * 180 / Math.PI + 360) % 360) / 45) % 8]
const ORIGIN = { thermal: 'возникла из термика', split: 'отделилась при расщеплении', 'gust-front': 'возникла на фронте порывов' } as const
/** Cell list, labels over the 3D view, the selection ring and, for a selected cell, its own numbers in the panel. */
function updateCells() {
  const tracker = sim.cells
  if (selectedCell !== null && !tracker.find(selectedCell)) {
    // The selected cell merged into another (follow it there) or decayed (back to the whole domain).
    const end = tracker.ended.find(e => e.id === selectedCell)
    if (end?.into) { const from = selectedCell; selectCell(end.into); cellNote = `№${from} слилась с №${end.into}` }
    else { const from = selectedCell; selectCell(null); cellNote = `ячейка №${from} распалась` }
  }
  const cell = tracker.find(selectedCell)
  sim.setSelection(cell ? { x: cell.x, y: cell.y } : null)
  // The list is rebuilt when cells or stages change; the updraughts are written into it every frame.
  const cumulus = tracker.unnumbered, key = tracker.cells.map(c => `${c.id}:${c.stage}:${cellDot(c)}`).join() + `|${selectedCell}|${cumulus}`
  if (key !== cellListKey) {
    cellListKey = key
    document.querySelector('#cellList')!.innerHTML = (tracker.cells.length
      ? tracker.cells.map(c => `<button class="cell" data-cell="${c.id}" aria-pressed="${c.id === selectedCell}" title="${CELL_STAGES[c.stage].hint}"><span class="cell__id">№${c.id}</span><span class="cell__kind"><span class="dot${cellDot(c)}"></span>${CELL_STAGES[c.stage].name}</span><span class="cell__val"><span data-cell-w></span> <span class="unit">м/с</span></span></button>`).join('')
      : '<div class="cells__empty">Ячеек пока нет. Щелчок по ячейке на 3D-виде или в списке закрепляет за ней показатели ниже</div>')
      + (cumulus ? `<div class="cells__more" title="Восходящие ядра, ещё не ставшие грозой: номер получает ядро, чей поток поднялся выше 6 км и окреп до 10 м/с">+ ${cumulus} кучевых без номера</div>` : '')
    document.querySelector('#cellAll')!.setAttribute('aria-pressed', String(selectedCell === null))
    text('cellCount', tracker.cells.length ? `Ячейки · ${tracker.cells.length}` : 'Ячейки')
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
  text('metricScope', cell ? `Показатели ячейки №${cell.id}${cellNote ? ` (${cellNote})` : ''}` : `Показатели по всей области${cellNote ? ` (${cellNote})` : ''}`)
  const stage = document.querySelector<HTMLElement>('#cellStage')!
  if (!cell) {
    // The whole domain: the strongest cell's stage under the storm mode.
    const top = tracker.cells.reduce<typeof tracker.cells[number] | null>((a, b) => !a || b.stats.updraft > a.stats.updraft ? b : a, null)
    const html = top ? `сильнейшая — <span class="num">№${top.id}</span> · ${CELL_STAGES[top.stage].name}<small>${CELL_STAGES[top.stage].hint}</small>` : ''
    if (stage.innerHTML !== html) stage.innerHTML = html
    return
  }
  // Motion only once the centre has been followed for 2 min since the last split or merger (before that it jumps about).
  // The tracker follows cells in the domain's frame; over the ground they also move with the domain.
  const [fu, fv] = sim.model.frame, gu = cell.u + fu, gv = cell.v + fv
  const s = cell.stats, age = Math.floor((sim.time - cell.born) / 60), speed = Math.hypot(gu, gv), followed = cell.trail[cell.trail.length - 1].t - cell.trail[0].t >= 120
  const html = `<span class="num">№${cell.id}</span> · ${CELL_STAGES[cell.stage].name}<small>${CELL_STAGES[cell.stage].hint}. Возраст ${age} мин, ${ORIGIN[cell.origin]}${cell.parent ? ` (от №${cell.parent})` : ''}; ${!followed ? 'движение уточняется' : speed < 1 ? 'почти стоит' : `движется на ${heading(gu, gv)}, ${speed.toFixed(0)} м/с`}</small>`
  if (stage.innerHTML !== html) stage.innerHTML = html
  text('updraft', s.updraft.toFixed(1)); text('downdraft', s.downdraft.toFixed(1)); text('uh', s.uh.toFixed(0)); text('uhLow', `${s.uh01.toFixed(0)} / ${s.uh03.toFixed(0)}`)
  text('cloudTop', s.cloudTop.toFixed(1)); text('coldPool', s.coldPool.toFixed(1)); text('rain', s.rainRate.toFixed(1))
}
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
/** Domain size and grid in the header and footer, and how fast the domain moves with the storm. */
function showDomain() {
  const { nx, ny, nz, width, depth, height } = sim.model.grid, [fu, fv] = sim.model.frame, speed = Math.hypot(fu, fv)
  text('domainSize', `${width / 1000} × ${depth / 1000} × ${Math.round(height / 1000)} км`); text('gridSize', `${nx} × ${ny} × ${nz}`)
  text('frameMotion', speed < .1 ? 'неподвижна' : `движется на ${heading(fu, fv)}, ${speed.toFixed(1)} м/с`)
}
canvas.addEventListener('dblclick', event => { const r=canvas.getBoundingClientRect(); sim.perturb((event.clientX-r.left)/r.width,(event.clientY-r.top)/r.height,1.25) })

const prepareCanvas = (id: string) => {
  const c = document.querySelector<HTMLCanvasElement>(`#${id}`)!, dpr = Math.min(devicePixelRatio, 2), w = c.clientWidth, h = c.clientHeight
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
  const ctx = c.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); ctx.font = `11px ${MONO}`
  return { ctx, w, h }
}
const T_MIN = -75, T_MAX = 45, Z_MAX = 18
function drawSounding(){
  const { ctx, w, h } = prepareCanvas('sounding'), s = sim.sounding()
  const L = 22, R = w - 30, T = 6, B = h - 14
  const X = (t: number) => L + (t - T_MIN) / (T_MAX - T_MIN) * (R - L), Y = (z: number) => T + (1 - z / Z_MAX) * (B - T)
  const c = chartPalette()
  ctx.strokeStyle = c.grid; ctx.lineWidth = 1; ctx.fillStyle = c.label
  for (let z = 0; z <= Z_MAX; z += 5) { ctx.beginPath(); ctx.moveTo(L, Y(z)); ctx.lineTo(R, Y(z)); ctx.stroke(); ctx.fillText(`${z}`, 4, Y(z) + 3) }
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
    ctx.beginPath(); s.profile.forEach((p, i) => { const x = Math.max(L, X(value(p))), y = Y(p.z); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) })
    ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([])
  }
  curve(p => p.dew, '#5a9a6a', [4, 3]); curve(p => p.env, '#4f7180'); curve(p => p.parcel, '#b46e43')
  const levels: [string, number | null, string][] = [['LCL', s.lcl, '#6f9fb0'], ['LFC', s.lfc, '#c39a4f'], ['EL', s.el, '#c0735b']]
  for (const [name, z, color] of levels) {
    if (z === null) continue
    ctx.strokeStyle = color; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(L, Y(z)); ctx.lineTo(R, Y(z)); ctx.stroke(); ctx.setLineDash([])
    ctx.fillStyle = color; ctx.fillText(name, R + 3, Y(z) + 3)
  }
}
/** The rotation profile of the most rotating core (spin.ts) and the w-ζ correlation. */
function drawSpin(){
  const { ctx, w, h } = prepareCanvas('spin'), p = spinProfile(sim.model), top = 14, L = 22, R = w - 6, T = 4, B = h - 12
  const peak = Math.max(50, ...p.wz), X = (v: number) => L + (R - L) * Math.max(0, v) / peak, Y = (z: number) => B - (B - T) * z / top
  const colors = chartPalette()
  ctx.strokeStyle = colors.grid; ctx.fillStyle = colors.label; ctx.lineWidth = 1
  for (let z = 0; z <= top; z += 2) { ctx.beginPath(); ctx.moveTo(L, Y(z)); ctx.lineTo(R, Y(z)); ctx.stroke(); if (z % 4 === 0) ctx.fillText(`${z}`, 4, Y(z) + 3) }
  ctx.fillText(`w·ζ до ${peak.toFixed(0)}·10⁻³ м/с²`, R - 92, h - 2)
  ctx.fillStyle = 'rgba(123, 63, 160, .55)'
  for (let k = 1; k + 1 < p.z.length && p.z[k] <= top; k++) if (p.wz[k] > 0) ctx.fillRect(L, Y(p.z[k + 1]), X(p.wz[k]) - L, Y(p.z[k]) - Y(p.z[k + 1]))
  const c = p.correlation, layer = p.bottom === null ? 'ядро не вращается' : `ядро вращается ${p.bottom.toFixed(1)}–${p.top!.toFixed(1)} км`
  text('spinNote', c === null ? layer : `${layer}; корреляция w–ζ 2–6 км ${c.toFixed(2)}: ${c >= SPIN_SUPERCELL ? 'поток и вращение совпадают, как в суперячейке' : 'вращение рядом с потоком, не в нём'}`)
}
function drawHodograph(){
  const { ctx, w, h } = prepareCanvas('hodograph'), wind = sim.sounding().wind
  const maxSpeed = Math.max(...wind.map(p => Math.hypot(p.u, p.v))), maxRing = Math.max(20, Math.ceil(maxSpeed / 10) * 10)
  const cx = w / 2, cy = h / 2, scale = (Math.min(w, h) / 2 - 12) / maxRing
  const c = chartPalette()
  ctx.strokeStyle = c.grid; ctx.fillStyle = c.label; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(cx - maxRing * scale, cy); ctx.lineTo(cx + maxRing * scale, cy); ctx.moveTo(cx, cy - maxRing * scale); ctx.lineTo(cx, cy + maxRing * scale); ctx.stroke()
  for (let r = 10; r <= maxRing; r += 10) { ctx.beginPath(); ctx.arc(cx, cy, r * scale, 0, Math.PI * 2); ctx.stroke(); ctx.fillText(`${r}`, cx + r * scale * .71 + 2, cy - r * scale * .71 - 2) }
  ctx.fillText('С', cx + 3, 10); ctx.fillText('В', w - 10, cy - 3)
  const P = (p: { u: number, v: number }) => [cx + p.u * scale, cy - p.v * scale] as const
  // Bunkers right (RM) and left (LM) movers.
  for (const [label, [u, v]] of [['RM', sim.storm.rightMover], ['LM', sim.storm.leftMover]] as const) { const [x, y] = P({ u, v }); ctx.fillStyle = '#7b3fa0'; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.fillText(label, x + 4, y + 9) }
  ctx.fillStyle = c.label
  ctx.lineWidth = 2.2; ctx.lineCap = 'round'
  for (let i = 0; i + 1 < wind.length; i++) {
    const a = wind[i], b = wind[i + 1]
    ctx.strokeStyle = a.z < 3 ? '#c4553a' : a.z < 6 ? '#4f8f5b' : '#3f6fa3'
    ctx.beginPath(); ctx.moveTo(...P(a)); ctx.lineTo(...P(b)); ctx.stroke()
  }
  ctx.fillStyle = c.text
  for (const z of [0, 1, 3, 6, 10]) { const p = wind.find(q => Math.abs(q.z - z) < 1e-6); if (!p) continue; const [x, y] = P(p); ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill(); ctx.fillText(`${z}`, x + 4, y - 3) }
  const w0 = wind[0], w6 = wind.find(p => Math.abs(p.z - 6) < 1e-6)!, shear = Math.hypot(w6.u - w0.u, w6.v - w0.v)
  text('shear', `${shear.toFixed(0)} м/с`)
  text('shearHint', shear < 10 ? 'слабый: одиночные ячейки' : shear < 20 ? 'умеренный: мультиячейки' : 'сильный: возможны суперячейки')
}
const timeline = new Timeline()
// The phone layout's overlay and bottom bar (hud.ts; hidden on a desktop by CSS).
const speedInput = document.querySelector<HTMLInputElement>('input[data-key="speed"]')!
const hud = new Hud(document.querySelector<HTMLElement>('.viewport')!, document.querySelector<HTMLElement>('#app')!, speed => { speedInput.value = String(speed); speedInput.dispatchEvent(new Event('input')) })
/** The live sounding last handed to the Skew-T screen (a new one every LIVE_EVERY s of model time). */
let shownLive: Live | null = null
function frame(now:number){
  const elapsed=Math.min(.2,(now-last)/1000);last=now;if(running)sim.advance(elapsed);sim.render();const d=sim.diagnostics()
  text('cape',d.cape.toFixed(0));text('mlcape',d.indices.ml.cape.toFixed(0));text('mlcin',d.indices.ml.cin.toFixed(0));text('mucape',d.indices.mu.cape.toFixed(0));text('dcape',d.indices.dcape.toFixed(0));text('srh01',d.storm.srh01.toFixed(0));text('srh03',d.storm.srh03.toFixed(0));text('scp',d.storm.scp.toFixed(1));text('stp',d.storm.stp.toFixed(1));text('cin',d.cin.toFixed(0));text('updraft',d.updraft.toFixed(1));text('downdraft',d.downdraft.toFixed(1));text('uh',d.updraftHelicity.toFixed(0));text('uhLow',`${d.uh01.toFixed(0)} / ${d.uh03.toFixed(0)}`);text('cloudTop',d.cloudTop.toFixed(1));text('thermalTop',d.thermalTop.toFixed(1));text('cloudWater',d.cloudWater.toFixed(2));text('coldPool',d.coldPool.toFixed(1));text('gust',d.gust.toFixed(1));text('hail',d.hail>=1?(d.hail/10).toFixed(1):'—');text('hailSwath',d.hailSwath>=1?`за прогон до ${(d.hailSwath/10).toFixed(1)} см`:'');showMode(d.hail>=1);text('clipped',String(d.clipped));text('rain',d.rain.toFixed(1));text('rainTotal',d.rainTotal.toFixed(1));text('lcl',d.lcl===null?'—':`${d.lcl.toFixed(1)} км`);text('lfc',d.lfc===null?'—':`${d.lfc.toFixed(1)} км`);text('el',d.el===null?'—':`${d.el.toFixed(1)} км`);text('cellType',d.cellType);text('cellReason',d.cellReason);text('logicText',d.logic);text('sun',`${d.insolation.toFixed(0)} Вт/м²`);text('sunElevation',d.sunElevation>0?`${d.sunElevation.toFixed(0)}° над горизонтом`:'ночь')
  text('surfaceReadout',({grass:'ТРАВА',dry:'СУХАЯ ПОЧВА',water:'ВОДА',urban:'ГОРОД'} as const)[config.surfaceType])
  const b=sim.balance;text('rkw',b?b.ratio.toFixed(1):'—');text('rkwNote',b?`C ${b.c.toFixed(0)} / Δu ${b.deltaU.toFixed(0)} м/с`:'купола нет');const card=document.querySelector<HTMLElement>('#rkwCard')!;card.dataset.base??=card.title;card.title=b?`${card.dataset.base}\n\nСейчас: ${describeBalance(b)}.`:card.dataset.base
  const sec=Math.floor(sim.time);text('time',`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`);text('threads',String(sim.threads));text('freezing',d.freezing===null?'—':`${d.freezing.toFixed(1)} км`);if(sim.live!==shownLive){shownLive=sim.live;skewt.setLive(shownLive.env,shownLive)}const sampled=timeline.record({t:sim.time,cape:sim.live.indices.sb.cape,cin:sim.live.indices.sb.cin,updraft:d.updraft,uh:d.updraftHelicity,rain:d.rain,rainTotal:d.rainTotal,rotationHeld:sim.model.rotation.persisted});if(frameCount++%20===0){drawSounding();drawHodograph();drawSpin()}if(sampled||frameCount%20===1){const{ctx,w,h}=prepareCanvas('timeline');timeline.draw(ctx,w,h)}updateCells();radar.refresh();const probe=sim.cells.find(selectedCell);skewt.refresh(probe?{id:probe.id,x:probe.x,y:probe.y,u:probe.u+sim.model.frame[0],v:probe.v+sim.model.frame[1]}:null);station.refresh(sim.station,placingStation);listRewind();hud.update({time:sim.time,updraft:d.updraft,rain:d.rain,uh:d.updraftHelicity,mesocyclone:sim.model.rotation.persisted>=MESO_PERSISTENCE,regime:document.querySelector('#cellType')!.textContent??'',running,speed:config.speed});canvas.style.cursor=placingStation?'crosshair':'';requestAnimationFrame(frame)
}
showDomain()
requestAnimationFrame(frame)
