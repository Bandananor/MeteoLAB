import { describe, expect, it } from 'vitest'
import { AtmosphereModel, cloudReflectance, createGrid, GROUND_ALBEDO, overshootingTops, satelliteImage } from '.'
import { QUIET } from './fixtures'

const grid = () => createGrid({ nx: 24, ny: 24, nz: 30, width: 24 * 1200, depth: 24 * 1200, height: 18_000, bottomSpacing: 100 })

describe('the satellite (2.8)', () => {
  it('sees the ground in clear air, a thick cloud bright and its cold top, and nothing in the visible at night', () => {
    const m = new AtmosphereModel({ ...QUIET }, grid()), { layer, nz, zs, nx } = m.grid
    // A thick ice anvil at 9-11 km over the column (5, 5): 0.5 g/kg of ice.
    const anvil = 5 + nx * 5, top = zs.findLastIndex(z => z <= 11_000)
    for (let k = 0; k < nz; k++) if (zs[k] >= 9000 && zs[k] <= 11_000) m.ice[anvil + k * layer] = 5e-4
    const img = satelliteImage(m, 1), ground = m.theta[0] * m.env.exner[0] - 273.15
    // Clear air: the ground's albedo and the air at the ground.
    expect(img.visible[0]).toBeCloseTo(GROUND_ALBEDO, 3); expect(img.infrared[0]).toBeCloseTo(ground, 1); expect(img.tau[0]).toBe(0)
    // The anvil: optically thick (τ ~ 55 m²/kg × 0.5 g/kg × ρ × 2 km ≈ 20), bright, its top's temperature in the infrared.
    expect(img.tau[anvil]).toBeGreaterThan(10); expect(img.visible[anvil]).toBeGreaterThan(cloudReflectance(10))
    const topTemp = m.theta[anvil + top * layer] * m.env.exner[top] - 273.15
    expect(img.infrared[anvil]).toBeLessThan(topTemp + 8); expect(img.infrared[anvil]).toBeLessThan(ground - 40)
    // At night the visible channel is dark, the infrared the same.
    const night = satelliteImage(m, -.2)
    expect(night.visible[anvil]).toBe(0); expect(night.infrared[anvil]).toBeCloseTo(img.infrared[anvil], 6)
  })

  it('finds an overshooting top: a cold dome over a broad anvil, not the anvil itself', () => {
    const m = new AtmosphereModel({ ...QUIET }, grid()), { layer, nx } = m.grid
    // An anvil at -55 °C everywhere within 12 km of (12, 12), and a dome of -66 °C at its centre.
    const ir = new Float32Array(layer).fill(20)
    for (let c = 0; c < layer; c++) if (Math.hypot(c % nx - 12, Math.floor(c / nx) - 12) * 1200 < 12_000) ir[c] = -55
    ir[12 + nx * 12] = -66
    const tops = overshootingTops(m, ir)
    expect(tops).toHaveLength(1); expect(tops[0].column).toBe(12 + nx * 12); expect(tops[0].contrast).toBeCloseTo(11, 0)
    // Only 3 K colder: not one.
    ir[12 + nx * 12] = -58
    expect(overshootingTops(m, ir)).toHaveLength(0)
  })
})
