import { describe, expect, it } from 'vitest'
import { AtmosphereModel, beamHeight, createGrid, PPI } from '.'
import { QUIET } from './fixtures'

describe('radar PPI', () => {
  it('raises the beam with range and tilt like a real radar (4/3 Earth)', () => {
    // 0.5° at 100 km: ~1.46 km (NEXRAD tables); at 20 km the curvature adds only ~24 m.
    expect(beamHeight(100_000, .5) / 1000).toBeCloseTo(1.46, 1)
    expect(beamHeight(20_000, 0)).toBeCloseTo(20_000 ** 2 / (2 * 4 / 3 * 6_371_000), 0)
    expect(beamHeight(20_000, 10)).toBeGreaterThan(beamHeight(20_000, 2))
  })

  it('sees a rain shaft at the height its beam crosses, and nothing in clear air', () => {
    const model = new AtmosphereModel({ ...QUIET }, createGrid({ nx: 16, ny: 12, nz: 20, width: 19_200, depth: 13_500, height: 15_000, bottomSpacing: 100 }))
    const { layer, nx } = model.grid
    // 1 g/kg of rain below 3 km in the column 4 km east of the centre.
    const cx = 8 + Math.round(4000 / model.grid.dx), cy = 6
    for (let z = 0; z < model.grid.nz; z++) if (model.grid.zs[z] < 3000) model.rain[cx + nx * cy + z * layer] = 1e-3
    const ppi = new PPI(model, 64, 45)
    ppi.tilt = .5; ppi.layout(); ppi.sample()
    expect(Math.max(...ppi.dbz)).toBeGreaterThan(35)
    // At 19.5° the beam crosses the shaft (4 km away) at ~1.3 km: still inside it...
    ppi.tilt = 19.5; ppi.layout(); ppi.sample()
    expect(Math.max(...ppi.dbz)).toBeGreaterThan(35)
    // ...but it mostly overshoots shallow rain below 1 km (only the edge nearer the radar, smeared by the interpolation,
    // is grazed), which the 0.5° beam sees in full.
    for (let z = 0; z < model.grid.nz; z++) if (model.grid.zs[z] >= 900) model.rain[cx + nx * cy + z * layer] = 0
    ppi.sample()
    expect(Math.max(...ppi.dbz)).toBeLessThan(25)
    ppi.tilt = .5; ppi.layout(); ppi.sample()
    expect(Math.max(...ppi.dbz)).toBeGreaterThan(35)
    // Clear air elsewhere: the noise floor.
    expect(Math.min(...ppi.dbz)).toBe(-20)
  })
})
