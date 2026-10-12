import { describe, expect, it } from 'vitest'
import { createGrid, domainGrid, Environment, parseSounding, soundingProfile, type SimConfig } from './core'
import { SUMMER_DAY } from './core/fixtures'
import { DEFAULTS } from './defaults'
import { decodeSettings, encodeSettings } from './share'
import { HODOGRAPH_NODES, nodeWeight, nudgeSounding, sliderNode, speedDirection } from './hodograph'
import oun2011 from '../tests/fixtures/soundings/oun-2011-05-22-12z.txt?raw'

const grid = createGrid(domainGrid(undefined))

describe('hodograph editor (2.2)', () => {
  it('speed and direction: the wind blows from the direction, as the sliders mean it', () => {
    expect(speedDirection(0, 10)).toEqual({ speed: 10, dir: 180 }) // northward: from the south
    expect(speedDirection(10, 0).dir).toBeCloseTo(270, 9) // eastward: from the west
    expect(speedDirection(-3, -4).speed).toBeCloseTo(5, 9); expect(speedDirection(-3, -4).dir).toBeCloseTo(36.87, 2)
    expect(speedDirection(0, 0)).toEqual({ speed: 0, dir: 0 })
  })

  it('a dragged slider handle puts the environment wind at its height where it was dropped', () => {
    for (let k = 0; k < HODOGRAPH_NODES.length; k++) {
      const config: SimConfig = { ...SUMMER_DAY, wind05: 4, wind1: 6, windDir05: 170, windDir1: 175, ...sliderNode(k, 7.3, -12.6, 40) }
      const [u, v] = new Environment(config, grid).windUV(HODOGRAPH_NODES[k].z)
      expect(Math.hypot(u - 7.3, v + 12.6)).toBeLessThan(.15)
    }
    // Not beyond the slider's range.
    expect(sliderNode(3, 60, 0, 40).wind3).toBe(40)
  })

  it('weights: 1 at the handle, 0 at its neighbours, the ground handle holds below, the top one fades by 13 km', () => {
    expect(nodeWeight(3, 3000)).toBe(1); expect(nodeWeight(3, 1000)).toBe(0); expect(nodeWeight(3, 6000)).toBe(0); expect(nodeWeight(3, 2000)).toBeCloseTo(.5, 9)
    expect(nodeWeight(0, 0)).toBe(1); expect(nodeWeight(0, 250)).toBeCloseTo(.5, 9); expect(nodeWeight(0, 600)).toBe(0)
    expect(nodeWeight(5, 11_500)).toBeCloseTo(.5, 9); expect(nodeWeight(5, 14_000)).toBe(0)
  })

  it('a dragged sounding handle moves the model wind at its height exactly and leaves the layers past its neighbours', () => {
    const levels = parseSounding(oun2011).levels, before = new Environment(SUMMER_DAY, grid, soundingProfile({ levels }, grid.height).profile)
    for (const k of [0, 2, 4, 5]) {
      const z = HODOGRAPH_NODES[k].z, edited = nudgeSounding(levels, k, 5, -3)
      const after = new Environment(SUMMER_DAY, grid, soundingProfile({ levels: edited }, grid.height).profile)
      const [u0, v0] = before.windUV(z), [u1, v1] = after.windUV(z)
      expect(u1 - u0).toBeCloseTo(5, 6); expect(v1 - v0).toBeCloseTo(-3, 6)
      // Outside the neighbouring handles (and above 13 km) nothing changes; temperature and moisture never do.
      for (const h of [0, 500, 1000, 3000, 6000, 10_000, 14_000].filter(h => nodeWeight(k, h) === 0)) expect(after.windUV(h)).toEqual(before.windUV(h))
      for (let h = 0; h <= 12_000; h += 500) { expect(after.thetaEnv(h)).toBeCloseTo(before.thetaEnv(h), 3); expect(after.qEnv(h)).toBeCloseTo(before.qEnv(h), 6) }
    }
    // The input is not changed; levels are added only where the data has none (the ground always has one).
    const copy = JSON.stringify(levels), edited = nudgeSounding(levels, 3, 1, 1)
    expect(JSON.stringify(levels)).toBe(copy)
    expect(edited.length - levels.length).toBe([1000, 3000, 6000].filter(z => !levels.some(l => Math.abs(l.z - z) < 1)).length)
    expect(nudgeSounding(levels, 0, 1, 1)).toHaveLength(levels.length + (levels.some(l => Math.abs(l.z - 500) < 1) ? 0 : 1))
  })

  it('an edited sounding goes into a link and comes back, with its added levels', () => {
    const levels = nudgeSounding(nudgeSounding(parseSounding(oun2011).levels, 2, 6, 2), 4, -4, 3), config: SimConfig = { ...DEFAULTS, sounding: { name: 'OUN', levels } }
    const back = decodeSettings(encodeSettings(config, DEFAULTS, null), [])!.values.sounding!
    expect(back.levels).toHaveLength(levels.length)
    for (const [k, l] of levels.entries()) { expect(back.levels[k].u!).toBeCloseTo(l.u!, 2); expect(back.levels[k].z).toBe(Math.round(l.z)) }
  })
})
