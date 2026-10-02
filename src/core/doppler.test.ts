import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, PPI } from '.'
import { QUIET } from './fixtures'

const small = () => new AtmosphereModel({ ...QUIET }, createGrid({ nx: 16, ny: 12, nz: 20, width: 19_200, depth: 13_500, height: 15_000, bottomSpacing: 100 }))

describe('Doppler velocity and composite reflectivity', () => {
  it('measures the radial wind where there is echo: a westerly is outbound east of the radar, inbound west', () => {
    const model = small()
    model.u.fill(0); model.v.fill(0); model.w.fill(0); model.rain.fill(1e-3)
    const ppi = new PPI(model, 64, 45), el = 2.4 * Math.PI / 180
    ppi.tilt = 2.4
    const pixel = (dx: number, dy: number) => Math.floor((ppi.site.x + dx) / model.grid.width * ppi.w) + Math.floor((model.grid.depth - ppi.site.y - dy) / model.grid.depth * ppi.h) * ppi.w
    const azimuth = (i: number) => { const g = ppi.ground(i % ppi.w, Math.floor(i / ppi.w)); return ppi.beamAt(g.x, g.y).azimuth * Math.PI / 180 }
    // Calm air: only the falling rain shows, -V_t sin(el), a few tenths of a m/s at 2.4°.
    ppi.sample()
    const east = pixel(5000, 0), west = pixel(-5000, 0), fall = ppi.velocity[east]
    expect(fall).toBeLessThan(0); expect(fall).toBeGreaterThan(-.5)
    // A 10 m/s westerly: + 10 sin(az) cos(el) on top (outbound east of the radar, inbound west).
    model.u.fill(10); ppi.sample()
    expect(ppi.velocity[east]).toBeCloseTo(10 * Math.sin(azimuth(east)) * Math.cos(el) + fall, 4)
    expect(ppi.velocity[west]).toBeCloseTo(10 * Math.sin(azimuth(west)) * Math.cos(el) + fall, 4)
    expect(ppi.velocity[east]).toBeGreaterThan(9); expect(ppi.velocity[west]).toBeLessThan(-9)
    // No echo, no velocity.
    model.rain.fill(0); ppi.sample()
    expect(ppi.velocity.every(Number.isNaN)).toBe(true)
  })

  it('subtracts the storm motion for storm-relative velocity (SRV)', () => {
    const model = small()
    model.u.fill(12); model.v.fill(6); model.w.fill(0); model.rain.fill(1e-3)
    const ppi = new PPI(model, 64, 45)
    ppi.tilt = 2.4; ppi.sample()
    const base = Math.max(...ppi.velocity.map(Math.abs))
    ppi.stormMotion = [12, 6]; ppi.sample()
    // Air moving with the storm: only the falling rain is left (-V_t sin el, under 0.5 m/s at 2.4°).
    expect(base).toBeGreaterThan(10)
    expect(Math.max(...ppi.velocity.map(Math.abs))).toBeLessThan(.5)
  })

  it('makes the composite at least as strong as any single tilt', () => {
    // Graupel at 1-3 km in every 7th column (within ~12 km of the radar even the 19.5° beam stays below 4 km).
    const model = small(), { layer, nz, zs } = model.grid
    for (let z = 0; z < nz; z++) if (zs[z] > 1000 && zs[z] < 3000) for (let c = 0; c < layer; c += 7) model.graupel[c + z * layer] = 2e-3
    const ppi = new PPI(model, 64, 45)
    ppi.composite()
    for (const tilt of [.5, 6.4, 19.5]) {
      ppi.tilt = tilt; ppi.sample()
      for (let i = 0; i < ppi.dbz.length; i++) expect(ppi.compositeDbz[i]).toBeGreaterThanOrEqual(ppi.dbz[i] - 1e-6)
    }
    expect(Math.max(...ppi.compositeDbz)).toBeGreaterThan(30)
  })
})
