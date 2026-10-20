import { describe, expect, it } from 'vitest'
import { AtmosphereModel, intervene, INTERVENTIONS } from '.'
import { SUMMER_DAY } from './fixtures'

const fresh = () => new AtmosphereModel({ ...SUMMER_DAY, seed: 7 })
/** The model's node nearest (x, y) m at level z. */
const node = (m: AtmosphereModel, x: number, y: number, z = 0) => Math.round(x / m.grid.dx) + m.grid.nx * (Math.round(y / m.grid.dy) + m.grid.ny * z)

describe('interventions (core/intervene)', () => {
  it('keeps the thermal exactly as injectBubble always made it', () => {
    const m = fresh(), theta = Float32Array.from(m.theta), w = Float32Array.from(m.w), { nx, ny, nz, dx, dy, zs, width: W, depth: D } = m.grid
    m.injectBubble(20_000, 15_000, 1.25)
    // The formula as it was before intervene.ts.
    const radius = 4200
    for (let z = 0; z < nz && zs[z] < 2700; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let ddx = x * dx - 20_000, ddy = y * dy - 15_000
      if (ddx > W / 2) ddx -= W; if (ddx < -W / 2) ddx += W; if (ddy > D / 2) ddy -= D; if (ddy < -D / 2) ddy += D
      const a = Math.exp(-((ddx / radius) ** 2 + (ddy / radius) ** 2 + (zs[z] / 1800) ** 2)) * 1.25, i = x + nx * (y + ny * z)
      theta[i] += 3.2 * a; w[i] += 1.1 * a
    }
    expect(m.theta).toEqual(theta); expect(m.w).toEqual(w)
  })

  it('counts what is put in, from zero after the starting thermals', () => {
    const m = fresh()
    expect(m.added).toEqual({ heat: 0, vapour: 0, count: 0 })
    const warm = intervene(m, { kind: 'warm', x: 20_000, y: 15_000, strength: 1 })
    expect(warm.heat).toBeGreaterThan(0); expect(m.theta[node(m, 20_000, 15_000)] - fresh().theta[node(m, 20_000, 15_000)]).toBeCloseTo(INTERVENTIONS.warm.theta!, 1)
    const cool = intervene(m, { kind: 'cool', x: 20_000, y: 15_000, strength: 1 })
    expect(cool.heat).toBeCloseTo(-warm.heat, -6)
    expect(m.added.count).toBe(2); expect(Math.abs(m.added.heat)).toBeLessThan(warm.heat * 1e-3)
    // A cold pool: -6 K at its centre on the ground (on a node).
    const cx = 8 * m.grid.dx, cy = 9 * m.grid.dy, before = m.theta[node(m, cx, cy)]
    intervene(m, { kind: 'coldPool', x: cx, y: cy, strength: 1 })
    expect(m.theta[node(m, cx, cy)] - before).toBeCloseTo(INTERVENTIONS.coldPool.theta!, 1)
  })

  it('moistens short of saturation and dries down to nothing at most', () => {
    const m = fresh(), i = node(m, 20_000, 15_000)
    for (let k = 0; k < 20; k++) intervene(m, { kind: 'moisten', x: 20_000, y: 15_000, strength: 2 })
    const t = m.theta[i] * m.env.exner[0] - 273.15, qs = 611.2 * Math.exp(17.67 * t / (t + 243.5)) * .622 / (m.env.p[0] - 611.2 * Math.exp(17.67 * t / (t + 243.5)))
    expect(m.q[i] / qs).toBeCloseTo(.95, 2); expect(m.added.vapour).toBeGreaterThan(0)
    for (let k = 0; k < 20; k++) intervene(m, { kind: 'dry', x: 20_000, y: 15_000, strength: 2 })
    expect(m.q[i]).toBe(0); expect(m.added.vapour).toBeLessThan(0)
  })

  it('spins a cyclonic vortex without converging the air', () => {
    const m = fresh(), u = Float32Array.from(m.u), v = Float32Array.from(m.v), { nx, ny, dx, dy } = m.grid
    intervene(m, { kind: 'vortex', x: 24_000, y: 18_000, strength: 1 })
    const R = INTERVENTIONS.vortex.radius!, east = node(m, 24_000 + R, 18_000), north = node(m, 24_000, 18_000 + R)
    expect(m.v[east] - v[east]).toBeGreaterThan(7); expect(m.u[north] - u[north]).toBeLessThan(-7)
    // The added wind's divergence is small beside its vorticity.
    let div = 0, vort = 0
    for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
      const du = (k: number) => m.u[k] - u[k], dv = (k: number) => m.v[k] - v[k], c = x + nx * y
      div = Math.max(div, Math.abs((du(c + 1) - du(c - 1)) / (2 * dx) + (dv(c + nx) - dv(c - nx)) / (2 * dy)))
      vort = Math.max(vort, Math.abs((dv(c + 1) - dv(c - 1)) / (2 * dx) - (du(c + nx) - du(c - nx)) / (2 * dy)))
    }
    expect(div).toBeLessThan(vort * .1)
  })
})
