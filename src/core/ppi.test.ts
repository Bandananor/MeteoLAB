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

  it('with dual polarisation: rain has positive ZDR and rho_hv near 1; hail aloft ZDR near 0; nothing without echo', () => {
    const model = new AtmosphereModel({ ...QUIET }, createGrid({ nx: 16, ny: 12, nz: 20, width: 19_200, depth: 13_500, height: 15_000, bottomSpacing: 100 }))
    const { layer, nx, zs, nz } = model.grid, cx = 8 + Math.round(4000 / model.grid.dx), cy = 6
    for (let z = 0; z < nz; z++) if (zs[z] < 3000) model.rain[cx + nx * cy + z * layer] = 2e-3
    const ppi = new PPI(model, 64, 45)
    ppi.dual = true; ppi.tilt = .5; ppi.layout(); ppi.sample()
    let best = 0
    for (let i = 1; i < ppi.dbz.length; i++) if (ppi.dbz[i] > ppi.dbz[best]) best = i
    expect(ppi.zdr[best]).toBeGreaterThan(1); expect(ppi.rho[best]).toBeGreaterThan(.99); expect(ppi.kdp[best]).toBeGreaterThan(.3)
    expect(ppi.zdr.filter((_, i) => ppi.dbz[i] < 10).every(Number.isNaN)).toBe(true)
    // The same column with hail instead of rain: ZDR near zero under high reflectivity (the hail signature).
    for (let z = 0; z < nz; z++) { const i = cx + nx * cy + z * layer; if (zs[z] < 3000) { model.hail[i] = model.rain[i]; model.rain[i] = 0 } }
    model.theta.fill(260)
    ppi.sample()
    expect(ppi.dbz[best]).toBeGreaterThan(45); expect(Math.abs(ppi.zdr[best])).toBeLessThan(.5)
  })

  it('with radial bins every pixel of a bin shows the value at the centre of the bin, as on a radar display', () => {
    const model = new AtmosphereModel({ ...QUIET }, createGrid({ nx: 16, ny: 12, nz: 20, width: 19_200, depth: 13_500, height: 15_000, bottomSpacing: 100 }))
    const { layer, nx, zs, nz } = model.grid
    for (let z = 0; z < nz; z++) if (zs[z] < 3000) for (let c = 0; c < layer; c++) model.rain[c + z * layer] = (c % nx) * 1e-4 + Math.floor(c / nx) * 2e-5
    const ppi = new PPI(model, 64, 45), smooth = (ppi.sample(), ppi.dbz.slice())
    ppi.bins = { gate: 2000, beam: 10 }; ppi.layout(); ppi.sample()
    const bins = new Map<string, number>()
    let shared = 0
    for (let py = 0, i = 0; py < ppi.h; py++) for (let px = 0; px < ppi.w; px++, i++) {
      const g = ppi.ground(px, py), b = ppi.beamAt(g.x, g.y), key = `${Math.floor(b.range / 2000)}:${Math.floor(b.azimuth / 10)}`
      if (bins.has(key)) { expect(ppi.dbz[i]).toBe(bins.get(key)); shared++ } else bins.set(key, ppi.dbz[i])
    }
    expect(shared).toBeGreaterThan(ppi.w * ppi.h / 2)
    // Back to pixels: the same scan as before.
    ppi.bins = null; ppi.layout(); ppi.sample()
    expect(Array.from(ppi.dbz)).toEqual(Array.from(smooth))
  })

  it('cuts a vertical section (RHI) through a rain shaft at its range and up to its top', () => {
    const model = new AtmosphereModel({ ...QUIET }, createGrid({ nx: 16, ny: 12, nz: 20, width: 19_200, depth: 13_500, height: 15_000, bottomSpacing: 100 }))
    const { layer, nx, dx } = model.grid
    // Rain below 3 km, 4.8 km east of the radar (the domain centre), and the radial wind: 10 m/s from the west (outbound).
    const cx = 8 + Math.round(4800 / dx), cy = 6
    for (let z = 0; z < model.grid.nz; z++) { if (model.grid.zs[z] < 3000) model.rain[cx + nx * cy + z * layer] = 1e-3; for (let c = 0; c < layer; c++) model.u[c + z * layer] = 10 }
    const ppi = new PPI(model, 64, 45), step = 300, gates = 30, dz = 250, rows = 40
    ppi.prepare()
    const east = ppi.section(90, step, gates, dz, rows), north = ppi.section(0, step, gates, dz, rows)
    const at = (s: Float32Array, range: number, height: number) => s[Math.floor(height / dz) * gates + Math.floor(range / step)]
    expect(at(east.dbz, 4800, 1000)).toBeGreaterThan(35)
    expect(at(east.dbz, 4800, 5000)).toBeLessThan(5)
    expect(at(east.dbz, 1500, 1000)).toBeLessThan(5)
    // Outbound wind along the eastward ray, minus a little fall speed seen at the low elevation.
    expect(at(east.velocity, 4800, 500)).toBeGreaterThan(8)
    // Northward there is no rain at all.
    expect(Math.max(...north.dbz)).toBeLessThan(5)
  })

  it('cuts a section between any two points: the radial wind from the radar, the beams and the isotherms', () => {
    const model = new AtmosphereModel({ ...QUIET }, createGrid({ nx: 16, ny: 12, nz: 20, width: 19_200, depth: 13_500, height: 15_000, bottomSpacing: 100 }))
    const { layer, nx, dx } = model.grid
    // The same rain shaft 4.8 km east of the radar and 10 m/s from the west; the section runs south to north through it.
    const cx = 8 + Math.round(4800 / dx), cy = 6, x = cx * dx, y = cy * model.grid.dy
    for (let z = 0; z < model.grid.nz; z++) { if (model.grid.zs[z] < 3000) model.rain[cx + nx * cy + z * layer] = 1e-3; for (let c = 0; c < layer; c++) model.u[c + z * layer] = 10 }
    const ppi = new PPI(model, 64, 45), gates = 40, dz = 250, rows = 40
    ppi.site = { x: model.grid.width / 2, y }; ppi.prepare()
    const s = ppi.crossSection({ x, y: y - 6000 }, { x, y: y + 6000 }, gates, dz, rows), mid = gates / 2
    // The shaft in the middle of the line, the wind across the line but along the radar's ray there: outbound.
    expect(s.dbz[4 * gates + mid]).toBeGreaterThan(30)
    expect(s.velocity[2 * gates + mid]).toBeGreaterThan(8)
    // The range from the radar is least in the middle (the line passes it at 4.8 km), the beams rise away from there.
    expect(s.range[mid]).toBeCloseTo(x - model.grid.width / 2, -3)
    expect(s.range[0]).toBeGreaterThan(s.range[mid])
    expect(s.beams[0][0]).toBeGreaterThan(s.beams[0][mid])
    expect(s.beams[13][mid]).toBeGreaterThan(s.beams[0][mid])
    // The isotherms where the environment crosses 0 and -20 °C.
    const e = model.env, cross = (level: number) => { for (let z = 1; z < model.grid.nz; z++) { const a = e.theta[z - 1] * e.exner[z - 1] - 273.15, b = e.theta[z] * e.exner[z] - 273.15; if (a > level && b <= level) return model.grid.zs[z - 1] + (a - level) / (a - b) * (model.grid.zs[z] - model.grid.zs[z - 1]) } return NaN }
    expect(Math.abs(s.iso0[3] - cross(0))).toBeLessThan(100)
    expect(Math.abs(s.iso20[3] - cross(-20))).toBeLessThan(100)
    // The same line backwards is the same section mirrored.
    const r = ppi.crossSection({ x, y: y + 6000 }, { x, y: y - 6000 }, gates, dz, rows)
    expect(r.dbz[4 * gates + 3]).toBeCloseTo(s.dbz[4 * gates + gates - 4], 4)
  })
})
