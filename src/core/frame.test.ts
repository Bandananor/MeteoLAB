import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, domainMotion, LARGE_GRID, stormMotion } from '.'
import { QUIET, SUMMER_DAY, SUPERCELL } from './fixtures'

const small = (config = QUIET) => new AtmosphereModel({ ...config }, createGrid({ nx: 16, ny: 12, nz: 20, width: 19_200, depth: 13_500, height: 15_000, bottomSpacing: 100 }))

describe('storm-following domain', () => {
  it('follows the Bunkers right mover in supercell shear and the mean wind otherwise', () => {
    // Weak shear: 2 to 8 m/s over 0-6 km.
    const sc = small(SUPERCELL), weak = small({ ...SUMMER_DAY, wind0: 2, wind3: 5, wind6: 8, wind10: 10 })
    expect(sc.frame).toEqual(stormMotion(sc.env).rightMover); expect(domainMotion(sc.env)).toEqual(sc.frame)
    expect(weak.frame).toEqual(stormMotion(weak.env).meanWind)
    expect(small({ ...QUIET, followStorm: false }).frame).toEqual([0, 0])
  })

  it('keeps the background steady: the wind over the ground stays the environmental one', () => {
    const m = small(SUPERCELL), { nz, layer } = m.grid, [fu, fv] = m.frame
    // Sunless, and every field reset to the base state (which also removes the starting thermal): only it can drift.
    Object.assign(m.config, { solarMax: 0 })
    m.w.fill(0)
    for (let z = 0; z < nz; z++) for (let i = z * layer; i < (z + 1) * layer; i++) { m.u[i] = m.env.u[z] - fu; m.v[i] = m.env.v[z] - fv; m.theta[i] = m.env.theta[z] }
    for (let s = 0; s < 600; s++) { m.step(1); m.time += 1 }
    let drift = 0
    for (let z = 0; z < nz; z++) for (let i = z * layer; i < (z + 1) * layer; i++) drift = Math.max(drift, Math.hypot(m.u[i] + fu - m.env.u[z], m.v[i] + fv - m.env.v[z]))
    expect(Math.hypot(fu, fv)).toBeGreaterThan(5); expect(drift).toBeLessThan(.05)
  })

  it('lets rain fall on the ground under the moving domain (the rain total is fixed to the ground)', () => {
    const m = small(SUPERCELL), { nx, dx, dy, layer } = m.grid, [fu, fv] = m.frame
    Object.assign(m.config, { solarMax: 0 })
    // Half an hour on: the domain has moved by (fu, fv) * 1800 s. Rain in one ground-level column of the domain.
    m.time = 1800; m.rain.fill(0); m.rain[5 + nx * 6] = 2e-3
    m.step(1)
    let total = 0, sx = 0, sy = 0
    const [ox, oy] = m.frameOffset()
    for (let c = 0; c < layer; c++) {
      const p = m.precipitation[c]
      if (p <= 0) continue
      // Ground position relative to where the column is now (periodic), in columns.
      const ex = ((c % nx) * dx - (5 * dx + ox)) / dx, ey = (Math.floor(c / nx) * dy - (6 * dy + oy)) / dy
      total += p; sx += p * (ex - nx * Math.round(ex / nx)); sy += p * (ey - m.grid.ny * Math.round(ey / m.grid.ny))
    }
    expect(total).toBeGreaterThan(0)
    // The rain lands under the column, wherever the ground has moved to.
    expect(Math.abs(sx / total)).toBeLessThan(.01); expect(Math.abs(sy / total)).toBeLessThan(.01)
    expect(Math.hypot(fu, fv) * 1800).toBeGreaterThan(5 * dx)
  })

  it('offers a large domain at the same resolution', () => {
    const big = createGrid(LARGE_GRID), std = createGrid()
    expect(big.width).toBe(2 * std.width); expect(big.depth).toBe(2 * std.depth)
    expect(big.dx).toBe(std.dx); expect(big.dy).toBe(std.dy); expect(big.nz).toBe(std.nz)
    expect(new AtmosphereModel({ ...QUIET, domain: 'large' }).grid.nx).toBe(80)
  })
})
