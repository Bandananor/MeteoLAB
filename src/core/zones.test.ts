import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, DEFAULT_GRID, DT, zoneMaps } from '.'
import { QUIET } from './fixtures'

const grid = createGrid(DEFAULT_GRID), { nx, dx, dy } = grid
/** A square zone, km. */
const square = (x0: number, y0: number, size: number, temperature: number, moisture: number) =>
  ({ points: [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size]] as [number, number][], temperature, moisture })
const column = (xKm: number, yKm: number) => Math.round(xKm * 1000 / dx) + nx * Math.round(yKm * 1000 / dy)

describe('zones of the environment (2.4)', () => {
  it('a zone covers its polygon on the ground, with a blurred border; a later zone replaces an earlier one where it lies', () => {
    const maps = zoneMaps(grid, [square(6, 6, 18, 3, 2), square(18, 6, 12, -2, 0)])!
    // Well inside the first zone only.
    expect(maps.share[column(10.8, 13.5)]).toBe(1); expect(maps.theta[column(10.8, 13.5)]).toBeCloseTo(3); expect(maps.vapour[column(10.8, 13.5)]).toBeCloseTo(.002)
    // Well inside the second (over the first): its values.
    expect(maps.theta[column(26.4, 13.5)]).toBeCloseTo(-2); expect(maps.vapour[column(26.4, 13.5)]).toBeCloseTo(0)
    // Far away: nothing; on the first zone's western border: half.
    expect(maps.share[column(40.8, 31.5)]).toBe(0)
    expect(maps.share[column(6, 13.5)]).toBeCloseTo(.5, 1)
    expect(zoneMaps(grid, [])).toBeNull()
  })

  it('without a storm a zone keeps most of its warmer, moister air near the ground, makes a breeze, and the air away from it stays as it was', () => {
    const small = createGrid({ ...DEFAULT_GRID, nx: 20, ny: 16, width: 24_000, depth: 18_000 })
    const m = new AtmosphereModel({ ...QUIET, followStorm: false, zones: [square(4.8, 4.5, 9.6, 3, 2)] }, small), { layer } = small
    const at = (xKm: number, yKm: number, z: number) => Math.round(xKm * 1000 / small.dx) + small.nx * Math.round(yKm * 1000 / small.dy) + z * layer
    const inside = at(9.6, 9, 0), outside = at(20.4, 1.1, 0), dTheta = (i: number) => m.theta[i] - m.env.theta[0], dq = (i: number) => (m.q[i] - m.env.q[0]) * 1000
    expect(dTheta(inside)).toBeCloseTo(3 / m.env.exner[0], 1); expect(dq(inside)).toBeCloseTo(2, 1)
    expect(Math.abs(dTheta(outside))).toBeLessThan(.05)
    for (let k = 0; k < 1200 / DT; k++) { m.step(DT); m.time += DT }
    let wind = 0
    for (let i = 0; i < 6 * layer; i++) wind = Math.max(wind, Math.hypot(m.u[i] - m.env.u[Math.floor(i / layer)], m.v[i] - m.env.v[Math.floor(i / layer)]))
    // (The domain stays put: the columns stay over the same ground.) After 20 minutes the zone still holds most of its difference; outside it, little has leaked.
    expect(dTheta(inside)).toBeGreaterThan(2.3); expect(dq(inside)).toBeGreaterThan(1.1)
    expect(Math.abs(dTheta(outside))).toBeLessThan(.3)
    // A warm zone is a heat low: its air rises where it leaves the zone, and the air around converges on its border — a
    // breeze of a few m/s, as at a coast or a city (measured 7 m/s for +3 K over 10 km), which can start storms there.
    expect(wind).toBeGreaterThan(1); expect(wind).toBeLessThan(10)
  })
})
