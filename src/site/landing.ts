// The home page: the scenario cards (from the scenarios themselves, with their environment's numbers) and the facts.
import { decimal, L } from '../i18n'
import './site'
import { createGrid, DT, Environment, parcelIndices, SCENARIOS, type SimConfig, stormIndices, environmentProfile } from '../core'
import { DEFAULTS } from '../defaults'

const grid = createGrid(), number = (v: number, digits = 1) => decimal(v, digits)
const WORDS = L('ноль один два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать', 'zero one two three four five six seven eight nine ten eleven twelve').split(' ')

document.querySelector('#scenarioCards')!.innerHTML = SCENARIOS.map(s => {
  const c: SimConfig = { ...DEFAULTS, ...s.values }
  const env = new Environment(c, grid, environmentProfile(c, grid.height)), p = parcelIndices(env, grid.height), k = stormIndices(env, p)
  const meso = s.mesocyclone === true
  return `<a class="scenario-card${meso ? ' is-meso' : ''}" href="simulator/?scenario=${encodeURIComponent(s.name)}"><h3>${s.title}</h3><p>${s.summary}</p>`
    + `<div class="scenario-card__nums"><span>ML CAPE ${number(p.ml.cape / 1000)} ${L('кДж/кг', 'kJ/kg')}</span><span>${L('сдвиг 0–6 км', '0–6 km shear')} ${Math.round(k.shear06)} ${L('м/с', 'm/s')}</span></div>`
    + `<div class="scenario-card__foot"><span><span class="dot${meso ? ' dot--danger' : ''}"></span>${meso ? L('мезоциклон', 'mesocyclone') : s.mesocyclone === false ? L('без мезоциклона', 'no mesocyclone') : L('вращение — как сложится', 'rotation — as it turns out')}</span><span class="scenario-card__open">${L('Открыть →', 'Open →')}</span></div></a>`
}).join('')
const more = document.querySelector<HTMLButtonElement>('#moreScenarios')!
more.textContent = L(`Ещё ${SCENARIOS.length - 4} сценариев`, `${SCENARIOS.length - 4} more scenarios`)
more.addEventListener('click', () => { document.querySelector('#scenarioCards')!.classList.add('is-all'); more.hidden = true })

const fact = (name: string, text: string) => { document.querySelector(`[data-fact="${name}"]`)!.textContent = text }
fact('domain', `${grid.width / 1000} × ${grid.depth / 1000} × ${number(grid.height / 1000)} ${L('км', 'km')}`)
fact('grid', `~${number(grid.dx / 1000)} ${L('км', 'km')}`)
fact('dt', `${DT} ${L('с', 's')}`)
fact('scenarios', String(SCENARIOS.length))
const word = WORDS[SCENARIOS.length]
if (word) fact('scenarioTitle', L(`${word[0].toUpperCase()}${word.slice(1)} сценариев`.replace(/^Один сценариев$/, 'Один сценарий').replace(/^(Два|Три|Четыре) сценариев$/, '$1 сценария'), `${word[0].toUpperCase()}${word.slice(1)} scenario${SCENARIOS.length === 1 ? '' : 's'}`))
