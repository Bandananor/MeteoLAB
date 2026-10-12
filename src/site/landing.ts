// The home page: the scenario cards (from the scenarios themselves, with their environment's numbers) and the facts.
import './site'
import { createGrid, DT, Environment, parcelIndices, SCENARIOS, type SimConfig, stormIndices, weismanKlemp } from '../core'
import { DEFAULTS } from '../defaults'

const grid = createGrid(), number = (v: number, digits = 1) => v.toFixed(digits).replace('.', ',')
const WORDS = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать']

document.querySelector('#scenarioCards')!.innerHTML = SCENARIOS.map(s => {
  const c: SimConfig = { ...DEFAULTS, ...s.values }
  const env = new Environment(c, grid, c.profile === 'weisman-klemp' ? weismanKlemp({ qvMax: .016 }) : undefined), p = parcelIndices(env, grid.height), k = stormIndices(env, p)
  const meso = s.mesocyclone === true
  return `<a class="scenario-card${meso ? ' is-meso' : ''}" href="simulator/?scenario=${encodeURIComponent(s.name)}"><h3>${s.name}</h3><p>${s.summary}</p>`
    + `<div class="scenario-card__nums"><span>ML CAPE ${number(p.ml.cape / 1000)} кДж/кг</span><span>сдвиг 0–6 км ${Math.round(k.shear06)} м/с</span></div>`
    + `<div class="scenario-card__foot"><span><span class="dot${meso ? ' dot--danger' : ''}"></span>${meso ? 'мезоциклон' : s.mesocyclone === false ? 'без мезоциклона' : 'вращение — как сложится'}</span><span class="scenario-card__open">Открыть →</span></div></a>`
}).join('')
const more = document.querySelector<HTMLButtonElement>('#moreScenarios')!
more.textContent = `Ещё ${SCENARIOS.length - 4} сценариев`
more.addEventListener('click', () => { document.querySelector('#scenarioCards')!.classList.add('is-all'); more.hidden = true })

const fact = (name: string, text: string) => { document.querySelector(`[data-fact="${name}"]`)!.textContent = text }
fact('domain', `${grid.width / 1000} × ${grid.depth / 1000} × ${number(grid.height / 1000)} км`)
fact('grid', `~${number(grid.dx / 1000)} км`)
fact('dt', `${DT} с`)
fact('scenarios', String(SCENARIOS.length))
const word = WORDS[SCENARIOS.length]
if (word) fact('scenarioTitle', `${word[0].toUpperCase()}${word.slice(1)} сценариев`.replace(/^Один сценариев$/, 'Один сценарий').replace(/^(Два|Три|Четыре) сценариев$/, '$1 сценария'))
