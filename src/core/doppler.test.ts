import { describe, expect, it } from 'vitest'
import { AtmosphereModel, beamHeight, createGrid, ECHO_TOP_DBZ, fold, NYQUIST, PPI, RADAR_TILTS, VIL_MAX_DBZ } from '.'
import { QUIET } from './fixtures'

// A domain fixed to the ground: the model winds set below are the winds over the ground.
const small = () => new AtmosphereModel({ ...QUIET, followStorm: false }, createGrid({ nx: 16, ny: 12, nz: 20, width: 19_200, depth: 13_500, height: 15_000, bottomSpacing: 100 }))

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

  it('measures the wind over the ground and sees the storm move past when the domain follows it', () => {
    const model = new AtmosphereModel({ ...QUIET }, createGrid({ nx: 16, ny: 12, nz: 20, width: 19_200, depth: 13_500, height: 15_000, bottomSpacing: 100 }))
    const [fu, fv] = model.frame, { nx, layer, nz, dx } = model.grid
    expect(Math.hypot(fu, fv)).toBeGreaterThan(3)
    // Calm air in the domain's frame is air moving with the domain over the ground.
    model.u.fill(0); model.v.fill(0); model.w.fill(0); model.rain.fill(1e-3)
    const ppi = new PPI(model, 64, 45)
    ppi.tilt = .5; ppi.sample()
    const i = 50 + 20 * ppi.w, g = ppi.ground(50, 20), b = ppi.beamAt(g.x, g.y), az = b.azimuth * Math.PI / 180
    expect(ppi.velocity[i]).toBeCloseTo((fu * Math.sin(az) + fv * Math.cos(az)) * Math.cos(.5 * Math.PI / 180), 1)
    // One rainy column of the domain: after the domain has moved 3 columns east (and some north), the echo is 3 columns east.
    model.rain.fill(0)
    for (let z = 0; z < nz; z++) model.rain[4 + nx * 6 + z * layer] = 2e-3
    model.time = 3 * dx / fu
    const echo = (x: number) => ppi.dbzAt(x, 6 * model.grid.dy + fv * model.time, .5)
    ppi.prepare()
    expect(echo(7 * dx)).toBeGreaterThan(echo(4 * dx) + 20)
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

  it('integrates VIL between the tilts and finds the echo top (2.8)', () => {
    // Rain of 1 g/kg up to 6 km everywhere: every beam of this small domain (below ~3.5 km) is in it.
    const model = small(), { layer, nz, zs } = model.grid
    for (let z = 0; z < nz; z++) if (zs[z] < 6000) for (let c = 0; c < layer; c++) model.rain[c + z * layer] = 1e-3
    const ppi = new PPI(model, 64, 45)
    ppi.composite()
    for (const [px, py] of [[50, 10], [40, 30], [10, 40]]) {
      const i = px + py * ppi.w, g = ppi.ground(px, py), { range } = ppi.beamAt(g.x, g.y), low = beamHeight(range, RADAR_TILTS[0]), high = beamHeight(range, RADAR_TILTS[RADAR_TILTS.length - 1])
      // Even the highest tilt is in the rain: the top is above it, the echo top only a lower bound.
      expect(ppi.echoTop[i] * 1000).toBeCloseTo(high, -2); expect(ppi.echoTopped[i]).toBe(1)
      // Z within a few dB from level to level (density): VIL within ~15 % of 3.44e-6 Z^(4/7) over the beams' depth.
      const expected = 3.44e-6 * (10 ** (ppi.compositeDbz[i] / 10)) ** (4 / 7) * (high - low)
      expect(ppi.vil[i] / expected).toBeGreaterThan(.8); expect(ppi.vil[i] / expected).toBeLessThan(1.05)
    }
    // Rain below the melting level gives no hail size; strong echo through the hail growth zone does (2.8).
    expect(Math.max(...ppi.mesh)).toBe(0)
    const hail = small(), { zs: hz } = hail.grid
    for (let z = 0; z < nz; z++) if (hz[z] < 10_000) for (let c = 0; c < layer; c++) hail.hail[c + z * layer] = 4e-3
    const far = new PPI(hail, 64, 45)
    far.site = { x: 0, y: 0 }; far.layout(); far.composite()
    const big = Math.max(...far.mesh)
    expect(big).toBeGreaterThan(19); expect(big).toBeLessThan(150)
    // Echo above VIL_MAX_DBZ counts as VIL_MAX_DBZ: hail adds no more.
    // Folding: within ±v_N as measured, beyond it over to the other sign by 2 v_N (2.8); S-band 28 m/s, C-band 13.
    const n = NYQUIST.S
    expect(fold(20, n)).toBe(20); expect(fold(-27, n)).toBe(-27); expect(fold(30, n)).toBeCloseTo(30 - 2 * n, 9); expect(fold(-40, n)).toBeCloseTo(-40 + 2 * n, 9)
    expect(fold(70, n)).toBeCloseTo(70 - 2 * n, 9); expect(fold(100, n)).toBeCloseTo(100 - 4 * n, 9); expect(fold(NaN, n)).toBeNaN()
    expect(fold(20, NYQUIST.C)).toBeCloseTo(20 - 2 * NYQUIST.C, 9)
    expect(VIL_MAX_DBZ).toBe(56); expect(ECHO_TOP_DBZ).toBe(18)
  })
})
