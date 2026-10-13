// Signs of tornadogenesis (2.5; a tester: «I need a determination»): the model tells whether its storm shows what
// forecasters look for before a tornado, instead of leaving the user to put the numbers together. The tornado itself
// is far below the ~1 km grid; these are its signs: rotation of the updraught at the ground held for minutes, a
// mesocyclone above it, the environment of the inflow (STP, SRH 0-1 km, a low cloud base) and an outflow not too cold
// (a very cold rear-flank downdraught is known to shut tornadoes off).
import { MESO_PERSISTENCE } from './model'
import { UH01_LOW_MESO } from './spin'

export interface TornadoThresholds {
  /** UH 0-1 km of the rotation at the ground, m²/s², and how long it must hold, min. */
  uh01: number; held: number
  /** STP and SRH 0-1 km (m²/s²) of the environment at least, the cloud base (LCL, km) at most. */
  stp: number; srh01: number; lcl: number
  /** The outflow at most this cold, K (the cold pool's deficit). */
  cold: number
}

/** Defaults: the model's low-mesocyclone level (spin.ts), the usual forecasting thresholds (Thompson et al. 2003, Markowski & Richardson 2010). */
export const TORNADO_DEFAULTS: TornadoThresholds = { uh01: UH01_LOW_MESO, held: 3, stp: 1, srh01: 100, lcl: 1.5, cold: 6 }

/** What the detector reads: the storm now and the environment around it. */
export interface TornadoInput {
  /** UH 0-1 km now, m²/s², and how long (s) it has stayed at the threshold. */
  uh01: number; lowHeld: number
  /** How long (s) the mid-level mesocyclone has held (RotationState.persisted). */
  mesoHeld: number
  stp: number; srh01: number; lcl: number | null
  /** The strongest cold-pool deficit, K. */
  cold: number
}

export interface TornadoCheck { name: string; ok: boolean; value: string }

/** 0 none, 1 a favourable environment, 2 a low mesocyclone, 3 signs of tornadogenesis. */
export type TornadoLevel = 0 | 1 | 2 | 3
export const TORNADO_LEVELS: Record<TornadoLevel, string> = { 0: 'нет', 1: 'благоприятная среда', 2: 'низкий мезоциклон', 3: 'признаки смерчеобразования' }

/** The level and every condition with its value. */
export function tornadoSigns(s: TornadoInput, t: TornadoThresholds = TORNADO_DEFAULTS): { level: TornadoLevel; checks: TornadoCheck[] } {
  const low = s.uh01 >= t.uh01 && s.lowHeld >= t.held * 60, meso = s.mesoHeld >= MESO_PERSISTENCE
  const stp = s.stp >= t.stp, srh = s.srh01 >= t.srh01, lcl = s.lcl !== null && s.lcl <= t.lcl, cold = s.cold <= t.cold
  const environment = stp && srh && lcl
  const level: TornadoLevel = low && meso && environment && cold ? 3 : low ? 2 : environment ? 1 : 0
  const f = (v: number, d = 0) => v.toFixed(d).replace('.', ',')
  return {
    level, checks: [
      { name: `Вращение у земли: UH 0–1 км ≥ ${t.uh01} не меньше ${t.held} мин`, ok: low, value: `${f(s.uh01)} м²/с², ${f(s.lowHeld / 60, 1)} мин` },
      { name: 'Мезоциклон 2–5 км над ним', ok: meso, value: meso ? `${f(s.mesoHeld / 60)} мин` : 'нет' },
      { name: `STP ≥ ${f(t.stp, 1)}`, ok: stp, value: f(s.stp, 1) },
      { name: `SRH 0–1 км ≥ ${t.srh01}`, ok: srh, value: `${f(s.srh01)} м²/с²` },
      { name: `Основание облака (LCL) ≤ ${f(t.lcl, 1)} км`, ok: lcl, value: s.lcl === null ? '—' : `${f(s.lcl, 1)} км` },
      { name: `Отток не холоднее ${f(t.cold)} K`, ok: cold, value: `${f(s.cold, 1)} K` },
    ],
  }
}
