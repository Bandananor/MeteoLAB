import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, DEFAULT_GRID, rotationSummary, SPIN_SUPERCELL, spinProfile } from '.'
import { QUIET } from './fixtures'

const smallGrid = () => createGrid({ ...DEFAULT_GRID, nx: 16, ny: 12, width: 16 * 1200, depth: 12 * 1125 })

/** An updraught of 10 m/s within 3 km of (8, 6) between `from` and `to` m, rotating cyclonically (ζ = 2Ω) or not. */
function updraught(model: AtmosphereModel, from: number, to: number, rotating: boolean, offset = 0) {
  const { nx, ny, nz, layer, zs, dx, dy } = model.grid, omega = 5e-3
  for (let k = 1; k < nz; k++) {
    if (zs[k] < from || zs[k] > to) continue
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const ex = (x - 8) * dx, ny_ = (y - 6) * dy, i = x + nx * y + k * layer
      if (Math.hypot(ex, ny_) <= 3000) model.w[i] = 10
      // The vortex sits on the updraught, or `offset` columns beside it.
      const vx = (x - 8 - offset) * dx
      if (rotating && Math.hypot(vx, ny_) <= 3000) { model.u[i] = -omega * ny_; model.v[i] = omega * vx }
    }
  }
  model.rotation.x = 8; model.rotation.y = 6
}

describe('rotation by height (spin.ts)', () => {
  it('finds a rotating core between 2 and 5 km and a strong w-ζ correlation', () => {
    const model = new AtmosphereModel({ ...QUIET }, smallGrid())
    updraught(model, 2000, 5000, true)
    const p = spinProfile(model)
    expect(p.bottom!).toBeGreaterThanOrEqual(1.9); expect(p.bottom!).toBeLessThan(2.6)
    expect(p.top!).toBeGreaterThan(4.4); expect(p.top!).toBeLessThanOrEqual(5)
    // w ζ = 10 m/s x 0.01 1/s = 0.1 m/s² = 100 x 10⁻³ in the core.
    expect(Math.max(...p.wz)).toBeGreaterThan(60)
    // Well above the supercell mark (not 1: the cut-off vortex has a ring of negative ζ at the updraught's edge).
    expect(p.correlation!).toBeGreaterThan(2 * SPIN_SUPERCELL)
  })

  it('gives no rotation and a weak correlation when the vortex stands beside the updraught', () => {
    const model = new AtmosphereModel({ ...QUIET }, smallGrid())
    updraught(model, 2000, 5000, true, 6)
    const p = spinProfile(model)
    expect(Math.abs(p.correlation!)).toBeLessThan(SPIN_SUPERCELL)
    expect(spinProfile(new AtmosphereModel({ ...QUIET }, smallGrid())).correlation).toBeNull()
  })

  it('says in words at what height the updraught rotates', () => {
    const none = { bottom: null, top: null }, deep = { bottom: .6, top: 9.8 }
    expect(rotationSummary({ uh: 90, uh01: 3, uh03: 25, persisted: 0 }, none)).toBe('поток не вращается')
    const mid = rotationSummary({ uh: 950, uh01: 8, uh03: 60, persisted: 720 }, deep)
    expect(mid).toMatch(/^Средний мезоциклон 2–5 км держится 12 мин/); expect(mid).not.toMatch(/низкий/); expect(mid).toMatch(/0.6–9.8 км$/)
    expect(rotationSummary({ uh: 950, uh01: 8, uh03: 190, persisted: 720 }, deep)).toMatch(/опускается ниже 3 км/)
    const low = rotationSummary({ uh: 480, uh01: 36, uh03: 300, persisted: 900 }, deep)
    expect(low).toMatch(/низкий мезоциклон/); expect(low).not.toMatch(/опускается/)
    expect(rotationSummary({ uh: 450, uh01: 2, uh03: 30, persisted: 0 }, none)).toBe('Сильное вращение на 2–5 км (UH 450), мезоциклоном ещё не стало')
  })
})
