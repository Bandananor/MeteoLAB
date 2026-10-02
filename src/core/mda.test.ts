import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, hookEcho, MesocycloneDetector, mesoStrength, PPI } from '.'
import { QUIET } from './fixtures'

/** A 500 m grid with rain everywhere (echo for the Doppler velocity) and calm air; the radar at (4, 4) km. */
function scene() {
  const m = new AtmosphereModel({ ...QUIET }, createGrid({ nx: 48, ny: 40, nz: 24, width: 24_000, depth: 20_000, height: 15_000, bottomSpacing: 100 }))
  m.u.fill(0); m.v.fill(0); m.w.fill(0); m.rain.fill(1e-3)
  const ppi = new PPI(m, 96, 80)
  ppi.site = { x: 4000, y: 4000 }; ppi.layout()
  return { m, ppi }
}

/**
 * Rankine vortex (solid body inside `radius`, 1/r outside, tapered to calm within ~6 km so the periodic edges stay calm)
 * centred at (cx, cy), m, up to `top` m; `sign` 1 cyclonic.
 */
function vortex(m: AtmosphereModel, cx: number, cy: number, vmax: number, radius: number, top: number, sign = 1) {
  const { nx, ny, nz, layer, dx, dy, zs } = m.grid
  for (let z = 0; z < nz; z++) if (zs[z] <= top) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const ex = x * dx - cx, ey = y * dy - cy, r = Math.hypot(ex, ey), vt = r < radius ? vmax * r / radius : vmax * radius / r * Math.exp(-(((r - radius) / 3000) ** 2)), i = x + nx * y + z * layer
    if (r === 0) continue
    m.u[i] = -sign * vt * ey / r; m.v[i] = sign * vt * ex / r
  }
}

describe('mesocyclone detection (MDA)', () => {
  it('finds a deep cyclonic vortex where it is, with its rotational velocity and diameter', () => {
    const { m, ppi } = scene()
    vortex(m, 16_000, 12_000, 20, 2000, 8000)
    const [d, ...rest] = new MesocycloneDetector().scan(ppi, 0)
    expect(rest).toHaveLength(0)
    expect(Math.hypot(d.x - 16_000, d.y - 12_000)).toBeLessThan(1500)
    // Vrot is the half difference across the vortex: 20 m/s, a little less after the beam spacing and smoothing.
    expect(d.vrot).toBeGreaterThan(14); expect(d.vrot).toBeLessThan(21)
    expect(d.diameter).toBeGreaterThan(2500); expect(d.diameter).toBeLessThan(6000)
    expect(d.top - d.base).toBeGreaterThan(3000); expect(d.strength).not.toBe('circulation')
  })

  it('ignores anticyclonic and shallow rotation, and uniform wind', () => {
    const a = scene(); vortex(a.m, 16_000, 12_000, 20, 2000, 8000, -1)
    expect(new MesocycloneDetector().scan(a.ppi, 0)).toHaveLength(0)
    // Only below 600 m: too shallow to reach three tilts over 1.5 km of depth.
    const b = scene(); vortex(b.m, 16_000, 12_000, 20, 2000, 600)
    expect(new MesocycloneDetector().scan(b.ppi, 0)).toHaveLength(0)
    const c = scene(); c.m.u.fill(15); c.m.v.fill(8)
    expect(new MesocycloneDetector().scan(c.ppi, 0)).toHaveLength(0)
  })

  it('keeps the number of a detection from scan to scan', () => {
    const { m, ppi } = scene(), mda = new MesocycloneDetector()
    vortex(m, 16_000, 12_000, 20, 2000, 8000)
    const first = mda.scan(ppi, 0)[0]
    m.u.fill(0); m.v.fill(0); vortex(m, 17_000, 12_500, 20, 2000, 8000)
    const second = mda.scan(ppi, 120)[0]
    expect(second.id).toBe(first.id); expect(second.born).toBe(0)
  })

  it('recognises a hook: echo wrapped around the circulation with the notch on the inflow side', () => {
    // Rain 1-4 km around (16, 12) km except a sector `width` degrees wide centred on `gap` degrees; nothing elsewhere.
    const hook = (gap: number, motion: [number, number], width = 90) => {
      const { m, ppi } = scene(), { nx, ny, nz, layer, dx, dy } = m.grid
      m.rain.fill(0)
      for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const ex = x * dx - 16_000, ey = y * dy - 12_000, r = Math.hypot(ex, ey), az = (Math.atan2(ex, ey) * 180 / Math.PI + 360) % 360
        if (r > 1000 && r < 4000 && Math.abs(((az - gap + 540) % 360) - 180) > width / 2) m.rain[x + nx * y + z * layer] = 2e-3
      }
      ppi.prepare()
      return hookEcho(ppi, { x: 16_000, y: 12_000, base: 1500 }, motion)
    }
    // Storm moving east (90°): inflow from the south (180°). A notch there is a hook; to the north it is not.
    const found = hook(180, [12, 0])
    expect(found).not.toBeNull(); expect(found!.span).toBeGreaterThan(240); expect(found!.span).toBeLessThan(300)
    expect(hook(0, [12, 0])).toBeNull()
    // A full ring has no notch.
    expect(hook(180, [12, 0], 0)).toBeNull()
  })

  it('ranks strength by the rotational velocity', () => {
    expect(mesoStrength(8)).toBe('circulation'); expect(mesoStrength(13)).toBe('weak'); expect(mesoStrength(20)).toBe('moderate'); expect(mesoStrength(30)).toBe('strong')
  })
})
