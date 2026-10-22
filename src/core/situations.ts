// Synoptic situations (2.6): a story that unfolds over hours — the air mass, what the large-scale flow brings into it
// (advection), a front that comes through, the sun. The ready ones are scenarios with a `story` (scenarios.ts); this
// module assembles one from choices: an air mass, what sets the convection off, the wind shear and the hour.
import { L } from '../i18n'
import type { SimConfig } from './config'
import { createGrid } from './grid'
import { Environment } from './environment'
import { headingVector, type FrontConfig } from './fronts'
import { stormMotion } from './kinematics'
import type { AdvectionChange } from './largescale'
import { environmentProfile } from './profiles'

/** A stage of a story: from this many hours after the start, what happens. */
export type StoryStage = [hours: number, text: string]

export interface SituationChoice {
  mass: keyof typeof AIR_MASSES
  trigger: keyof typeof TRIGGERS
  shear: keyof typeof SHEARS
  /** Local solar time at the start, h. */
  hour: number
}

/**
 * Air masses of a summer day over the plains: the temperature and moisture profile. No lid: under one the sun alone
 * starts no storm in 3 h (scouts 2026-10-13; without it storms by ~1.3 h); a front brings its own (TRIGGERS). That a
 * lid of 1.5 K (CIN ~10 J/kg) holds is the ~1 km grid's slow initiation, not nature (the reviewer, 2.6.1): to be
 * recalibrated with real lids (CIN 50-100) on the 500 m grid.
 */
export const AIR_MASSES = {
  tropical: { name: L('Морская тропическая: с юга, жаркая и влажная', 'Maritime tropical: from the south, hot and humid'), values: { surfaceTemp: 30, rhSurface: 65, rhLow: 60, rhMid: 55, rhUpper: 35, moistLayer: 1.2, lapseLow: 8.5, lapseMid: 5.8, lapseUpper: 6.5, tropopause: 14, capStrength: 0, capHeight: 1.5 } },
  maritime: { name: L('Морская умеренная: прохладная и влажная', 'Maritime polar: cool and moist'), values: { surfaceTemp: 22, rhSurface: 60, rhLow: 58, rhMid: 50, rhUpper: 35, moistLayer: 1, lapseLow: 8, lapseMid: 6.3, lapseUpper: 6.5, tropopause: 11, capStrength: 0, capHeight: 1.5 } },
  continental: { name: L('Континентальная умеренная', 'Continental mid-latitude'), values: { surfaceTemp: 27, rhSurface: 50, rhLow: 45, rhMid: 40, rhUpper: 30, moistLayer: 1, lapseLow: 9.3, lapseMid: 6.2, lapseUpper: 6.5, tropopause: 12, capStrength: 0, capHeight: 1.5 } },
  steppe: { name: L('Сухая степная: жара, высокая база облаков', 'Dry steppe: heat, a high cloud base'), values: { surfaceTemp: 33, rhSurface: 28, rhLow: 28, rhMid: 50, rhUpper: 30, moistLayer: 0, lapseLow: 9.7, lapseMid: 7.2, lapseUpper: 6.5, tropopause: 12.5, capStrength: 0, capHeight: 1.5 } },
} satisfies Record<string, { name: string; values: Partial<SimConfig> }>

/** The wind: weak, moderate or strong shear (a veering hodograph). */
export const SHEARS = {
  weak: { name: L('Слабый: обычные грозы', 'Weak: ordinary storms'), values: { wind0: 2, windDir0: 200, wind3: 5, windDir3: 230, wind6: 9, windDir6: 250, wind10: 14, windDir10: 260 } },
  moderate: { name: L('Умеренный: многоячейковые', 'Moderate: multicells'), values: { wind0: 4, windDir0: 180, wind3: 11, windDir3: 220, wind6: 17, windDir6: 240, wind10: 23, windDir10: 250 } },
  strong: { name: L('Сильный: возможны суперячейки', 'Strong: supercells possible'), values: { wind0: 8, windDir0: 150, wind05: 14, windDir05: 170, wind1: 17, windDir1: 190, wind3: 20, windDir3: 225, wind6: 26, windDir6: 245, wind10: 35, windDir10: 255 } },
} satisfies Record<string, { name: string; values: Partial<SimConfig> }>

/** When a front reaches the domain's centre, h after the start. */
export const FRONT_ARRIVAL = 1.5
/** The least speed (m/s) a front gains on the domain: it starts at least ~32 km behind the centre, outside the standard domain. */
const MIN_GAIN = 6

