import './style.css'
import { Atmosphere, type FieldMode, type SimConfig } from './simulator3d'

const slider = (key: keyof SimConfig, label: string, min: number, max: number, step: number, value: number, suffix: string, digits = 0) => `
  <label>${label}<output data-output="${key}">${value.toFixed(digits)}${suffix}</output>
    <input data-key="${key}" data-suffix="${suffix}" data-digits="${digits}" type="range" min="${min}" max="${max}" step="${step}" value="${value}">
  </label>`

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header>
    <div><span class="eyebrow">ЧИСЛЕННАЯ ЛАБОРАТОРИЯ АТМОСФЕРЫ / 1.0 3D</span><h1>StormLab</h1></div>
    <div class="header-stats"><span>3D non-hydrostatic</span><span>48 × 36 × 15 км</span><div class="status"><i></i><span id="statusText">РАСЧЁТ ИДЁТ</span></div></div>
  </header>
  <main>
    <aside class="controls">
      <details open><summary>Температурный профиль</summary><div class="group">
        ${slider('surfaceTemp','Температура у земли',15,40,.5,30,' °C',1)}
        ${slider('lapseLow','Градиент 0–3 км',3,11,.1,8.4,' K/км',1)}
        ${slider('lapseMid','Градиент 3–8 км',3,11,.1,7.2,' K/км',1)}
        ${slider('lapseUpper','Градиент 8 км–TP',3,11,.1,6.5,' K/км',1)}
        ${slider('tropopause','Тропопауза',8,14,.5,11,' км',1)}
        ${slider('stratoWarming','Стратосферный градиент',-1,4,.1,1.2,' K/км',1)}
      </div></details>
      <details open><summary>Влажность по слоям</summary><div class="group">
        ${slider('rhSurface','У земли',20,100,1,72,' %')}
        ${slider('rhLow','1–3 км',10,100,1,60,' %')}
        ${slider('rhMid','3–7 км',5,100,1,42,' %')}
        ${slider('rhUpper','7 км–TP',5,100,1,28,' %')}
        ${slider('entrainment','Вовлечение сухого воздуха',0,2,.05,.65,'×',2)}
      </div></details>
      <details><summary>Профиль ветра</summary><div class="group">
        ${slider('wind0','Ветер у земли',-20,30,1,2,' м/с')}
        ${slider('wind3','Ветер на 3 км',-10,45,1,10,' м/с')}
        ${slider('wind6','Ветер на 6 км',-10,60,1,20,' м/с')}
        ${slider('wind10','Ветер на 10 км',-10,75,1,28,' м/с')}
        ${slider('windDir0','Направление у земли',0,360,5,160,'°')}
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
        ${slider('solarMax','Максимальная инсоляция',300,1100,25,900,' Вт/м²')}
        ${slider('soilMoisture','Влажность почвы',0,100,1,45,' %')}
      </div></details>
      <details open><summary>Микрофизика и cold pool</summary><div class="group">
        ${slider('precipEfficiency','Эффективность осадков',0,2,.05,.85,'×',2)}
        ${slider('evaporation','Испарение осадков',0,2,.05,1,'×',2)}
        ${slider('coldPoolStrength','Сила cold pool',0,2.5,.05,1,'×',2)}
      </div></details>
      <details><summary>Расчёт</summary><div class="group">
        ${slider('speed','Ускорение времени',1,30,1,8,'×')}
        ${slider('seed','Seed',1,999,1,42,'')}
      </div></details>
      <p class="hint">Двойной клик по поверхности создаёт локальный 3D-термик. Изменение профиля перезапускает эксперимент.</p>
      <div class="actions"><button id="restart">Перезапустить</button><button id="pause" class="secondary">Пауза</button></div>
    </aside>

    <section class="workspace">
      <nav class="tabs" aria-label="Отображаемое поле">
        <button class="active" data-field="composite">Облака</button><button data-field="theta">Температура</button><button data-field="moisture">Относительная влажность</button><button data-field="vorticity">Завихренность</button><button data-field="coldpool">Cold pool</button><button id="flowToggle" class="flow-toggle" aria-pressed="false">Потоки →</button>
      </nav>
      <div class="viewport">
        <canvas id="sim" width="960" height="600"></canvas>
        <div class="camera-help">ЛКМ — вращение · ПКМ — перемещение · колесо — масштаб · двойной клик — термик</div>
        <div class="surface-badge" id="surfaceReadout">ТРАВА</div>
        <div class="legend"><span><i class="cloud"></i>облачная вода</span><span><i class="rain"></i>осадки</span><span><i class="up"></i>updraft</span><span><i class="down"></i>downdraft</span></div>
      </div>
      <div class="readout"><span>Сетка 40 × 32 × 24</span><span>Δx / Δy / Δz: 1.2 / 1.1 / 0.65 км</span><span>Δt: 1.0 с</span><span>Инсоляция: <b id="sun">—</b></span><span>T+: <b id="time">00:00</b></span></div>
    </section>

    <aside class="diagnostics">
      <h2>Состояние конвекции</h2>
      <div class="cell-type"><span>Режим</span><strong id="cellType">—</strong><small id="cellReason">ожидание инициализации</small></div>
      <div class="sounding"><canvas id="sounding" width="216" height="190"></canvas><div class="sounding-key"><span><i class="env"></i>среда</span><span><i class="parcel"></i>частица</span></div></div>
      <div class="levels"><div><span>LCL</span><b id="lcl">—</b></div><div><span>LFC</span><b id="lfc">—</b></div><div><span>EL</span><b id="el">—</b></div></div>
      <div class="energy"><div><span>CAPE</span><strong id="cape">—</strong><small>Дж/кг</small></div><div><span>CIN</span><strong id="cin">—</strong><small>Дж/кг</small></div></div>
      <div class="metric"><span>Макс. updraft</span><strong id="updraft">—</strong><small>м/с</small></div>
      <div class="metric"><span>Макс. downdraft</span><strong id="downdraft">—</strong><small>м/с</small></div>
      <div class="metric"><span>Вершина облака</span><strong id="cloudTop">—</strong><small>км</small></div>
      <div class="metric"><span>Вершина термика</span><strong id="thermalTop">—</strong><small>км</small></div>
      <div class="metric"><span>Макс. облачная вода</span><strong id="cloudWater">—</strong><small>г/кг</small></div>
      <div class="metric"><span>Cold pool Δθ</span><strong id="coldPool">—</strong><small>K</small></div>
      <div class="metric"><span>Микропорыв</span><strong id="microburst">—</strong><small>м/с outflow</small></div>
      <div class="metric"><span>Осадки</span><strong id="rain">—</strong><small>мм/ч proxy</small></div>
      <div class="note"><b>Логика</b><p id="logicText">Частица ещё не достигла уровня свободной конвекции.</p></div>
    </aside>
  </main>`

const config: SimConfig = {
  surfaceTemp:30,lapseLow:8.4,lapseMid:7.2,lapseUpper:6.5,tropopause:11,stratoWarming:1.2,
  rhSurface:72,rhLow:60,rhMid:42,rhUpper:28,entrainment:.65,
  wind0:2,wind3:10,wind6:20,wind10:28,windDir0:160,windDir3:185,windDir6:215,windDir10:235,
  latitude:45,turbulence:.55,
  hour:13.5,solarMax:900,soilMoisture:45,surfaceType:'grass',
  precipEfficiency:.85,evaporation:1,coldPoolStrength:1,speed:8,seed:42
}
const canvas = document.querySelector<HTMLCanvasElement>('#sim')!
let sim = new Atmosphere(canvas, config)
let running = true
let vectorsEnabled = false
let last = performance.now(), frameCount = 0
const recreate = () => { sim.dispose(); sim = new Atmosphere(canvas, { ...config }); sim.showVectors = vectorsEnabled }

const resetKeys = new Set<keyof SimConfig>(['surfaceTemp','lapseLow','lapseMid','lapseUpper','tropopause','stratoWarming','rhSurface','rhLow','rhMid','rhUpper','wind0','wind3','wind6','wind10','windDir0','windDir3','windDir6','windDir10','latitude','seed','surfaceType'])
document.querySelectorAll<HTMLInputElement>('input[data-key]').forEach(input => {
  const key = input.dataset.key as keyof SimConfig
  input.addEventListener('input', () => {
    ;(config[key] as number|string) = Number(input.value)
    const output = document.querySelector<HTMLOutputElement>(`[data-output="${key}"]`)!
    output.textContent = `${Number(input.value).toFixed(Number(input.dataset.digits))}${input.dataset.suffix}`
  })
  if (resetKeys.has(key)) input.addEventListener('change', recreate)
})
document.querySelector<HTMLSelectElement>('#surfaceType')!.addEventListener('change', event => {
  config.surfaceType = (event.target as HTMLSelectElement).value as SimConfig['surfaceType']
  recreate()
})
document.querySelector('#restart')!.addEventListener('click', () => { recreate(); running = true; updatePause() })
document.querySelector('#pause')!.addEventListener('click', () => { running = !running; updatePause() })
const updatePause = () => {
  document.querySelector('#pause')!.textContent = running ? 'Пауза' : 'Продолжить'
  document.querySelector('#statusText')!.textContent = running ? 'РАСЧЁТ ИДЁТ' : 'ПАУЗА'
  document.querySelector('.status')!.classList.toggle('paused', !running)
}
document.querySelectorAll<HTMLButtonElement>('[data-field]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-field]').forEach(b => b.classList.remove('active')); button.classList.add('active'); sim.field = button.dataset.field as FieldMode
}))
document.querySelector<HTMLButtonElement>('#flowToggle')!.addEventListener('click', event => {
  const button=event.currentTarget as HTMLButtonElement;vectorsEnabled=!vectorsEnabled;sim.showVectors=vectorsEnabled;button.classList.toggle('active',vectorsEnabled);button.setAttribute('aria-pressed',String(vectorsEnabled))
})
canvas.addEventListener('dblclick', event => { const r=canvas.getBoundingClientRect(); sim.perturb((event.clientX-r.left)/r.width,(event.clientY-r.top)/r.height,1.25) })

const text = (id:string,value:string) => { document.querySelector(`#${id}`)!.textContent=value }
function drawSounding(){
  const c=document.querySelector<HTMLCanvasElement>('#sounding')!,ctx=c.getContext('2d')!,s=sim.sounding(); ctx.clearRect(0,0,c.width,c.height); ctx.fillStyle='#e7ecee';ctx.fillRect(0,0,c.width,c.height)
  ctx.strokeStyle='#ccd5d9';ctx.lineWidth=1;for(let k=0;k<=3;k++){const y=8+k*(c.height-18)/3;ctx.beginPath();ctx.moveTo(25,y);ctx.lineTo(c.width-5,y);ctx.stroke();ctx.fillStyle='#7c8c94';ctx.font='8px IBM Plex Mono';ctx.fillText(`${15-k*5}`,3,y+3)}
  const plot=(kind:'env'|'parcel',color:string)=>{ctx.beginPath();s.profile.forEach((p,i)=>{const temp=kind==='env'?p.env:p.parcel,x=25+(temp+65)/110*(c.width-32),y=8+(1-p.z/15)*(c.height-18);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.strokeStyle=color;ctx.lineWidth=2;ctx.stroke()};plot('env','#4f7180');plot('parcel','#b46e43')
}
function frame(now:number){
  const elapsed=Math.min(.2,(now-last)/1000);last=now;if(running)sim.advance(elapsed);sim.render();const d=sim.diagnostics()
  text('cape',d.cape.toFixed(0));text('cin',d.cin.toFixed(0));text('updraft',d.updraft.toFixed(1));text('downdraft',d.downdraft.toFixed(1));text('cloudTop',d.cloudTop.toFixed(1));text('thermalTop',d.thermalTop.toFixed(1));text('cloudWater',d.cloudWater.toFixed(2));text('coldPool',d.coldPool.toFixed(1));text('microburst',d.microburst.toFixed(1));text('rain',d.rain.toFixed(1));text('lcl',d.lcl===null?'—':`${d.lcl.toFixed(1)} км`);text('lfc',d.lfc===null?'—':`${d.lfc.toFixed(1)} км`);text('el',d.el===null?'—':`${d.el.toFixed(1)} км`);text('cellType',d.cellType);text('cellReason',d.cellReason);text('logicText',d.logic);text('sun',`${d.insolation.toFixed(0)} Вт/м²`)
  text('surfaceReadout',({grass:'ТРАВА',dry:'СУХАЯ ПОЧВА',water:'ВОДА',urban:'ГОРОД'} as const)[config.surfaceType])
  const sec=Math.floor(sim.time);text('time',`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`);if(frameCount++%20===0)drawSounding();requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
