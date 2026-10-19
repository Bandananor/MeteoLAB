// «What to expect» (2.8, testers 13.10.2026): before the run, what the environment favours by the published statistics
// of real storms — whether deep convection will start, its mode, supercells, a significant tornado, large hail, a long
// wind storm — each with where its numbers come from; the run then shows what the model made of it (a forecaster's
// exercise: the environment against the storm).
import { L } from '../i18n'
import type { StormIndices } from './kinematics'
import type { ParcelIndices } from './sounding'

/** 0 nothing to expect, 1 possible, 2 likely, 3 a danger. */
export type ExpectLevel = 0 | 1 | 2 | 3
export interface Expectation { topic: string; verdict: string; level: ExpectLevel; detail: string; source: string }

/**
 * The share of significant tornadoes (EF2+) among the right-moving supercells of Thompson et al. (2012) by the
 * effective-layer STP, from their Table 5 (the cumulative share of each damage class above each STP, times the class's
 * count; 4136 supercells with a tornado or significant hail or wind, 2005-11): of STP < 0.5, 0.5-1, 1-2, 2-4, 4-6, 6+.
 * Their supercells all produced a tornado or significant hail or wind: for any supercell the chance is lower.
 */
export const SIGTOR_BY_STP: readonly [number, number][] = [[0, .06], [.5, .11], [1, .16], [2, .2], [4, .31], [6, .42]]
/** Effective bulk shear, m/s, from which supercells become possible and from which their environment (Thompson et al. 2007: 25-40 kt). */
export const SUPERCELL_SHEAR = [12.5, 20] as const

const pct = (v: number) => `${Math.round(v * 100)} %`
const f1 = (v: number) => L(v.toFixed(1).replace('.', ','), v.toFixed(1))