/** What sets the convection off, with its story. */
export const TRIGGERS = {
  sun: { name: L('Только солнце', 'Sun only'), note: L('Ничего не приходит: воздух прогревается от земли, пока термики не пробьют задерживающий слой.', 'Nothing arrives: the air warms from the ground until the thermals break through the cap.'),
    largeScale: [] as AdvectionChange[], story: [[0, L('Утро: солнце прогревает землю, растёт перемешанный слой', 'Morning: the sun warms the ground, the mixed layer grows')], [1, L('Первые кучевые облака — термики дошли до уровня конденсации', 'The first cumulus — the thermals have reached the condensation level')], [2, L('Если хватает тепла и влаги, кучевые вырастают в грозы', 'With enough heat and moisture the cumulus grow into storms')]] as StoryStage[] },
  coldFront: { name: L('Холодный фронт', 'Cold front'), note: L(`Холодный фронт входит в область через ~0,5 ч, к середине — через ${String(FRONT_ARRIVAL).replace('.', ',')} ч, и поднимает тёплый воздух на своей голове. Края области гасят ячейки (по 12 км у каждого края), поэтому линия гроз — отрезок ~10–20 км посередине.`, `The cold front enters the domain after ~0.5 h, reaches the middle after ${FRONT_ARRIVAL} h and lifts the warm air on its head. The domain’s edges damp the cells (12 km at each edge), so the line of storms is a ~10–20 km stretch in the middle.`),
    front: { kind: 'cold', contrast: 8, depth: 2, slope: 80, speed: 10, heading: 100, start: 0 } as FrontConfig, values: { capStrength: 1.5, capHeight: 1.5 },
    largeScale: [] as AdvectionChange[], story: [[0, L('Тёплый сектор: влажно, задерживающий слой держит', 'Warm sector: moist, the cap holds')], [.5, L('С запада входит холодный фронт — синяя линия на земле', 'A cold front enters from the west — the blue line on the ground')], [1, L('Голова фронта поднимает воздух и прорывает слой: вдоль фронта растут грозы', 'The front’s head lifts the air and breaks the cap: storms grow along the front')], [FRONT_ARRIVAL + 1, L('За фронтом — холодный сухой воздух, грозы уходят с фронтом', 'Behind the front — cold dry air, the storms leave with the front')]] as StoryStage[] },
  warmFront: { name: L('Тёплый фронт', 'Warm front'), note: L('Тёплый воздух натекает поверх пологого клина холодного: облака и грозы над холодным слоем.', 'Warm air flows up over a gentle wedge of cold air: clouds and storms above the cold layer.'),
    front: { kind: 'warm', contrast: 5, depth: 1, slope: 150, speed: 7, heading: 60, start: 0 } as FrontConfig, values: { capStrength: 1.5, capHeight: 1.5 },
    largeScale: [] as AdvectionChange[], story: [[0, L('Впереди фронта у земли — холодный воздух', 'Ahead of the front, cold air at the ground')], [.5, L('Тёплый воздух поднимается по клину: облака над холодным слоем, возможна приподнятая конвекция', 'The warm air rises along the wedge: clouds above the cold layer, elevated convection possible')], [FRONT_ARRIVAL, L('Линия тёплого фронта проходит середину, у земли теплеет — вслед может начаться конвекция от земли', 'The warm front’s line passes the middle, it warms at the ground — surface-based convection may follow')]] as StoryStage[] },
  trough: { name: L('Высотная ложбина: холод наверху', 'Upper trough: cold aloft'), note: L('На 4–10 км холодает на 4 K за 2 часа: профиль круче, CAPE растёт.', 'At 4–10 km it cools by 4 K over 2 hours: a steeper profile, CAPE grows.'),
    largeScale: [{ quantity: 'temperature', bottom: 4, top: 10, amount: -4, start: .5, hours: 2 }] as AdvectionChange[], story: [[0, L('Утро: солнце греет землю', 'Morning: the sun heats the ground')], [.5, L('Подходит высотная ложбина: наверху холодает', 'An upper trough approaches: it cools aloft')], [1.5, L('CAPE растёт, кучевые тянутся выше', 'CAPE grows, the cumulus reach higher')], [2.5, L('Холод наверху и тепло у земли — грозы', 'Cold aloft and warmth at the ground — storms')]] as StoryStage[] },
  moisture: { name: L('Вынос тёплой влажной массы', 'Warm moist air arriving'), note: L('Южный ветер приносит влагу: +2,5 г/кг в нижних 1,5 км за 3 часа.', 'A southerly wind brings moisture: +2.5 g/kg in the lowest 1.5 km over 3 hours.'),
    largeScale: [{ quantity: 'moisture', bottom: 0, top: 1.5, amount: 2.5, start: 0, hours: 3 }] as AdvectionChange[], story: [[0, L('Утро: воздух ещё суховат', 'Morning: the air is still rather dry')], [1, L('Влага подтягивается, основание облаков опускается', 'Moisture arrives, the cloud base lowers')], [2, L('CAPE растёт — кучевые всё мощнее', 'CAPE grows — the cumulus get taller')], [3, L('Вынос закончился: самая неустойчивая среда дня', 'The inflow is over: the most unstable environment of the day')]] as StoryStage[] },
  warmAdvection: { name: L('Тёплый воздух над слоем (крышка крепнет)', 'Warm air above the layer (the cap strengthens)'), note: L('На 2–3,5 км, над слоем перемешивания, ветер приносит тёплый сухой воздух: +3 K за 2 часа, задерживающий слой крепнет.', 'At 2–3.5 km, above the mixed layer, the wind brings warm dry air: +3 K over 2 hours, the cap strengthens.'),
    largeScale: [{ quantity: 'temperature', bottom: 2, top: 3.5, amount: 3, start: 0, hours: 2 }] as AdvectionChange[], story: [[0, L('Утро: CAPE большая, крышка слабая', 'Morning: large CAPE, a weak cap')], [.5, L('Над пограничным слоем теплеет — растёт CIN', 'It warms above the boundary layer — CIN grows')], [2, L('Крышка окрепла: кучевые упираются в неё, грозы не прорываются', 'The cap has strengthened: the cumulus hit it, storms do not break through')]] as StoryStage[] },
} satisfies Record<string, { name: string; note: string; front?: FrontConfig; values?: Partial<SimConfig>; largeScale: AdvectionChange[]; story: StoryStage[] }>

