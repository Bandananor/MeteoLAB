import { describe, expect, it } from 'vitest'
import { createGrid, DEFAULT_GRID, levelAt } from './grid'

describe('vertical grid', () => {
  it('keeps the uniform grid exactly: spacings dz, half a layer at ground and top', () => {
    const g = createGrid()
    expect(g.uniform).toBe(true)
    expect(g.zs[g.nz - 1]).toBeCloseTo(g.height, 9)
    expect([...g.dzs].every(s => s === g.dz)).toBe(true)
    expect(g.hz[0]).toBe(g.dz / 2); expect(g.hz[5]).toBe(g.dz); expect(g.hz[g.nz - 1]).toBe(g.dz / 2)
  })

  it('stretches geometrically from the given spacing at the ground to the top', () => {
    const g = createGrid({ ...DEFAULT_GRID, nz: 40, bottomSpacing: 100 })
    expect(g.uniform).toBe(false)
    expect(g.zs[0]).toBe(0); expect(g.zs[g.nz - 1]).toBeCloseTo(g.height, 6)
    expect(g.dzs[0]).toBeCloseTo(100, 6)
    for (let k = 1; k < g.nz - 1; k++) expect(g.dzs[k]).toBeGreaterThan(g.dzs[k - 1])
    // The control volumes tile the column.
    expect(g.hz.reduce((a, b) => a + b, 0)).toBeCloseTo(g.height, 6)
    // levelAt inverts zs.
    for (const k of [0, 3, 17, 39]) expect(levelAt(g, g.zs[k])).toBeCloseTo(k, 9)
    expect(levelAt(g, (g.zs[4] + g.zs[5]) / 2)).toBeCloseTo(4.5, 9)
  })
})
