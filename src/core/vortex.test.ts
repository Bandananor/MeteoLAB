import { describe, expect, it } from 'vitest'
import { createGrid, DEFAULT_GRID, VORTEX_TOP, vortexColumn } from '.'

describe('the mesocyclone as a column (2.8)', () => {
  it('follows the rotation level by level as it tilts, from where it starts near the ground to where it ends', () => {
    const grid = createGrid({ ...DEFAULT_GRID, nx: 30, ny: 30, width: 30 * 1200, depth: 30 * 1200 }), { zs, dx } = grid
    // A vortex of 0.02 s-1 (Gaussian, ~1.5 km) leaning east by one column per km, from 500 m to 7 km.
    const centre = (k: number) => 10 + Math.round(zs[k] / 1000)
    const zeta = (x: number, y: number, k: number) => zs[k] < 500 || zs[k] > 7000 ? 0 : .02 * Math.exp(-((x - centre(k)) ** 2 + (y - 15) ** 2) / 2)
    const levels = vortexColumn({ grid, zeta }, 13 + 30 * 15)
    expect(levels[0].z).toBeGreaterThanOrEqual(500); expect(levels[0].z).toBeLessThan(1000)
    expect(levels[levels.length - 1].z).toBeLessThanOrEqual(7000); expect(levels[levels.length - 1].z).toBeGreaterThan(6000)
    for (const l of levels) {
      const k = zs.indexOf(l.z)
      expect(l.x).toBe(centre(k) * dx); expect(l.y).toBe(15 * dx); expect(l.zeta).toBeCloseTo(.02, 6)
      expect(l.radius).toBeGreaterThan(1000); expect(l.radius).toBeLessThan(2500)
    }
    // No rotation where it starts: no column.
    expect(vortexColumn({ grid, zeta: () => 0 }, 0)).toEqual([])
    expect(VORTEX_TOP).toBeGreaterThan(7000)
  })
})
