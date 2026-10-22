import { describe, expect, it } from 'vitest'
import { AIR_MASSES, buildSituation, createGrid, Environment, environmentProfile, FRONT_ARRIVAL, frontDistance, parcelIndices, SCENARIOS, SHEARS, storyStage, TRIGGERS } from '.'
import { SUMMER_DAY } from './fixtures'
import { CASES, passes, SITUATIONS } from '../validation/cases'

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

// The ready situations (slow): each with and without what drives its story; the runs and their checks are in
// src/validation/cases.ts (shared with the validation report). STORMLAB_SITUATION=<k> runs only the k-th (the cloud runs
// each in its own job). ~10-25 min on a laptop per situation (two runs of 2-3 h).
const slow = (import.meta as { env?: { MODE?: string } }).env?.MODE === 'slow'
const only = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env?.STORMLAB_SITUATION
describe('the ready situations (slow)', () => {
  for (const [k, name] of SITUATIONS.entries()) it.runIf(slow && (only === undefined || Number(only) === k))(`situation ${k}: ${name}`, () => {
    const r = CASES.find(c => c.id === `situation-${k}`)!.run()
    console.log(`Ситуация «${name}»: ${r.checks.map(c => `${c.quantity} ${c.value.toFixed(1)}`).join('; ')}`)
    expect(r.checks.filter(c => !passes(c)).map(c => `${c.quantity} = ${c.value}`)).toEqual([])
  }, 7_200_000)
})
