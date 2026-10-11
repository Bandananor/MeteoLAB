import { describe, expect, it } from 'vitest'
import { AtmosphereModel, computeScalarField, createGrid, DEFAULT_GRID } from '.'
import { QUIET } from './fixtures'

describe('updraft helicity maps by layer', () => {
  it('shows a rotating updraught confined to the lowest kilometre in 0-1 and 0-3 km, not in 2-5 km', () => {
    const model = new AtmosphereModel({ ...QUIET }, createGrid({ ...DEFAULT_GRID, nx: 16, ny: 12, width: 16 * 1200, depth: 12 * 1125 }))
    const { nx, ny, nz, layer, zs, dx, dy } = model.grid, cx = 8, cy = 6, omega = 5e-3
    // Solid-body cyclonic rotation (ζ = 2Ω) within 3 km of the centre and w = 5 m/s, both only below 1 km.
    for (let z = 1; z < nz; z++) {
      if (zs[z] > 1000) break
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const ex = (x - cx) * dx, ny_ = (y - cy) * dy, i = x + nx * y + z * layer
        if (Math.hypot(ex, ny_) > 3000) continue
        model.u[i] = -omega * ny_; model.v[i] = omega * ex; model.w[i] = 5
      }
    }
    const out = new Float32Array(model.grid.n), centre = (z: number) => out[cx + nx * cy + z * layer], low = zs.findIndex(z => z > 300)
    computeScalarField(model, 'helicity', out, '0-1')
    // UH ≈ w ζ depth = 5 · 0.01 · ~1 km = ~50 m²/s², drawn inside the layer only.
    expect(centre(low)).toBeGreaterThan(30); expect(centre(low)).toBeLessThan(70)
    expect(centre(zs.findIndex(z => z > 2000))).toBe(0)
    const oneKm = centre(low)
    computeScalarField(model, 'helicity', out, '0-3')
    expect(centre(low)).toBeCloseTo(oneKm, 3)
    computeScalarField(model, 'helicity', out, 'deep')
    expect(centre(low)).toBeCloseTo(oneKm, 3)
    // The 2-5 km map is the model's own column UH: nothing rotates there.
    model.uhColumn.fill(0)
    computeScalarField(model, 'helicity', out, '2-5')
    expect(Math.max(...out)).toBe(0)
  })
})
