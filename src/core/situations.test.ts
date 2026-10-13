import { describe, expect, it } from 'vitest'
import { AIR_MASSES, AtmosphereModel, buildSituation, createGrid, DT, Environment, environmentProfile, FRONT_ARRIVAL, frontDistance, parcelIndices, SCENARIOS, SHEARS, type SimConfig, storyStage, TRIGGERS } from '.'
import { SUMMER_DAY } from './fixtures'

describe('synoptic situations (2.6)', () => {
  it('every air mass is a summer environment within the model range: CAPE from some hundreds to 4 kJ/kg', () => {
    const grid = createGrid()
    for (const mass of Object.keys(AIR_MASSES) as (keyof typeof AIR_MASSES)[]) {
      const b = buildSituation({ mass, trigger: 'sun', shear: 'weak', hour: 10 }, SUMMER_DAY), config = { ...SUMMER_DAY, ...b.values }
      const sb = parcelIndices(new Environment(config, grid, environmentProfile(config, grid.height)), grid.height).sb
      expect(sb.cape, mass).toBeGreaterThan(300); expect(sb.cape, mass).toBeLessThan(4000)
    }
  })

  it('a front reaches the centre of the moving domain when the story says', () => {
    const grid = createGrid()
    for (const trigger of ['coldFront', 'warmFront'] as const) for (const shear of Object.keys(SHEARS) as (keyof typeof SHEARS)[]) {
      const b = buildSituation({ mass: 'continental', trigger, shear, hour: 10 }, SUMMER_DAY), [fx, fy] = b.values.frameMotion!, f = b.values.frontLine!
      const at = (h: number) => frontDistance(f, grid.width / 2 + fx * h * 3600, grid.depth / 2 + fy * h * 3600, h * 3600, grid.width, grid.depth)
      expect(Math.abs(at(FRONT_ARRIVAL)), `${trigger} ${shear}`).toBeLessThan(.5)
      // km ahead of the front (positive): at the start it is outside the standard domain (its corners lie within ~27 km of the centre along any heading near east).
      expect(at(0)).toBeGreaterThan(27)
    }
  })

  it('the advection of a trigger is a copy, and the story stage follows the time', () => {
    const b = buildSituation({ mass: 'maritime', trigger: 'trough', shear: 'moderate', hour: 11 }, SUMMER_DAY)
    expect(b.values.largeScale).toEqual(TRIGGERS.trough.largeScale); expect(b.values.largeScale![0]).not.toBe(TRIGGERS.trough.largeScale[0])
    expect(b.values.hour).toBe(11); expect(b.values.bubble).toBe(0); expect(b.values.frontLine).toBeUndefined()
    const story = TRIGGERS.trough.story
    expect(storyStage(story, 0)).toBe(0); expect(storyStage(story, 3600)).toBe(1); expect(storyStage(story, 10 * 3600)).toBe(story.length - 1)
  })

  it('the ready situations tell their story from the start, in order', () => {
    const ready = SCENARIOS.filter(s => s.story)
    for (const s of ready) { expect(s.story![0][0]).toBe(0); expect(s.story!.every(([h], k) => k === 0 || h > s.story![k - 1][0])).toBe(true) }
  })
})

// The ready situations (slow): each with and without what drives its story, as calibrated on 2026-10-13. STORMLAB_SITUATION=<k>
// runs only the k-th (the cloud runs each in its own job). ~20-40 min on a laptop per situation (two runs of 2-3 h).
const slow = (import.meta as { env?: { MODE?: string } }).env?.MODE === 'slow'
const only = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env?.STORMLAB_SITUATION
/** Max updraught (whole run and from `lateFrom` min on, the mean of the minute maxima) and the highest cloud top. */
function run(values: Partial<SimConfig>, minutes: number, lateFrom = Infinity) {
  const model = new AtmosphereModel({ ...SUMMER_DAY, ...values })
  let maxW = 0, top = 0, late = 0, lateN = 0
  for (let t = DT; t <= minutes * 60; t += DT) {
    model.step(DT); model.time += DT
    if (t % 60) continue
    const d = model.diagnostics(); maxW = Math.max(maxW, d.updraft); top = Math.max(top, d.cloudTop)
    if (t >= lateFrom * 60) { late += d.updraft; lateN++ }
  }
  return { maxW, top, late: lateN ? late / lateN : 0, clipped: model.clipped }
}
const CHECKS: Record<string, () => void> = {
  'Тёплый сектор и холодный фронт': () => {
    const s = SCENARIOS.find(x => x.name === 'Тёплый сектор и холодный фронт')!, front = run(s.values, 120), none = run({ ...s.values, frontLine: undefined }, 120)
    console.log(`Ситуация «${s.name}»: с фронтом w ${front.maxW.toFixed(1)} м/с, вершины ${front.top.toFixed(1)} км; без фронта w ${none.maxW.toFixed(1)}`)
    expect(front.clipped).toBe(0); expect(front.maxW).toBeGreaterThan(25); expect(front.top).toBeGreaterThan(10); expect(none.maxW).toBeLessThan(10)
  },
  'Высотная ложбина': () => {
    const s = SCENARIOS.find(x => x.name === 'Высотная ложбина')!, trough = run(s.values, 180, 150), plain = run({ ...s.values, largeScale: undefined }, 180, 150)
    console.log(`Ситуация «${s.name}»: w ${trough.maxW.toFixed(1)}, в 12:30-13:00 ${trough.late.toFixed(1)} м/с; без ложбины ${plain.maxW.toFixed(1)}, в 12:30-13:00 ${plain.late.toFixed(1)}`)
    expect(trough.clipped).toBe(0); expect(trough.maxW).toBeGreaterThan(20); expect(plain.maxW).toBeGreaterThan(15)
    expect(trough.late).toBeGreaterThan(8); expect(trough.late).toBeGreaterThan(plain.late + 4)
  },
  'Тёплая адвекция: грозы не будет': () => {
    const s = SCENARIOS.find(x => x.name === 'Тёплая адвекция: грозы не будет')!, capped = run(s.values, 120), plain = run({ ...s.values, largeScale: undefined }, 120)
    console.log(`Ситуация «${s.name}»: с тёплым воздухом наверху w ${capped.maxW.toFixed(1)}, вершины ${capped.top.toFixed(1)} км; без него w ${plain.maxW.toFixed(1)}, вершины ${plain.top.toFixed(1)} км`)
    expect(capped.maxW).toBeLessThan(8); expect(capped.top).toBeLessThan(4); expect(plain.maxW).toBeGreaterThan(20); expect(plain.top).toBeGreaterThan(8)
  },
}
describe('the ready situations (slow)', () => {
  const names = Object.keys(CHECKS)
  for (const [k, name] of names.entries()) it.runIf(slow && (only === undefined || Number(only) === k))(`situation ${k}: ${name}`, CHECKS[name], 7_200_000)
})
