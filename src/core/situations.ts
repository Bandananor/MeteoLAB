// Synoptic situations (2.6): a story that unfolds over hours — the air mass, what the large-scale flow brings into it
// (advection), a front that comes through, the sun. The ready ones are scenarios with a `story` (scenarios.ts); this
// module assembles one from choices: an air mass, what sets the convection off, the wind shear and the hour.
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
 * starts no storm in 3 h (scouts 2026-10-13; without it storms by ~1.3 h); a front brings its own (TRIGGERS).
 */
export const AIR_MASSES = {
  tropical: { name: 'Тропическая: жаркая и влажная', values: { surfaceTemp: 30, rhSurface: 65, rhLow: 60, rhMid: 55, rhUpper: 35, moistLayer: 1.2, lapseLow: 8.5, lapseMid: 5.8, lapseUpper: 6.5, tropopause: 14, capStrength: 0, capHeight: 1.5 } },
  maritime: { name: 'Морская умеренная: прохладная и влажная', values: { surfaceTemp: 22, rhSurface: 75, rhLow: 70, rhMid: 50, rhUpper: 35, moistLayer: 1, lapseLow: 8, lapseMid: 6.6, lapseUpper: 6.5, tropopause: 11, capStrength: 0, capHeight: 1.5 } },
  continental: { name: 'Континентальная умеренная', values: { surfaceTemp: 27, rhSurface: 50, rhLow: 45, rhMid: 40, rhUpper: 30, moistLayer: 1, lapseLow: 9.3, lapseMid: 6.2, lapseUpper: 6.5, tropopause: 12, capStrength: 0, capHeight: 1.5 } },
  steppe: { name: 'Сухая степная: жара, высокая база облаков', values: { surfaceTemp: 33, rhSurface: 28, rhLow: 28, rhMid: 50, rhUpper: 30, moistLayer: 0, lapseLow: 9.7, lapseMid: 7.2, lapseUpper: 6.5, tropopause: 12.5, capStrength: 0, capHeight: 1.5 } },
} satisfies Record<string, { name: string; values: Partial<SimConfig> }>

/** The wind: weak, moderate or strong shear (a veering hodograph). */
export const SHEARS = {
  weak: { name: 'Слабый: обычные грозы', values: { wind0: 2, windDir0: 200, wind3: 5, windDir3: 230, wind6: 9, windDir6: 250, wind10: 14, windDir10: 260 } },
  moderate: { name: 'Умеренный: многоячейковые', values: { wind0: 4, windDir0: 180, wind3: 11, windDir3: 220, wind6: 17, windDir6: 240, wind10: 23, windDir10: 250 } },
  strong: { name: 'Сильный: возможны суперячейки', values: { wind0: 8, windDir0: 150, wind05: 14, windDir05: 170, wind1: 17, windDir1: 190, wind3: 20, windDir3: 225, wind6: 26, windDir6: 245, wind10: 35, windDir10: 255 } },
} satisfies Record<string, { name: string; values: Partial<SimConfig> }>

/** When a front reaches the domain's centre, h after the start. */
export const FRONT_ARRIVAL = 1.5
/** The least speed (m/s) a front gains on the domain: it starts at least ~32 km behind the centre, outside the standard domain. */
const MIN_GAIN = 6

