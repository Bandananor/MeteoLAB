import { describe, expect, it } from 'vitest'
import { AtmosphereModel, coldDepth, createGrid, densityCurrentSpeed, domainGrid, DT, type FrontConfig, frontalDeficit, frontDistance, SCENARIOS } from '.'
import { QUIET, SUMMER_DAY } from './fixtures'

const cold: FrontConfig = { kind: 'cold', contrast: 6, depth: 1.5, slope: 80, speed: 8, heading: 90, start: -10 }

describe('moving fronts (2.5)', () => {
  it('the wedge: cold air behind a cold front (with its head) and ahead of a warm one (thin), deepening by the slope up to its depth', () => {
    // 48 x 36 km domain, the front 10 km west of the centre heading east: the centre is 10 km ahead of it.
    expect(frontDistance(cold, 24_000, 18_000, 0, 48_000, 36_000)).toBeCloseTo(10)
    // Ten minutes at 8 m/s: 4.8 km nearer.
    expect(frontDistance(cold, 24_000, 18_000, 600, 48_000, 36_000)).toBeCloseTo(5.2)
    // The cold front's head: half the depth within 2 km of the line, then the slope.
    expect(coldDepth(cold, 5)).toBe(0); expect(coldDepth(cold, -1)).toBeCloseTo(.375 + 1 / 80); expect(coldDepth(cold, -40)).toBeCloseTo(1.25); expect(coldDepth(cold, -400)).toBe(1.5)
    const warm: FrontConfig = { ...cold, kind: 'warm', slope: 200 }
    expect(coldDepth(warm, -5)).toBe(0); expect(coldDepth(warm, 100)).toBeCloseTo(.5)
    // The contrast below the frontal surface, none well above it.
    expect(frontalDeficit(cold, -400, 100)).toBe(6); expect(frontalDeficit(cold, -400, 2000)).toBe(0); expect(frontalDeficit(cold, -400, 1500)).toBeCloseTo(3)
    // A 6 K, 1.5 km deep cold air mass runs by itself at ~12 m/s.
    expect(densityCurrentSpeed(cold)).toBeCloseTo(12, 0)
  })

  it('a cold front advances at its speed and lifts the warm air at its nose', () => {
    const config = { ...QUIET, followStorm: false, bubble: 0, frontLine: cold, domain: 'custom' as const, domainSize: [48, 36] as [number, number] }
    const m = new AtmosphereModel(config, createGrid(domainGrid('custom', undefined, [48, 36]))), { nx, layer, dx } = m.grid
    expect(m.edges()).toBe('relaxed')
    const row = 16 * nx, ground = (xKm: number) => m.theta[Math.round(xKm * 1000 / dx) + row] - m.env.theta[0]
    // At the start the cold air is behind the line at 14 km (west; the wedge thin near it: 150 m at 12 km behind), not ahead.
    expect(ground(2)).toBeLessThan(-5); expect(Math.abs(ground(22))).toBeLessThan(.3)
    for (let k = 0; k < 1200 / DT; k++) { m.step(DT); m.time += DT }
    // 20 minutes at 8 m/s: the line has gone 9.6 km east, to ~23.6 km — the air at 20 km is now cold.
    expect(ground(20)).toBeLessThan(-2.5)
    expect(Math.abs(ground(32))).toBeLessThan(1)
    // The warm air rises over the nose of the wedge.
    let lift = 0
    for (let z = 1; z < 20 && m.grid.zs[z] < 2500; z++) for (let x = 0; x < nx; x++) lift = Math.max(lift, m.w[x + row + z * layer])
    expect(lift).toBeGreaterThan(.5)
  })
})

// The «Холодный фронт» scenario (2.5): a moist warm sector under a weak lid where nothing grows without a trigger; the
// cold front breaks the lid and storms grow along it. Calibration 2026-10-13 (50 min): without the front w <3.5 m/s and
// no cloud above 1.8 km; with it cells from 35 min, 43 m/s and tops 11 km at 50. Slow (~15 min on a laptop: two runs of
// 50 simulated minutes): `npx vitest run --mode slow src/core/fronts.test.ts`, or in the cloud (slow-tests.yml).
const slow = (import.meta as { env?: { MODE?: string } }).env?.MODE === 'slow'
describe('the cold front scenario (slow)', () => {
  it.runIf(slow)('cold front: nothing grows without it; with it the lid breaks and storms grow along it within 50 minutes', () => {
    const scenario = SCENARIOS.find(s => s.name === 'Холодный фронт')!, run = (frontLine: FrontConfig | undefined) => {
      const model = new AtmosphereModel({ ...SUMMER_DAY, ...scenario.values, frontLine })
      let maxW = 0, top = 0, wAt40 = 0
      for (let t = DT; t <= 50 * 60; t += DT) {
        model.step(DT); model.time += DT
        if (t % 60) continue
        const d = model.diagnostics(); maxW = Math.max(maxW, d.updraft); top = Math.max(top, d.cloudTop)
        if (t === 40 * 60) wAt40 = maxW
      }
      return { maxW, top, wAt40, clipped: model.clipped }
    }
    const without = run(undefined), withFront = run(scenario.values.frontLine)
    console.log(`Холодный фронт: without the front w ${without.maxW.toFixed(1)} m/s, tops ${without.top.toFixed(1)} km; with it w ${withFront.wAt40.toFixed(1)} by 40 min, ${withFront.maxW.toFixed(1)} m/s and tops ${withFront.top.toFixed(1)} km by 50, clipped ${withFront.clipped}`)
    expect(without.maxW).toBeLessThan(8); expect(without.top).toBeLessThan(3)
    expect(withFront.maxW).toBeGreaterThan(25); expect(withFront.top).toBeGreaterThan(8)
    expect(withFront.maxW).toBeLessThanOrEqual(55); expect(withFront.clipped).toBe(0)
  }, 3_600_000)
})
