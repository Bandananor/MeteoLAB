import { describe, expect, it } from 'vitest'
import { AtmosphereModel, beamHeight, clutterAt, createGrid, noiseFloor, PPI, RADAR_TILTS, RADARS, VGO_DBZ } from '.'
import { QUIET } from './fixtures'

describe('radar PPI', () => {
  it('retrieves a uniform wind by VAD, and none without echo', () => {
    const model = new AtmosphereModel({ ...QUIET }, createGrid({ nx: 48, ny: 48, nz: 20, width: 57_600, depth: 57_600, height: 15_000, bottomSpacing: 100 }))
    const ppi = new PPI(model, 96, 96)
    ppi.prepare(); expect(ppi.vad()).toEqual([])
    model.u.fill(10); model.v.fill(-5); model.w.fill(0); model.snow.fill(1e-3)
    ppi.prepare()
    const winds = ppi.vad(), [fu, fv] = model.frame
    expect(winds.length).toBeGreaterThan(3); expect(winds[0].range).toBe(20_000)
    for (const w of winds) { expect(w.u).toBeCloseTo(10 + fu, 1); expect(w.v).toBeCloseTo(-5 + fv, 1); expect(w.rms).toBeLessThan(.5) }
  })

  it('shows ground clutter near the radar at the low tilt (zero velocity, low rho_hv), filtered by 50 dB, and noise', () => {
    expect(clutterAt(5000, 10, .5, .95, false).dbz).toBe(clutterAt(5000, 10, .5, .95, false).dbz)
    // Over many gates: clutter in the first 20 km at 0.5°, almost none at 10° beyond the sidelobes, none at 0.5° at 80 km.
    const share = (range: number, tilt: number) => { let n = 0; for (let az = 0; az < 360; az++) if (clutterAt(range, az + .5, tilt, .95, false).dbz > 0) n++; return n / 360 }
    expect(share(10_000, .5)).toBeGreaterThan(.2); expect(share(10_000, 10)).toBe(0); expect(share(80_000, .5)).toBe(0); expect(share(1000, 10)).toBeGreaterThan(.1)
    const c = clutterAt(5000, 10.5, .5, .95, false), f = clutterAt(5000, 10.5, .5, .95, true)
    if (c.dbz > -Infinity) { expect(c.dbz - f.dbz).toBeCloseTo(50, 6); expect(c.rho).toBeLessThan(.86) }
    // The noise floor rises 6 dB per doubling of range: ~-7.5 dBZ at 50 km (WSR-88D) with the threshold.
    expect(noiseFloor(50_000)).toBeCloseTo(-41.5 + 34 + 2, 0); expect(noiseFloor(100_000) - noiseFloor(50_000)).toBeCloseTo(6, 0)
    // In the scan: clear air near the radar gets echo with no velocity bias from weather.
    const model = new AtmosphereModel({ ...QUIET }, createGrid({ nx: 16, ny: 12, nz: 20, width: 19_200, depth: 13_500, height: 15_000, bottomSpacing: 100 }))
    const ppi = new PPI(model, 64, 45)
    ppi.tilt = .5; ppi.layout(); ppi.sample(); expect(Math.max(...ppi.dbz)).toBe(-20)
    ppi.clutter = true; ppi.sample()
    const echo = [...ppi.dbz.keys()].filter(i => ppi.dbz[i] > 10)
    expect(echo.length).toBeGreaterThan(20); expect(Math.max(...echo.map(i => Math.abs(ppi.velocity[i] || 0)))).toBeLessThan(.01)
    ppi.filtered = true; ppi.sample(); expect([...ppi.dbz].filter(d => d > 10).length).toBeLessThan(echo.length / 5)
  })

  it('leaves the section empty where no beam reaches: above the highest tilt near the radar', () => {
    const model = new AtmosphereModel({ ...QUIET }, createGrid({ nx: 16, ny: 12, nz: 20, width: 19_200, depth: 13_500, height: 15_000, bottomSpacing: 100 }))
    model.rain.fill(1e-3)
    const ppi = new PPI(model, 64, 45)
    ppi.setProfile(RADARS.x); ppi.layout(); ppi.prepare()
    // From the site 8 km east, 80 rows of 125 m: the X's highest tilt (15° + half a beam) is ~2.2 km up at 8 km.
    const { dbz, range } = ppi.crossSection(ppi.site, { x: ppi.site.x + 8000, y: ppi.site.y }, 32, 125, 80), last = 31
    const at = (g: number, h: number) => dbz[Math.floor(h / 125) * 32 + g]
    expect(range[last]).toBeGreaterThan(7500)
    expect(at(last, 1000)).toBeGreaterThan(30)
    expect(at(last, 5000)).toBe(-20)
  })

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
    // KDP is at the radar's own wavelength (as 1 / lambda): a C-band radar reads about twice the S-band's in the same rain.
    const peak = () => ppi.kdp.reduce((a, b) => b > a ? b : a, 0), s = peak()
    ppi.setProfile(RADARS.dmrl); ppi.layout(); ppi.sample()
    expect(peak() / s).toBeGreaterThan(1.5); expect(peak() / s).toBeLessThan(2.2)
    ppi.setProfile(RADARS.wsr88d); ppi.tilt = .5; ppi.layout(); ppi.sample()
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

  it('scans with the chosen radar profile: its tilts, and nothing beyond its ranges (the mobile X sees 30 km)', () => {
    const model = new AtmosphereModel({ ...QUIET }, createGrid({ nx: 60, ny: 8, nz: 20, width: 72_000, depth: 9_600, height: 15_000, bottomSpacing: 100 }))
    const { layer, nx, nz, zs, dx } = model.grid
    // Rain below 3 km along the whole row y = 4: 10 km and 25 km (inside the X's range) and 34 km (beyond it) from the centre.
    for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) if (zs[z] < 3000) model.rain[x + nx * 4 + z * layer] = 1e-3
    const ppi = new PPI(model, 144, 19)
    expect(ppi.tilts).toBe(RADAR_TILTS)
    ppi.setProfile(RADARS.dmrl)
    expect(ppi.tilts).toEqual(RADARS.dmrl.tilts); expect([.3, .7]).toContain(ppi.tilt)
    // The DMRL-C measures the velocity on its own tilts: none at 1.5° (a reflectivity-only tilt), some at 1.6°.
    expect(ppi.velocityTilts).not.toContain(1.5)
    ppi.tilt = 1.5; ppi.layout(); ppi.sample(); expect(ppi.velocity.some(v => !Number.isNaN(v))).toBe(false)
    ppi.tilt = 1.6; ppi.sample(); expect(ppi.velocity.some(v => !Number.isNaN(v))).toBe(true)
    ppi.setProfile(RADARS.x); ppi.layout(); ppi.sample()
    const at = (km: number) => { const px = Math.round((36 + km) * 1000 / (72_000 / 144) - .5); return ppi.dbz[px + 144 * 9] }
    expect(at(10)).toBeGreaterThan(30); expect(at(25)).toBeGreaterThan(30); expect(at(34)).toBe(-20)
    ppi.composite()
    expect(ppi.compositeDbz[Math.round(70_000 / 500) + 144 * 9]).toBe(-20)
    ppi.setProfile(RADARS.wsr88d); ppi.sample()
    expect(at(34)).toBeGreaterThan(30)
    expect(dx).toBe(1200)
  })

  it('gives the column quantities of the Russian radars from the DMRL-C volume scan: the cloud top at -5 dBZ, Z1, Z2, Zmax, the echo at H2 and H3', () => {
    const model = new AtmosphereModel({ ...QUIET }, createGrid({ nx: 40, ny: 8, nz: 30, width: 48_000, depth: 9_600, height: 15_000, bottomSpacing: 100 }))
    const { layer, nx, nz, zs } = model.grid
    // Rain below 3 km in the column 15 km east of the centre (row 4), 2 g/kg.
    const cx = 20 + Math.round(15_000 / model.grid.dx)
    for (let y = 3; y <= 5; y++) for (let z = 0; z < nz; z++) if (zs[z] < 3000) model.rain[cx + nx * y + z * layer] = 2e-3
    const ppi = new PPI(model, 96, 19)
    ppi.setProfile(RADARS.dmrl); ppi.composite()
    const i = ppi.compositeDbz.indexOf(Math.max(...ppi.compositeDbz)), cr = ppi.compositeDbz[i]
    expect(cr).toBeGreaterThan(40); expect(Math.abs(ppi.ground(i % 96, Math.floor(i / 96)).x - 39_000)).toBeLessThan(2000)
    // The layers inside the shaft see it; the cloud top lies near its top, within the tilts' spacing (~1 km at 15 km).
    expect(ppi.z1[i]).toBeGreaterThan(cr - 3); expect(ppi.z2[i]).toBeGreaterThan(cr - 6); expect(ppi.zmax[i]).toBeGreaterThan(cr - 2); expect(ppi.zmax[i]).toBeLessThanOrEqual(cr)
    expect(ppi.vgo[i]).toBeGreaterThan(2.3); expect(ppi.vgo[i]).toBeLessThan(4.5)
    // H3 lies 2.25 km above the 0 °C level, both above the shaft: little or no echo there.
    expect(ppi.levelH3 - ppi.levelH2).toBe(2250); expect(ppi.zh3[i]).toBeLessThan(VGO_DBZ)
    // Clear air: no cloud top, the floor elsewhere.
    expect(ppi.vgo[96 * 2]).toBe(0); expect(ppi.z1[96 * 2]).toBe(-20)
  })

  it('attenuates the beam behind heavy rain: little at S, more at C, most at X (two-way, from the KDP)', () => {
    const model = new AtmosphereModel({ ...QUIET }, createGrid({ nx: 60, ny: 8, nz: 20, width: 72_000, depth: 9_600, height: 15_000, bottomSpacing: 100 }))
    const { layer, nx, nz, zs, dx } = model.grid
    // Two rain shafts east of the radar (centre), 6 km wide, 2 g/kg below 3 km: 6-12 km and 24-30 km out.
    for (let x = 0; x < nx; x++) {
      const r = x * dx - 36_000
      if ((r >= 6000 && r <= 12_000) || (r >= 24_000 && r <= 30_000)) for (let y = 0; y < 8; y++) for (let z = 0; z < nz; z++) if (zs[z] < 3000) model.rain[x + nx * y + z * layer] = 2e-3
    }
    const ppi = new PPI(model, 144, 19), far = Math.round((36_000 + 27_000) / 500 - .5) + 144 * 9, near = Math.round((36_000 + 9_000) / 500 - .5) + 144 * 9
    const loss = (radar: typeof RADARS.wsr88d) => {
      ppi.setProfile({ ...radar, tilts: [.5], range: 100_000 }); ppi.tilt = .5; ppi.layout(); ppi.dual = true
      ppi.attenuate = false; ppi.sample(); const raw = ppi.dbz[far], rawZdr = ppi.zdr[far]
      ppi.attenuate = true; ppi.sample()
      return { z: raw - ppi.dbz[far], zdr: rawZdr - ppi.zdr[far], near: ppi.dbz[near] }
    }
    const s = loss(RADARS.wsr88d), c = loss(RADARS.dwd), x = loss(RADARS.x)
    expect(s.z).toBeGreaterThan(0); expect(s.z).toBeLessThan(1.5)
    expect(c.z).toBeGreaterThan(2 * s.z); expect(x.z).toBeGreaterThan(2.5 * c.z); expect(x.z).toBeGreaterThan(5)
    // Measured 03.11.2026: S 0.95, C 4.8, X 28.5 dB (X ~1.6 dB/km one-way at ~50 mm/h), ZDR C 1.1, X 3.7 dB.
    expect(x.zdr).toBeGreaterThan(c.zdr); expect(c.zdr).toBeGreaterThan(0)
  })
})
