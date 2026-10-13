import { describe, expect, it } from 'vitest'
import { AtmosphereModel, coldDepth, createGrid, densityCurrentSpeed, domainGrid, DT, type FrontConfig, frontalDeficit, frontDistance } from '.'
import { QUIET } from './fixtures'

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
