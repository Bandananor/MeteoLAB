import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, DT, EDGE_TIME } from '.'
import { QUIET } from './fixtures'

// 48 x 36 km with few levels: the 12 km zone leaves an interior of 24 x 12 km.
const grid = () => createGrid({ nx: 40, ny: 30, nz: 12, width: 48_000, depth: 36_000, height: 15_000, bottomSpacing: 100 })

describe('relaxed side boundaries (SimConfig.edges)', () => {
  it('pulls the air at the domain edge back to the environment and leaves the interior alone', () => {
    const make = (edges?: 'relaxed') => {
      const m = new AtmosphereModel({ ...QUIET, bubble: 0, solarMax: 0, followStorm: false, edges }, grid()), { nx, layer } = m.grid
      // Hail, warmth and moisture at the ground of an edge column (x = 0) and of the centre column.
      for (const c of [15 * nx, 15 * nx + 20]) { m.hail[c + layer] = 1e-3; m.theta[c + layer] += 2; m.q[c + layer] += 1e-3 }
      return m
    }
    const periodic = make(), relaxed = make('relaxed'), { nx, layer } = relaxed.grid
    for (let t = 0; t < 60; t += DT) for (const m of [periodic, relaxed]) { m.step(DT); m.time += DT }
    const edge = 15 * nx + layer, centre = edge + 20
    // At the edge the hail is pulled out with an e-folding of ~EDGE_TIME (300 s) on top of what the periodic run does.
    expect(relaxed.hail[edge]).toBeLessThan(periodic.hail[edge] * Math.exp(-60 / EDGE_TIME * .8))
    expect(relaxed.theta[edge] - relaxed.env.thetaEnv(relaxed.grid.zs[1])).toBeLessThan(periodic.theta[edge] - periodic.env.thetaEnv(periodic.grid.zs[1]))
    // In the interior nothing changes in the first minute (the pressure only links them through the round-off).
    expect(relaxed.hail[centre]).toBeCloseTo(periodic.hail[centre], 8)
    expect(relaxed.theta[centre]).toBeCloseTo(periodic.theta[centre], 3)
  })

  it('keeps a maintained front: the cold side stays cold near the ground, the warm side is left alone', () => {
    const m = new AtmosphereModel({ ...QUIET, bubble: 0, solarMax: 0, followStorm: false, edges: 'relaxed', front: 3 }, grid()), { nx, ny } = m.grid
    const anomaly = (y: number, x = 20) => m.theta[x + y * nx] - m.env.thetaEnv(0)
    expect(anomaly(ny - 9)).toBeCloseTo(-3, 1); expect(anomaly(8)).toBeCloseTo(0, 1)
    // The front ends at 60 % of the width (28.8 km): none at 36 km.
    expect(anomaly(ny - 9, 30)).toBeCloseTo(0, 1)
    // Ten minutes: the cold air spreads as a density current, but the cold side keeps most of its deficit.
    for (let t = 0; t < 600; t += DT) { m.step(DT); m.time += DT }
    expect(anomaly(ny - 9)).toBeLessThan(-2); expect(Math.abs(anomaly(3))).toBeLessThan(.5)
    expect(m.clipped).toBe(0)
  })
})
