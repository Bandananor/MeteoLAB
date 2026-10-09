import './style.css'
import { Atmosphere } from './atmosphere'
import { RadarPanel } from './radar/panel'
import { CELL_STAGES, createGrid, DT, Environment, parcelIndices, SCENARIOS, type SimConfig, stormIndices, weismanKlemp } from './core'
import { FIELDS, type FieldMode } from './render/fields'
import type { LayerMode } from './render/view'
import { Timeline } from './timeline'

const slider = (key: keyof SimConfig, label: string, min: number, max: number, step: number, value: number, suffix: string, digits = 0) => `
  <label>${label}<output data-output="${key}">${value.toFixed(digits)}${suffix}</output>
    <input data-key="${key}" data-suffix="${suffix}" data-digits="${digits}" type="range" min="${min}" max="${max}" step="${step}" value="${value}">
  </label>`

const defaults: SimConfig = {
  surfaceTemp:30,lapseLow:8.4,lapseMid:7.2,lapseUpper:6.5,tropopause:11,stratoWarming:1.2,capHeight:1.5,capStrength:0,moistLayer:0,
  rhSurface:72,rhLow:60,rhMid:42,rhUpper:28,
  wind0:2,wind3:10,wind6:20,wind10:28,windDir0:160,windDir3:185,windDir6:215,windDir10:235,
  latitude:45,turbulence:.55,
  hour:13.5,solarMax:1000,soilMoisture:45,surfaceType:'grass',
  speed:8,seed:42,bubble:1
}
// Scenario button tooltips end with the environment's own numbers (standard parcels, MetPy conventions).
const presets = SCENARIOS.map(s => {
  const c: SimConfig = { ...defaults, ...s.values }, grid = createGrid()
  const env = new Environment(c, grid, c.profile === 'weisman-klemp' ? weismanKlemp({ qvMax: .016 }) : undefined), p = parcelIndices(env, grid.height), k = stormIndices(env, p)
  return { ...s, hint: `${s.hint}.\nML CAPE ${Math.round(p.ml.cape)} Дж/кг, ML CIN ${Math.round(p.ml.cin)} Дж/кг, сдвиг 0–6 км ${Math.round(k.shear06)} м/с, SRH 0–1 км ${Math.round(k.srh01)} м²/с²` }
})

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header>
    <div><span class="eyebrow">ЧИСЛЕННАЯ ЛАБОРАТОРИЯ АТМОСФЕРЫ / 1.0 3D</span><h1>StormLab</h1></div>
    <div class="header-stats"><span>3D non-hydrostatic</span><span id="domainSize">48 × 36 × 19 км</span><button id="radarOpen" class="radar-open" title="Доплеровский радар: отражаемость на выбранном угле наклона луча">◉ Радар</button><div class="status"><i></i><span id="statusText">РАСЧЁТ ИДЁТ</span></div></div>
  </header>
  <main>
    <aside class="controls">
      <div class="presets"><h2>Сценарии</h2><div class="preset-grid">${presets.map((p,i)=>`<button class="secondary" data-preset="${i}" title="${p.hint}">${p.name}</button>`).join('')}</div></div>
      <details open><summary>Температурный профиль</summary><div class="group">
        ${slider('surfaceTemp','Температура у земли',15,40,.5,30,' °C',1)}
        ${slider('lapseLow','Градиент 0–3 км',3,11,.1,8.4,' K/км',1)}
        ${slider('lapseMid','Градиент 3–8 км',3,11,.1,7.2,' K/км',1)}
        ${slider('lapseUpper','Градиент 8 км–TP',3,11,.1,6.5,' K/км',1)}
        ${slider('tropopause','Тропопауза',8,14,.5,11,' км',1)}
        ${slider('stratoWarming','Стратосферный градиент',-1,4,.1,1.2,' K/км',1)}
        ${slider('capStrength','Задерживающий слой (инверсия)',0,6,.25,0,' K',2)}
        ${slider('capHeight','Высота инверсии',.5,4,.1,1.5,' км',1)}
      </div></details>
      <details open><summary>Влажность по слоям</summary><div class="group">
        ${slider('rhSurface','У земли',20,100,1,72,' %')}
        ${slider('rhLow','1–3 км',10,100,1,60,' %')}
        ${slider('rhMid','3–7 км',5,100,1,42,' %')}
        ${slider('rhUpper','7 км–TP',5,100,1,28,' %')}
        ${slider('moistLayer','Влажный перемешанный слой',0,2.5,.1,0,' км',1)}
      </div></details>
      <details><summary>Профиль ветра</summary><div class="group">
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
        ${slider('windDir10','Направление на 10 км',0,360,5,235,'°')}
      </div></details>
      <details><summary>3D-динамика</summary><div class="group">
        ${slider('latitude','Широта / Кориолис',0,75,1,45,'°')}
        ${slider('turbulence','Субсеточная турбулентность',0,2,.05,.55,'×',2)}
      </div></details>
      <details><summary>Поверхность и радиация</summary><div class="group">
        <label>Тип поверхности<select id="surfaceType"><option value="grass">Трава</option><option value="dry">Сухая почва</option><option value="water">Вода</option><option value="urban">Город</option></select></label>
        ${slider('hour','Местное солнечное время',5,21,.25,13.5,' ч',2)}
        ${slider('solarMax','Солнце в зените',300,1200,25,1000,' Вт/м²')}
        ${slider('soilMoisture','Влажность почвы',0,100,1,45,' %')}
      </div></details>
      <details><summary>Расчёт</summary><div class="group">
        <label title="Точный перенос (WENO 5-го порядка, по умолчанию) почти не размывает восходящие потоки и сам сохраняет массу воды. Быстрый (полулагранжев) примерно вдвое дешевле, но размывает потоки: в сильном сдвиге термик не стартует">Перенос<select id="transport"><option value="weno">Точный (WENO5)</option><option value="semi-lagrangian">Быстрый (полулагранжев)</option></select></label>
        <label title="Область сдвигается вместе с грозой (правая ячейка по Банкерсу при сдвиге 0–6 км от 15 м/с, иначе средний ветер 0–6 км): гроза остаётся внутри и не въезжает с другой стороны в собственный холодный отток. Ветер, годограф и радар — относительно земли" class="check"><input type="checkbox" id="followStorm" checked> Область движется вместе с грозой</label>
        <label title="Большая область — 96 × 72 км с тем же шагом: ячейкам просторнее, но расчёт примерно в 4 раза медленнее">Размер области<select id="domain"><option value="standard">Стандарт — 48 × 36 км</option><option value="large">Большая — 96 × 72 км (в ~4 раза медленнее)</option></select></label>
        <label title="Со льдом (по умолчанию): облачный лёд, снег и крупа (Lin et al. 1983) — наковальня из кристаллов, теплота замерзания, таяние крупы в дождь. Тёплый дождь (Кесслер) — только капли: дешевле, но без наковальни и теплоты замерзания">Микрофизика<select id="microphysics"><option value="ice">Со льдом — лёд, снег, крупа</option><option value="warm">Тёплый дождь (Кесслер)</option></select></label>
        ${slider('speed','Ускорение времени',1,30,1,8,'×')}
        ${slider('bubble','Сила начального термика (0 — без термика)',0,2.5,.05,1,'×',2)}
      </div></details>
      <p class="hint">Двойной клик по поверхности создаёт локальный 3D-термик. Изменение профиля перезапускает эксперимент.</p>
      <div class="actions"><button id="restart">Перезапустить</button><button id="pause" class="secondary">Пауза</button></div>
    </aside>

    <section class="workspace">
      <nav class="tabs" aria-label="Отображаемое поле">
        <button class="active" data-field="composite">Облака</button><button data-field="updraft">Вертикальные потоки</button><button data-field="theta">Температура</button><button data-field="moisture">Влажность</button><button data-field="vorticity">Завихренность</button><button data-field="helicity" title="Спиральность восходящего потока: где поднимающийся воздух вращается (слой 2–5 км)">Вращение (UH)</button><button data-field="coldpool">Cold pool</button><button id="flowToggle" class="flow-toggle" aria-pressed="false">Потоки →</button><button id="precipToggle" class="flow-toggle" aria-pressed="false" title="Снежинки выше уровня 0 °C тают в капли по пути вниз">Снег и дождь</button><button id="mesoToggle" class="flow-toggle active" aria-pressed="true" title="Кольцо над вращающимся восходящим потоком (UH 2–5 км выше порога вращения)">Мезоциклон</button><button id="swathToggle" class="flow-toggle" aria-pressed="false" title="Сколько дождя выпало на землю с начала расчёта: голубой до 5 мм, зелёный до 10, жёлтый до 25, оранжевый до 50, красный больше">Сумма осадков</button>
      </nav>
      <div class="viewport">
        <canvas id="sim" width="960" height="600"></canvas>
        <div class="camera-help">ЛКМ — вращение · ПКМ — перемещение · колесо — масштаб · двойной клик — термик</div>
        <div class="surface-badge" id="surfaceReadout">ТРАВА</div>
        <div class="cell-labels" id="cellLabels"></div>
        <div class="legend" id="cloudLegend"><span><i class="cloud"></i>облачная вода</span><span><i class="rain"></i>осадки</span><span><i class="up"></i>updraft</span><span><i class="down"></i>downdraft</span></div>
        <div class="field-panel" id="fieldPanel" hidden>
          <b id="fieldTitle"></b>
          <div class="colorbar" id="colorbar"></div>
          <div class="colorbar-labels"><span id="fieldMin"></span><span id="fieldMid"></span><span id="fieldMax"></span></div>
          <label>Высота горизонтального среза<output id="sliceHeightOut">2.0 км</output><input id="sliceHeight" type="range" min="0.1" max="18.5" step="0.1" value="2"></label>
          <label>Вертикальный разрез, север ↔ юг<output id="sliceNorthOut">0 км</output><input id="sliceNorth" type="range" min="-17.5" max="17.5" step="0.5" value="0"></label>
          <label>Отображение<select id="layerMode"><option value="both">Срезы + объём сильных отклонений</option><option value="slices">Только срезы</option><option value="volume">Только объём (всё поле)</option></select></label>
          <div id="volumeControls" hidden>
            <label>Порог прозрачности<output id="volumeThresholdOut">10 %</output><input id="volumeThreshold" type="range" min="0" max="0.8" step="0.02" value="0.1"></label>
            <label>Плотность объёма<output id="volumeDensityOut">1.0×</output><input id="volumeDensity" type="range" min="0.2" max="4" step="0.1" value="1"></label>
          </div>
        </div>
      </div>
      <div class="readout"><span id="gridSize">Сетка 40 × 32 × 50</span><span>Область: <b id="frameMotion">—</b></span><span>Δx / Δy: 1.2 / 1.1 км, Δz: 0.1 км у земли → 1 км наверху</span><span>Δt: ${DT} с</span><span>Инсоляция: <b id="sun">—</b></span><span>Солнце: <b id="sunElevation">—</b></span><span>T+: <b id="time">00:00</b></span><span>Потоки: <b id="threads">—</b></span></div>
    </section>

    <aside class="diagnostics">
      <h2>Состояние конвекции</h2>
      <div class="cell-type"><span>Режим</span><strong id="cellType">—</strong><small id="cellReason">ожидание инициализации</small></div>
      <div class="cells"><div class="cells-head"><span>Ячейки</span><button id="cellAll" class="cell-chip" title="Показатели по всей области: максимумы по всем ячейкам">Вся область</button></div><div class="cell-list" id="cellList"><small>ячеек пока нет</small></div><small class="cells-hint">Щелчок по ячейке на 3D-виде или в списке закрепляет за ней показатели ниже</small></div>
      <div class="sounding"><canvas id="sounding"></canvas><div class="sounding-key"><span><i class="env"></i>среда</span><span><i class="dew"></i>точка росы</span><span><i class="parcel"></i>частица</span><span><i class="area cape"></i>CAPE</span><span><i class="area cin"></i>CIN</span></div></div>
      <div class="levels"><div><span>LCL</span><b id="lcl">—</b></div><div><span>LFC</span><b id="lfc">—</b></div><div><span>EL</span><b id="el">—</b></div><div><span>0 °C</span><b id="freezing">—</b></div></div>
      <div class="hodograph"><canvas id="hodograph"></canvas><div class="hodo-key"><span><i style="border-color:#c4553a"></i>0–3 км</span><span><i style="border-color:#4f8f5b"></i>3–6 км</span><span><i style="border-color:#3f6fa3"></i>6–10 км</span></div><div class="hodo-caption"><span>Сдвиг ветра 0–6 км</span><b id="shear">—</b><small id="shearHint"></small></div></div>
      <div class="energy"><div title="Частица приложения: +0,5 K и вовлечение сухого воздуха (разбавленная CAPE)"><span>CAPE</span><strong id="cape">—</strong><small>Дж/кг</small></div><div><span>CIN</span><strong id="cin">—</strong><small>Дж/кг</small></div></div>
      <div class="energy"><div title="Перемешанный слой 100 гПа (стандартная частица, без добавок)"><span>MLCAPE</span><strong id="mlcape">—</strong><small>Дж/кг</small></div><div title="CIN частицы перемешанного слоя"><span>MLCIN</span><strong id="mlcin">—</strong><small>Дж/кг</small></div></div>
      <div class="energy"><div title="Спиральность относительно правой ячейки (движение по Банкерсу), слой 0–1 км: главный признак смерчеопасной среды"><span>SRH 0–1 км</span><strong id="srh01">—</strong><small>м²/с²</small></div><div title="Спиральность относительно правой ячейки, слой 0–3 км"><span>SRH 0–3 км</span><strong id="srh03">—</strong><small>м²/с²</small></div></div>
      <div class="energy"><div title="Сложный параметр суперячейки (MUCAPE, SRH 0–3 км, сдвиг 0–6 км). Больше 1 — среда благоприятна для суперячеек"><span>SCP</span><strong id="scp">—</strong><small>безразм.</small></div><div title="Параметр значимого смерча, фиксированный слой (SBCAPE, LCL, SRH 0–1 км, сдвиг 0–6 км). Больше 1 — благоприятно для сильных смерчей"><span>STP</span><strong id="stp">—</strong><small>безразм.</small></div></div>
      <div class="energy"><div title="Наиболее неустойчивая частица в нижних 300 гПа"><span>MUCAPE</span><strong id="mucape">—</strong><small>Дж/кг</small></div><div title="Энергия нисходящего потока: сила холодных оттоков и микропорывов"><span>DCAPE</span><strong id="dcape">—</strong><small>Дж/кг</small></div></div>
      <div class="metric-scope" id="metricScope">Показатели по всей области</div>
      <div class="metric"><span>Макс. updraft</span><strong id="updraft">—</strong><small>м/с</small></div>
      <div class="metric"><span>Макс. downdraft</span><strong id="downdraft">—</strong><small>м/с</small></div>
      <div class="metric" title="Спиральность восходящего потока: насколько поднимающийся воздух вращается циклонически в слое 2–5 км"><span>Вращение потока (UH 2–5 км)</span><strong id="uh">—</strong><small>м²/с²</small></div>
      <div class="metric" title="Вращение восходящего потока у земли: низкоуровневый мезоциклон — признак ячейки, опасной по смерчам. На сетке ~0,65 км слой 0–1 км — один уровень, 0–3 км — четыре"><span>Низкое вращение (UH 0–1 / 0–3 км)</span><strong id="uhLow">—</strong><small>м²/с²</small></div>
      <div class="metric"><span>Вершина облака</span><strong id="cloudTop">—</strong><small>км</small></div>
      <div class="metric"><span>Вершина термика</span><strong id="thermalTop">—</strong><small>км</small></div>
      <div class="metric"><span>Макс. облачная вода</span><strong id="cloudWater">—</strong><small>г/кг</small></div>
      <div class="metric"><span>Cold pool Δθ</span><strong id="coldPool">—</strong><small>K</small></div>
      <div class="metric"><span>Порыв у земли</span><strong id="gust">—</strong><small>м/с, 100 м</small></div>
      <div class="metric"><span>Град у земли</span><strong id="hail">—</strong><small id="hailSwath">крупнейшие градины, см</small></div>
      <div class="metric" title="Сколько раз скорость упёрлась в предохранитель (|u|,|v| ≤ 120, |w| ≤ 100 м/с — заметно выше любых реальных гроз). Не ноль — расчёт пошёл вразнос, цифрам доверять нельзя."><span>Срабатывания ограничителей</span><strong id="clipped">—</strong><small>с начала расчёта</small></div>
      <div class="metric" title="Самый сильный дождь у земли сейчас: поток ρ·q_r·V_t"><span>Интенсивность дождя</span><strong id="rain">—</strong><small>мм/ч</small></div>
      <div class="metric" title="Наибольшая сумма дождя на земле с начала расчёта"><span>Сумма осадков, макс.</span><strong id="rainTotal">—</strong><small>мм</small></div>
      <div class="timeline" title="Ход грозы по модельному времени (вся область, точка каждые 30 с): самый сильный восходящий поток, вращение потока и дождь у земли. Перезапуск начинает графики заново"><h3>Ход грозы</h3><canvas id="timeline"></canvas></div>
      <div class="note"><b>Логика</b><p id="logicText">Частица ещё не достигла уровня свободной конвекции.</p></div>
    </aside>
  </main>`

// The page opens on the first scenario ("Летний день"); the controls are synced to it below.
const config: SimConfig = { ...defaults, ...SCENARIOS[0].values }
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
const view = { field: 'composite' as FieldMode, showVectors: false, showPrecip: false, showRainTotal: false, showMesocyclone: true, layerMode: 'both' as LayerMode, volumeThreshold: .1, volumeDensity: 1, sliceHeight: 2, sliceNorth: 0 }
let sim = new Atmosphere(canvas, config)
const radar = new RadarPanel(document.body); radar.attach(sim.model, sim.storm.rightMover)
document.querySelector('#radarOpen')!.addEventListener('click', () => radar.toggle())
let running = true
let last = performance.now(), frameCount = 0
const recreate = () => { useSeed(nextSeed()); sim.dispose(); sim = Object.assign(new Atmosphere(canvas, config), view); radar.attach(sim.model, sim.storm.rightMover); selectCell(null); showDomain() }

const resetKeys = new Set<keyof SimConfig>(['surfaceTemp','lapseLow','lapseMid','lapseUpper','tropopause','stratoWarming','capStrength','capHeight','rhSurface','rhLow','rhMid','rhUpper','moistLayer','wind0','wind05','wind1','wind3','wind6','wind10','windDir0','windDir05','windDir1','windDir3','windDir6','windDir10','latitude','bubble','surfaceType'])
const surfaceSelect = document.querySelector<HTMLSelectElement>('#surfaceType')!
const transportSelect = document.querySelector<HTMLSelectElement>('#transport')!
transportSelect.addEventListener('change', () => { config.transport = transportSelect.value as SimConfig['transport'] })
const followCheck = document.querySelector<HTMLInputElement>('#followStorm')!, domainSelect = document.querySelector<HTMLSelectElement>('#domain')!
followCheck.addEventListener('change', () => { config.followStorm = followCheck.checked; recreate() })
domainSelect.addEventListener('change', () => { config.domain = domainSelect.value as SimConfig['domain']; recreate() })
const microSelect = document.querySelector<HTMLSelectElement>('#microphysics')!
microSelect.addEventListener('change', () => { config.microphysics = microSelect.value as SimConfig['microphysics']; markPreset(null); recreate() })
const showOutput = (input: HTMLInputElement) => {
  document.querySelector<HTMLOutputElement>(`[data-output="${input.dataset.key}"]`)!.textContent = `${Number(input.value).toFixed(Number(input.dataset.digits))}${input.dataset.suffix}`
}
// With an analytic profile (the Weisman-Klemp scenario) the temperature, humidity and wind sliders do nothing: dim them.
const markProfileGroups = () => document.querySelectorAll<HTMLDetailsElement>('.controls details').forEach(d => {
  const title = d.querySelector('summary')?.textContent ?? '', profileGroup = /Температурный|Влажность по слоям|Профиль ветра/.test(title), off = profileGroup && !!config.profile
  d.style.opacity = off ? '.45' : ''; d.title = off ? 'Профиль задан сценарием (формулы Weisman–Klemp), ползунки не действуют' : ''
})
const markPreset = (index: number | null) => document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(b => b.classList.toggle('active', Number(b.dataset.preset) === index))
document.querySelectorAll<HTMLInputElement>('input[data-key]').forEach(input => {
  const key = input.dataset.key as keyof SimConfig
  input.addEventListener('input', () => {
    ;(config[key] as number|string) = Number(input.value)
    showOutput(input)
  })
  if (resetKeys.has(key)) input.addEventListener('change', () => { markPreset(null); recreate() })
})
surfaceSelect.addEventListener('change', () => {
  config.surfaceType = surfaceSelect.value as SimConfig['surfaceType']
  markPreset(null)
  recreate()
})
document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => button.addEventListener('click', () => {
  const index = Number(button.dataset.preset)
  Object.assign(config, defaults, { speed: config.speed, followStorm: config.followStorm, domain: config.domain, wind05: undefined, wind1: undefined, windDir05: undefined, windDir1: undefined, profile: undefined, bubbleRadius: undefined, front: undefined, edges: undefined, transport: 'weno' }, presets[index].values)
  fillLowWind(config)
  syncControls()
  markPreset(index)
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
  markProfileGroups()
}
syncControls()
markPreset(0)
document.querySelector('#restart')!.addEventListener('click', () => { recreate(); running = true; updatePause() })
document.querySelector('#pause')!.addEventListener('click', () => { running = !running; updatePause() })
const updatePause = () => {
  document.querySelector('#pause')!.textContent = running ? 'Пауза' : 'Продолжить'
  document.querySelector('#statusText')!.textContent = running ? 'РАСЧЁТ ИДЁТ' : 'ПАУЗА'
  document.querySelector('.status')!.classList.toggle('paused', !running)
}
const setView = (patch: Partial<typeof view>) => { Object.assign(view, patch); Object.assign(sim, patch) }
const fieldPanel = document.querySelector<HTMLDivElement>('#fieldPanel')!
const formatValue = (v: number) => `${v > 0 ? '+' : ''}${Number.isInteger(v) ? v : v.toFixed(1)}`
document.querySelectorAll<HTMLButtonElement>('[data-field]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-field]').forEach(b => b.classList.remove('active')); button.classList.add('active')
  const field = button.dataset.field as FieldMode
  setView({ field })
  fieldPanel.hidden = field === 'composite'
  document.querySelector<HTMLDivElement>('#cloudLegend')!.hidden = field !== 'composite'
  if (field === 'composite') return
  if (field === 'helicity' && (view.sliceHeight < 2.6 || view.sliceHeight > 4.6)) {
    sliceHeight.value = '3.5'; sliceHeight.dispatchEvent(new Event('input'))
  }
  const info = FIELDS[field], signed = info.diverging
  text('fieldTitle', `${info.title}, ${info.units}`)
  document.querySelector<HTMLDivElement>('#colorbar')!.style.background = `linear-gradient(to right, ${info.stops.join(',')})`
  text('fieldMin', signed ? formatValue(info.min) : String(info.min))
  text('fieldMid', signed ? '0' : String((info.min + info.max) / 2))
  text('fieldMax', signed ? formatValue(info.max) : String(info.max))
}))
document.querySelector<HTMLButtonElement>('#flowToggle')!.addEventListener('click', event => {
  const button=event.currentTarget as HTMLButtonElement;setView({ showVectors: !view.showVectors });button.classList.toggle('active',view.showVectors);button.setAttribute('aria-pressed',String(view.showVectors))
})
document.querySelector<HTMLButtonElement>('#mesoToggle')!.addEventListener('click', event => {
  const button=event.currentTarget as HTMLButtonElement;setView({ showMesocyclone: !view.showMesocyclone });button.classList.toggle('active',view.showMesocyclone);button.setAttribute('aria-pressed',String(view.showMesocyclone))
})
document.querySelector<HTMLButtonElement>('#swathToggle')!.addEventListener('click', event => {
  const button=event.currentTarget as HTMLButtonElement;setView({ showRainTotal: !view.showRainTotal });button.classList.toggle('active',view.showRainTotal);button.setAttribute('aria-pressed',String(view.showRainTotal))
})
document.querySelector<HTMLButtonElement>('#precipToggle')!.addEventListener('click', event => {
  const button=event.currentTarget as HTMLButtonElement;setView({ showPrecip: !view.showPrecip });button.classList.toggle('active',view.showPrecip);button.setAttribute('aria-pressed',String(view.showPrecip))
})
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
  const r = canvas.getBoundingClientRect(), g = sim.groundPoint((event.clientX - r.left) / r.width, (event.clientY - r.top) / r.height), cell = sim.cells.nearest(g.x, g.y, sim.model)
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
  const key = tracker.cells.map(c => `${c.id}:${c.stage}`).join() + `|${selectedCell}`
  if (key !== cellListKey) {
    cellListKey = key
    document.querySelector('#cellList')!.innerHTML = tracker.cells.length
      ? tracker.cells.map(c => `<button class="cell-chip${c.id === selectedCell ? ' active' : ''}${c.supercell || c.leftMover ? ' super' : ''}" data-cell="${c.id}" title="${CELL_STAGES[c.stage].hint}"><b>№${c.id}</b> ${CELL_STAGES[c.stage].name}</button>`).join('')
      : '<small>ячеек пока нет</small>'
    document.querySelector('#cellAll')!.classList.toggle('active', selectedCell === null)
  }
  // Labels over the cloud tops.
  const seen = new Set<string>()
  for (const c of tracker.cells) {
    const id = String(c.id), p = sim.screenPoint(c.x, c.y, (Math.max(c.stats.cloudTop, 2) + .8) * 1000)
    let label = cellLabels.querySelector<HTMLButtonElement>(`[data-cell="${id}"]`)
    if (!label) { label = document.createElement('button'); label.dataset.cell = id; label.textContent = `№${id}`; cellLabels.appendChild(label) }
    label.classList.toggle('active', c.id === selectedCell); label.hidden = !p
    if (p) label.style.transform = `translate(${p.x.toFixed(0)}px, ${p.y.toFixed(0)}px) translate(-50%, -100%)`
    seen.add(id)
  }
  cellLabels.querySelectorAll<HTMLElement>('[data-cell]').forEach(l => { if (!seen.has(l.dataset.cell!)) l.remove() })
  text('metricScope', cell ? `Показатели ячейки №${cell.id}${cellNote ? ` (${cellNote})` : ''}` : `Показатели по всей области${cellNote ? ` (${cellNote})` : ''}`)
  if (!cell) {
    // The whole domain: name the strongest cell's stage too.
    const top = tracker.cells.reduce<typeof tracker.cells[number] | null>((a, b) => !a || b.stats.updraft > a.stats.updraft ? b : a, null)
    if (top) document.querySelector('#cellReason')!.textContent += `; сильнейшая — №${top.id}: ${CELL_STAGES[top.stage].name.toLowerCase()}`
    return
  }
  // Motion only once the centre has been followed for 2 min since the last split or merger (before that it jumps about).
  // The tracker follows cells in the domain's frame; over the ground they also move with the domain.
  const [fu, fv] = sim.model.frame, gu = cell.u + fu, gv = cell.v + fv
  const s = cell.stats, age = Math.floor((sim.time - cell.born) / 60), speed = Math.hypot(gu, gv), followed = cell.trail[cell.trail.length - 1].t - cell.trail[0].t >= 120
  text('cellType', CELL_STAGES[cell.stage].name)
  text('cellReason', `№${cell.id}: ${CELL_STAGES[cell.stage].hint}. Возраст ${age} мин, ${ORIGIN[cell.origin]}${cell.parent ? ` (от №${cell.parent})` : ''}; ${!followed ? 'движение уточняется' : speed < 1 ? 'почти стоит' : `движется на ${heading(gu, gv)}, ${speed.toFixed(0)} м/с`}`)
  text('updraft', s.updraft.toFixed(1)); text('downdraft', s.downdraft.toFixed(1)); text('uh', s.uh.toFixed(0)); text('uhLow', `${s.uh01.toFixed(0)} / ${s.uh03.toFixed(0)}`)
  text('cloudTop', s.cloudTop.toFixed(1)); text('coldPool', s.coldPool.toFixed(1)); text('rain', s.rainRate.toFixed(1))
}
/** Domain size and grid in the header and footer, and how fast the domain moves with the storm. */
function showDomain() {
  const { nx, ny, nz, width, depth, height } = sim.model.grid, [fu, fv] = sim.model.frame, speed = Math.hypot(fu, fv)
  text('domainSize', `${width / 1000} × ${depth / 1000} × ${Math.round(height / 1000)} км`); text('gridSize', `Сетка ${nx} × ${ny} × ${nz}`)
  text('frameMotion', speed < .1 ? 'неподвижна' : `движется на ${heading(fu, fv)}, ${speed.toFixed(1)} м/с`)
}
canvas.addEventListener('dblclick', event => { const r=canvas.getBoundingClientRect(); sim.perturb((event.clientX-r.left)/r.width,(event.clientY-r.top)/r.height,1.25) })

const text = (id:string,value:string) => { document.querySelector(`#${id}`)!.textContent=value }
const prepareCanvas = (id: string) => {
  const c = document.querySelector<HTMLCanvasElement>(`#${id}`)!, dpr = Math.min(devicePixelRatio, 2), w = c.clientWidth, h = c.clientHeight
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
  const ctx = c.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); ctx.font = '8px IBM Plex Mono'
  return { ctx, w, h }
}
const T_MIN = -75, T_MAX = 45, Z_MAX = 18
function drawSounding(){
  const { ctx, w, h } = prepareCanvas('sounding'), s = sim.sounding()
  const L = 22, R = w - 30, T = 6, B = h - 14
  const X = (t: number) => L + (t - T_MIN) / (T_MAX - T_MIN) * (R - L), Y = (z: number) => T + (1 - z / Z_MAX) * (B - T)
  ctx.strokeStyle = '#d2dade'; ctx.lineWidth = 1; ctx.fillStyle = '#7c8c94'
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
function drawHodograph(){
  const { ctx, w, h } = prepareCanvas('hodograph'), wind = sim.sounding().wind
  const maxSpeed = Math.max(...wind.map(p => Math.hypot(p.u, p.v))), maxRing = Math.max(20, Math.ceil(maxSpeed / 10) * 10)
  const cx = w / 2, cy = h / 2, scale = (Math.min(w, h) / 2 - 12) / maxRing
  ctx.strokeStyle = '#d2dade'; ctx.fillStyle = '#8a9aa2'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(cx - maxRing * scale, cy); ctx.lineTo(cx + maxRing * scale, cy); ctx.moveTo(cx, cy - maxRing * scale); ctx.lineTo(cx, cy + maxRing * scale); ctx.stroke()
  for (let r = 10; r <= maxRing; r += 10) { ctx.beginPath(); ctx.arc(cx, cy, r * scale, 0, Math.PI * 2); ctx.stroke(); ctx.fillText(`${r}`, cx + r * scale * .71 + 2, cy - r * scale * .71 - 2) }
  ctx.fillText('С', cx + 3, 10); ctx.fillText('В', w - 10, cy - 3)
  const P = (p: { u: number, v: number }) => [cx + p.u * scale, cy - p.v * scale] as const
  // Bunkers right (RM) and left (LM) movers.
  for (const [label, [u, v]] of [['RM', sim.storm.rightMover], ['LM', sim.storm.leftMover]] as const) { const [x, y] = P({ u, v }); ctx.fillStyle = '#7b3fa0'; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.fillText(label, x + 4, y + 9) }
  ctx.fillStyle = '#8a9aa2'
  ctx.lineWidth = 2.2; ctx.lineCap = 'round'
  for (let i = 0; i + 1 < wind.length; i++) {
    const a = wind[i], b = wind[i + 1]
    ctx.strokeStyle = a.z < 3 ? '#c4553a' : a.z < 6 ? '#4f8f5b' : '#3f6fa3'
    ctx.beginPath(); ctx.moveTo(...P(a)); ctx.lineTo(...P(b)); ctx.stroke()
  }
  ctx.fillStyle = '#24323d'
  for (const z of [0, 1, 3, 6, 10]) { const p = wind.find(q => Math.abs(q.z - z) < 1e-6); if (!p) continue; const [x, y] = P(p); ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill(); ctx.fillText(`${z}`, x + 4, y - 3) }
  const w0 = wind[0], w6 = wind.find(p => Math.abs(p.z - 6) < 1e-6)!, shear = Math.hypot(w6.u - w0.u, w6.v - w0.v)
  text('shear', `${shear.toFixed(0)} м/с`)
  text('shearHint', shear < 10 ? 'слабый: одиночные ячейки' : shear < 20 ? 'умеренный: мультиячейки' : 'сильный: возможны суперячейки')
}
const timeline = new Timeline()
function frame(now:number){
  const elapsed=Math.min(.2,(now-last)/1000);last=now;if(running)sim.advance(elapsed);sim.render();const d=sim.diagnostics()
  text('cape',d.cape.toFixed(0));text('mlcape',d.indices.ml.cape.toFixed(0));text('mlcin',d.indices.ml.cin.toFixed(0));text('mucape',d.indices.mu.cape.toFixed(0));text('dcape',d.indices.dcape.toFixed(0));text('srh01',d.storm.srh01.toFixed(0));text('srh03',d.storm.srh03.toFixed(0));text('scp',d.storm.scp.toFixed(1));text('stp',d.storm.stp.toFixed(1));text('cin',d.cin.toFixed(0));text('updraft',d.updraft.toFixed(1));text('downdraft',d.downdraft.toFixed(1));text('uh',d.updraftHelicity.toFixed(0));text('uhLow',`${d.uh01.toFixed(0)} / ${d.uh03.toFixed(0)}`);text('cloudTop',d.cloudTop.toFixed(1));text('thermalTop',d.thermalTop.toFixed(1));text('cloudWater',d.cloudWater.toFixed(2));text('coldPool',d.coldPool.toFixed(1));text('gust',d.gust.toFixed(1));text('hail',d.hail>=1?(d.hail/10).toFixed(1):'нет');text('hailSwath',d.hailSwath>=1?`крупнейшие, см; за прогон до ${(d.hailSwath/10).toFixed(1)}`:'крупнейшие градины, см');text('clipped',String(d.clipped));text('rain',d.rain.toFixed(1));text('rainTotal',d.rainTotal.toFixed(1));text('lcl',d.lcl===null?'—':`${d.lcl.toFixed(1)} км`);text('lfc',d.lfc===null?'—':`${d.lfc.toFixed(1)} км`);text('el',d.el===null?'—':`${d.el.toFixed(1)} км`);text('cellType',d.cellType);text('cellReason',d.cellReason);text('logicText',d.logic);text('sun',`${d.insolation.toFixed(0)} Вт/м²`);text('sunElevation',d.sunElevation>0?`${d.sunElevation.toFixed(0)}° над горизонтом`:'ночь')
  text('surfaceReadout',({grass:'ТРАВА',dry:'СУХАЯ ПОЧВА',water:'ВОДА',urban:'ГОРОД'} as const)[config.surfaceType])
  const sec=Math.floor(sim.time);text('time',`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`);text('threads',String(sim.threads));text('freezing',d.freezing===null?'—':`${d.freezing.toFixed(1)} км`);const sampled=timeline.record({t:sim.time,updraft:d.updraft,uh:d.updraftHelicity,rain:d.rain,rainTotal:d.rainTotal,rotationHeld:sim.model.rotation.persisted});if(frameCount++%20===0){drawSounding();drawHodograph()}if(sampled||frameCount%20===1){const{ctx,w,h}=prepareCanvas('timeline');timeline.draw(ctx,w,h)}updateCells();radar.refresh();requestAnimationFrame(frame)
}
showDomain()
requestAnimationFrame(frame)