/** The expectations of an environment (its standard parcels and storm indices). */
export function expectations(p: ParcelIndices, k: StormIndices): Expectation[] {
  const out: Expectation[] = [], cape = p.ml.cape, cin = p.ml.cin, shear = k.effective?.shear ?? 0
  const deep = cape >= 100 || p.mu.cape >= 250
  out.push(!deep
    ? { topic: L('Гроза', 'Thunderstorm'), verdict: L('не ждать', 'not expected'), level: 0, detail: L(`MLCAPE ${cape.toFixed(0)} Дж/кг: частице не хватит плавучести на глубокое облако`, `MLCAPE ${cape.toFixed(0)} J/kg: a parcel lacks the buoyancy for a deep cloud`), source: L('теория частицы', 'parcel theory') }
    : cin < -150
      ? { topic: L('Гроза', 'Thunderstorm'), verdict: L('только при сильном подъёме', 'only with strong lift'), level: 1, detail: L(`MLCIN ${cin.toFixed(0)} Дж/кг — крышка: нужен фронт, сходимость или дневной прогрев (в модели — термик)`, `MLCIN ${cin.toFixed(0)} J/kg — a lid: it takes a front, convergence or the day's heating (in the model — the thermal)`), source: L('теория частицы', 'parcel theory') }
      : { topic: L('Гроза', 'Thunderstorm'), verdict: L('вероятна', 'likely'), level: 2, detail: L(`MLCAPE ${cape.toFixed(0)}, MLCIN ${cin.toFixed(0)} Дж/кг`, `MLCAPE ${cape.toFixed(0)}, MLCIN ${cin.toFixed(0)} J/kg`), source: L('теория частицы', 'parcel theory') })
  if (!deep) return out
  const [possible, favoured] = SUPERCELL_SHEAR
  out.push({ topic: L('Режим', 'Mode'), verdict: shear >= favoured ? L('суперячейки', 'supercells') : shear >= possible ? L('многоячейковые, возможны суперячейки', 'multicells, supercells possible') : L('одиночные и многоячейковые', 'single cells and multicells'), level: shear >= favoured ? 2 : 1,
    detail: L(`сдвиг в эффективном слое ${f1(shear)} м/с: от ${f1(possible)} — суперячейки возможны, от ${f1(favoured)} — среда суперячеек`, `effective bulk shear ${f1(shear)} m/s: from ${f1(possible)} supercells are possible, from ${f1(favoured)} their environment`), source: 'Thompson et al. 2007' })
  // SCP takes the fixed 0-6 km shear: with little shear over the storm's own depth it promises more than there is.
  const scpLevel: ExpectLevel = k.scp >= 4 ? 3 : k.scp >= 1 ? 2 : 0, weak = shear < possible && scpLevel > 1
  out.push({ topic: L('Суперячейка', 'Supercell'), verdict: weak ? L('возможна', 'possible') : k.scp >= 4 ? L('очень вероятна', 'very likely') : k.scp >= 1 ? L('вероятна', 'likely') : L('маловероятна', 'unlikely'), level: weak ? 1 : scpLevel,
    detail: `SCP ${f1(k.scp)}: ${L('от 1 — среда благоприятна для суперячеек', 'from 1 the environment favours supercells')}${weak ? L('; но сдвига над самой грозой мало', '; but there is little shear over the storm itself') : ''}`, source: 'Thompson et al. 2003' })
  const stp = k.stpEffective, share = [...SIGTOR_BY_STP].reverse().find(([from]) => stp >= from)![1]
  out.push(k.scp < 1 || shear < possible
    ? { topic: L('Значимый смерч', 'Significant tornado'), verdict: L('не ждать', 'not expected'), level: 0, detail: L('без суперячеек значимые смерчи редки', 'without supercells significant tornadoes are rare'), source: 'Thompson et al. 2012' }
    : { topic: L('Значимый смерч', 'Significant tornado'), verdict: L(`${pct(share)} у суперячейки`, `${pct(share)} for a supercell`), level: share >= .3 ? 3 : share >= .15 ? 2 : 1,
      detail: L(`эффективный STP ${f1(stp)}: столько суперячеек с таким STP (из давших смерч или сильный град, ветер) дали смерч EF2+; модель сам смерч не разрешает — только признаки`, `effective STP ${f1(stp)}: this share of the supercells with such an STP (of those with a tornado or significant hail or wind) gave an EF2+ tornado; the model does not resolve the tornado itself — only its signs`), source: L('Thompson et al. 2012, табл. 5', 'Thompson et al. 2012, Table 5') })
  out.push({ topic: L('Крупный град', 'Large hail'), verdict: k.ship >= 1 ? L('вероятен (от 5 см)', 'likely (5 cm and larger)') : k.ship >= .5 ? L('возможен', 'possible') : L('маловероятен', 'unlikely'), level: k.ship >= 2 ? 3 : k.ship >= 1 ? 2 : k.ship >= .5 ? 1 : 0,
    detail: L(`SHIP ${f1(k.ship)}; в модели град меньше природного (одномоментная схема)`, `SHIP ${f1(k.ship)}; the model's hail is smaller than nature's (one-moment scheme)`), source: 'SPC, Johnson & Sugden 2014' })
  out.push({ topic: L('Долгий шквал', 'Long-lived wind storm'), verdict: k.dcp >= 4 ? L('вероятен, если грозы встанут в линию', 'likely if storms form a line') : k.dcp >= 2 ? L('возможен в линии', 'possible in a line') : L('маловероятен', 'unlikely'), level: k.dcp >= 4 ? 2 : k.dcp >= 2 ? 1 : 0,
    detail: L(`DCP ${f1(k.dcp)}, DCAPE ${p.dcape.toFixed(0)} Дж/кг: от 2 — оттоки и поток достаточны для деречо`, `DCP ${f1(k.dcp)}, DCAPE ${p.dcape.toFixed(0)} J/kg: from 2 the outflows and flow suffice for a derecho`), source: 'Evans & Doswell 2001' })
  return out
}
