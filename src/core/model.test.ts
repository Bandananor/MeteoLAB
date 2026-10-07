import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, DEFAULT_GRID } from '.'
import { run, SUMMER_DAY as summerDay } from './fixtures'

const fields = ['u', 'v', 'w', 'theta', 'q', 'cloud', 'rain', 'cold', 'pressure'] as const
const allFinite = (m: AtmosphereModel) => fields.every(f => m[f].every(Number.isFinite))

describe('AtmosphereModel', () => {
  it('runs without a browser on the default grid', () => {
    const m = new AtmosphereModel({ ...summerDay })
    run(m, 120)
    expect(allFinite(m)).toBe(true)
    expect(m.sounding.cape).toBeGreaterThan(0)
  })

  it('takes the grid size as a parameter', () => {
    const grid = createGrid({ nx: 20, ny: 16, nz: 12, width: 24_000, depth: 18_000, height: 15_000 })
    const m = new AtmosphereModel({ ...summerDay }, grid)
    expect(m.u.length).toBe(20 * 16 * 12)
    expect(m.uhColumn.length).toBe(20 * 16)
    run(m, 60)
    expect(allFinite(m)).toBe(true)
  })

  it('counts updraught cores by height on the stretched grid', () => {
    const m = new AtmosphereModel({ ...summerDay }), { nx, layer, zs } = m.grid
    m.w.fill(0); m.cloud.fill(0); m.ice.fill(0)
    // Cloudy cores at 2-6 km on two separate columns, and one only below 1.2 km (under cloud base): two cores.
    const core = (x: number, y: number, lo: number, hi: number) => zs.forEach((z, k) => { if (z >= lo && z <= hi) { m.w[x + nx * y + k * layer] = 8; m.cloud[x + nx * y + k * layer] = 1e-3 } })
    core(5, 5, 2000, 6000); core(25, 20, 2000, 6000); core(15, 10, 300, 1200)
    expect(m.diagnostics().cores).toBe(2)
  })

  it('is deterministic for a given seed', () => {
    const a = new AtmosphereModel({ ...summerDay }), b = new AtmosphereModel({ ...summerDay })
    run(a, 60); run(b, 60)
    for (const f of fields) expect(a[f]).toEqual(b[f])
  })

  it('uses the documented default grid spacing', () => {
    const g = createGrid(DEFAULT_GRID)
    expect([g.dx, g.dy]).toEqual([1200, 1125])
    expect(g.nz).toBe(50); expect(g.dzs[0]).toBeCloseTo(100, 6); expect(g.zs[g.nz - 1]).toBeCloseTo(18_900, 6)
  })
})
