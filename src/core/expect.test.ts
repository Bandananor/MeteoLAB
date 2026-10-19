import { describe, expect, it } from 'vitest'
import { createGrid, domainGrid, Environment, expectations, parcelIndices, SCENARIOS, SIGTOR_BY_STP, stormIndices } from '.'
import { SUMMER_DAY } from './fixtures'

// Thompson et al. (2012), Table 5: the cumulative share of the effective-layer STP ≥ 0.5, 1, 2, 4, 6 for each class of
// right-moving supercells (no tornado, EF0, EF1, EF2, EF3, EF4+), and the class's count.
const TABLE5: [number[], number][] = [[[.33, .2, .1, .03, .01], 1966], [[.59, .43, .25, .09, .03], 2693], [[.69, .54, .33, .13, .05], 1573], [[.78, .65, .44, .23, .09], 662], [[.84, .75, .55, .3, .16], 269], [[.94, .92, .83, .66, .42], 71]]

describe('what to expect (2.8)', () => {
  it('takes the share of significant tornadoes by STP from Thompson et al. (2012), Table 5', () => {
    // Supercells with STP ≥ x of each class; the EF2+ classes are the last three.
    const above = (k: number) => TABLE5.map(([share, n]) => k < 0 ? n : share[k] * n)
    const bins = [-1, 0, 1, 2, 3, 4], sig = (a: number[]) => a[3] + a[4] + a[5], all = (a: number[]) => a.reduce((x, y) => x + y)
    bins.forEach((k, b) => {
      const lo = above(k), hi = b + 1 < bins.length ? above(bins[b + 1]) : lo.map(() => 0)
      const share = (sig(lo) - sig(hi)) / (all(lo) - all(hi))
      expect(Math.abs(share - SIGTOR_BY_STP[b][1])).toBeLessThan(.01)
    })
  })

  it('reads the scenarios as a forecaster would', () => {
    const say = (name: string, more: object = {}) => {
      const c = { ...SUMMER_DAY, ...SCENARIOS.find(s => s.name === name)!.values, ...more }, env = new Environment(c, createGrid(domainGrid(c.domain, c.top, c.domainSize)))
      return Object.fromEntries(expectations(parcelIndices(env, 18_000), stormIndices(env, parcelIndices(env, 18_000))).map(e => [e.topic, e]))
    }
    const sc = say('Классическая суперячейка'), day = say('Летний день'), dry = say('Летний день', { rhSurface: 20, rhLow: 20, rhMid: 15 }), multi = say('Многоячейковая гроза')
    expect(sc['Режим'].verdict).toBe('суперячейки'); expect(sc['Суперячейка'].level).toBeGreaterThanOrEqual(2); expect(sc['Крупный град'].level).toBeGreaterThanOrEqual(2)
    expect(day['Режим'].verdict).toBe('одиночные и многоячейковые'); expect(day['Значимый смерч'].level).toBe(0)
    // A dry day: no deep convection, nothing more to expect; the multicell storm: SCP 2 but little shear over the storm.
    expect(dry['Гроза'].level).toBe(0); expect(Object.keys(dry)).toHaveLength(1)
    expect(multi['Суперячейка'].level).toBeLessThanOrEqual(1)
  })
})