/** What sets the convection off, with its story. */
export const TRIGGERS = {
  sun: { name: 'Только солнце', note: 'Ничего не приходит: воздух прогревается от земли, пока термики не пробьют задерживающий слой.',
    largeScale: [] as AdvectionChange[], story: [[0, 'Утро: солнце прогревает землю, растёт перемешанный слой'], [1, 'Первые кучевые облака — термики дошли до уровня конденсации'], [2, 'Если хватает тепла и влаги, кучевые вырастают в грозы']] as StoryStage[] },
  coldFront: { name: 'Холодный фронт', note: `Холодный фронт входит в область через ~0,5 ч, к середине — через ${String(FRONT_ARRIVAL).replace('.', ',')} ч, и поднимает тёплый воздух на своей голове.`,
    front: { kind: 'cold', contrast: 8, depth: 2, slope: 80, speed: 10, heading: 100, start: 0 } as FrontConfig, values: { capStrength: 1.5, capHeight: 1.5 },
    largeScale: [] as AdvectionChange[], story: [[0, 'Тёплый сектор: влажно, задерживающий слой держит'], [.5, 'С запада входит холодный фронт — синяя линия на земле'], [1, 'Голова фронта поднимает воздух и прорывает слой: вдоль фронта растут грозы'], [FRONT_ARRIVAL + 1, 'За фронтом — холодный сухой воздух, грозы уходят с фронтом']] as StoryStage[] },
  warmFront: { name: 'Тёплый фронт', note: 'Тёплый воздух натекает поверх пологого клина холодного: облака и грозы над холодным слоем.',
    front: { kind: 'warm', contrast: 5, depth: 1, slope: 150, speed: 7, heading: 60, start: 0 } as FrontConfig, values: { capStrength: 1.5, capHeight: 1.5 },
    largeScale: [] as AdvectionChange[], story: [[0, 'Впереди фронта у земли — холодный воздух'], [.5, 'Тёплый воздух поднимается по клину: облака над холодным слоем, возможна приподнятая конвекция'], [FRONT_ARRIVAL, 'Линия тёплого фронта проходит середину, у земли теплеет — вслед может начаться конвекция от земли']] as StoryStage[] },
  trough: { name: 'Высотная ложбина: холод наверху', note: 'На 4–10 км холодает на 3 K за 2 часа: профиль круче, CAPE растёт.',
    largeScale: [{ quantity: 'temperature', bottom: 4, top: 10, amount: -3, start: .5, hours: 2 }] as AdvectionChange[], story: [[0, 'Утро: солнце греет землю'], [.5, 'Подходит высотная ложбина: наверху холодает'], [1.5, 'CAPE растёт, кучевые тянутся выше'], [2.5, 'Холод наверху и тепло у земли — грозы']] as StoryStage[] },
  moisture: { name: 'Вынос тёплой влажной массы', note: 'Южный ветер приносит влагу: +2,5 г/кг в нижних 1,5 км за 3 часа.',
    largeScale: [{ quantity: 'moisture', bottom: 0, top: 1.5, amount: 2.5, start: 0, hours: 3 }] as AdvectionChange[], story: [[0, 'Утро: воздух ещё суховат'], [1, 'Влага подтягивается, основание облаков опускается'], [2, 'CAPE растёт — кучевые всё мощнее'], [3, 'Вынос закончился: самая неустойчивая среда дня']] as StoryStage[] },
  warmAdvection: { name: 'Тёплая адвекция над слоем (грозы гаснут)', note: 'На 2–3,5 км, над слоем перемешивания, теплеет на 3 K за 2 часа: задерживающий слой крепнет.',
    largeScale: [{ quantity: 'temperature', bottom: 2, top: 3.5, amount: 3, start: 0, hours: 2 }] as AdvectionChange[], story: [[0, 'Утро: CAPE большая, крышка слабая'], [.5, 'Над пограничным слоем теплеет — растёт CIN'], [2, 'Крышка окрепла: кучевые упираются в неё, грозы не прорываются']] as StoryStage[] },
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
  const name = `${trigger.name}: ${mass.name.split(':')[0].toLowerCase()} масса`
  const hint = `Собранная ситуация. Воздушная масса — ${mass.name.toLowerCase()}; сдвиг ветра — ${shear.name.toLowerCase()}. ${trigger.note} Начало в ${choice.hour}:00, термика нет: конвекцию запускают солнце и то, что приходит.`
  return { name, hint, story: trigger.story, values }
}

/** The stage of a story at a time (s of the run): the last one begun, or none before the first. */
export function storyStage(story: readonly StoryStage[], time: number) {
  let now = -1
  story.forEach(([hours], k) => { if (time >= hours * 3600) now = k })
  return now
}