/**
 * A situation from the choices: the values to lay over the defaults, its name, a note and the story. A front starts
 * where it reaches the domain's centre at FRONT_ARRIVAL: the domain moves with the mean wind 0-6 km (set, so the
 * front's way is known), and the front gains on it by its speed less the domain's along its heading.
 */
export function buildSituation(choice: SituationChoice, defaults: SimConfig): { name: string; hint: string; story: StoryStage[]; values: Partial<SimConfig> } {
  const mass = AIR_MASSES[choice.mass], trigger: (typeof TRIGGERS)[keyof typeof TRIGGERS] = TRIGGERS[choice.trigger], shear = SHEARS[choice.shear]
  const values: Partial<SimConfig> = { ...mass.values, ...shear.values, ...('values' in trigger ? trigger.values : {}), hour: choice.hour, bubble: 0, largeScale: trigger.largeScale.length ? trigger.largeScale.map(c => ({ ...c })) : undefined }
  const config = { ...defaults, ...values }, grid = createGrid(), env = new Environment(config, grid, environmentProfile(config, grid.height))
  let [mu, mv] = stormMotion(env).meanWind
  if ('front' in trigger) {
    // The domain may not outrun the front: along its heading it goes at most MIN_GAIN slower than the front.
    const [nx, ny] = headingVector(trigger.front.heading), excess = Math.max(0, mu * nx + mv * ny - (trigger.front.speed - MIN_GAIN))
    mu -= excess * nx; mv -= excess * ny
    const gain = trigger.front.speed - (mu * nx + mv * ny)
    values.frontLine = { ...trigger.front, start: Math.round(-gain * FRONT_ARRIVAL * 3.6 * 10) / 10 }
  }
  values.frameMotion = [Math.round(mu * 10) / 10, Math.round(mv * 10) / 10]
  const name = L(`${trigger.name}: ${mass.name.split(':')[0].toLowerCase()} масса`, `${trigger.name}: ${mass.name.split(':')[0].toLowerCase()} air`)
  const hint = L(`Собранная ситуация. Воздушная масса — ${mass.name.toLowerCase()}; сдвиг ветра — ${shear.name.toLowerCase()}. ${trigger.note} Начало в ${choice.hour}:00, термика нет: конвекцию запускают солнце и то, что приходит. Изменения среды ускорены, чтобы уложиться в 2–3 часа; слабая крышка у фронта в модели держит дольше, чем в природе (на сетке ~1 км солнце медленно запускает конвекцию)`, `A situation you built. The air mass — ${mass.name.toLowerCase()}; the wind shear — ${shear.name.toLowerCase()}. ${trigger.note} Starts at ${choice.hour}:00, no thermal: the sun and what arrives start the convection. The environment’s changes are sped up to fit 2–3 hours; a weak cap at the front holds longer in the model than in nature (on a ~1 km grid the sun is slow to start convection)`)
  return { name, hint, story: trigger.story, values }
}

/** The stage of a story at a time (s of the run): the last one begun, or none before the first. */
export function storyStage(story: readonly StoryStage[], time: number) {
  let now = -1
  story.forEach(([hours], k) => { if (time >= hours * 3600) now = k })
  return now
}
