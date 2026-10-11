import { describe, expect, it } from 'vitest'
import { AtmosphereModel, coldPoolBalance, createGrid, DEFAULT_GRID, describeBalance } from '.'
import { QUIET } from './fixtures'

const smallGrid = () => createGrid({ ...DEFAULT_GRID, nx: 16, ny: 12, width: 16 * 1200, depth: 12 * 1125 })

describe('RKW balance: cold pool against low-level shear', () => {
  it('has no cold pool in the quiet environment', () => {
    expect(coldPoolBalance(new AtmosphereModel({ ...QUIET }, smallGrid()))).toBeNull()
  })

  it('gives the density-current speed of a cold pool, C = sqrt(2 g Δθ/θ h)', () => {
    // 5 K colder below ~1 km in 20 columns, westerly shear of 10 m/s over 0-2.5 km.
    const model = new AtmosphereModel({ ...QUIET, wind0: 0, windDir0: 270, wind3: 12, windDir3: 270, wind6: 12, windDir6: 270, wind10: 12, windDir10: 270 }, smallGrid())
    const { layer, nz, zs } = model.grid
    for (let c = 0; c < 20; c++) for (let k = 0; k < nz; k++) if (zs[k] < 1000) model.theta[c + k * layer] -= 5
    const b = coldPoolBalance(model)!
    const top = zs[zs.findIndex(z => z >= 1000) - 1], expected = Math.sqrt(2 * 9.81 * 5 / model.env.theta[0] * top)
    expect(b.area).toBeCloseTo(20 / layer, 6)
    expect(b.c / expected).toBeGreaterThan(.85); expect(b.c / expected).toBeLessThan(1.15)
    expect(b.depth).toBeGreaterThan(800); expect(b.depth).toBeLessThan(1200)
    // 0-2.5 km of the 0 -> 12 m/s (at 3 km) profile: 10 m/s.
    expect(b.deltaU).toBeCloseTo(10, 0)
    expect(b.ratio).toBeCloseTo(b.c / b.deltaU, 9)
    // C ~17.6 m/s against 10 m/s: the cold pool dominates.
    expect(describeBalance(b)).toContain('купол сильнее')
    expect(describeBalance({ ...b, ratio: 1 })).toContain('уравновешены')
    expect(describeBalance({ ...b, ratio: .4 })).toContain('сдвиг сильнее')
  })
})
