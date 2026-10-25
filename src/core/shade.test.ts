import { describe, expect, it } from 'vitest'
import { AtmosphereModel, sunDirection, sunlightThrough } from '.'
import { SUMMER_DAY } from './fixtures'

/** A model with a 3 km deep cloud of 2 g/kg over one column at 6-9 km, the shadows worked out at local hour `hour`. */
function shaded(hour: number, shade?: boolean) {
  const m = new AtmosphereModel({ ...SUMMER_DAY, hour, shade }), { nx, ny, layer, zs } = m.grid, cx = nx >> 1, cy = ny >> 1
  for (let z = 0; z < zs.length; z++) if (zs[z] >= 6000 && zs[z] <= 9000) m.cloud[cx + nx * cy + z * layer] = 2e-3
  ;(m as unknown as { updateShade(): void }).updateShade()
  const darkest = m.sunNow.reduce((k, v, i, a) => v < a[k] ? i : k, 0)
  return { m, cx, cy, x: darkest % nx, y: Math.floor(darkest / nx) }
}

describe('cloud shadows on the ground (roadmap B10)', () => {
  it('lets through what the delta-Eddington two-stream solution gives', () => {
    expect(sunlightThrough(0, 1)).toBe(1)
    expect(sunlightThrough(10, 1)).toBeCloseTo(.58, 2)
    expect(sunlightThrough(300, 1)).toBeLessThan(.05)
    // Thicker lets less through, and a low sun less than a high one.
    for (const tau of [.5, 3, 30]) { expect(sunlightThrough(tau * 2, 1)).toBeLessThan(sunlightThrough(tau, 1)); expect(sunlightThrough(tau, .3)).toBeLessThan(sunlightThrough(tau, 1)) }
  })

  it('casts the shadow away from the sun: west of the cloud in the morning, east in the evening', () => {
    const morning = shaded(9), evening = shaded(15)
    expect(morning.x).toBeLessThan(morning.cx); expect(evening.x).toBeGreaterThan(evening.cx)
    // The sun in the south at 45° N: the shadow north of the cloud (y grows northwards).
    expect(morning.y).toBeGreaterThanOrEqual(morning.cy); expect(evening.y).toBeGreaterThanOrEqual(evening.cy)
    // 7.5 km up with the sun at 9:00 (equinox, 45° N): the shadow ~7.5 km / tan(elevation) away along the ground.
    const sun = sunDirection(morning.m.config, 0), along = 7500 * Math.hypot(sun.x, sun.z) / sun.y / morning.m.grid.dx
    expect(Math.abs(Math.hypot(morning.x - morning.cx, morning.y - morning.cy) - along)).toBeLessThan(2.5)
    expect(morning.m.sunNow[morning.x + morning.m.grid.nx * morning.y]).toBeLessThan(.3)
  })

  it('with relaxed edges the shadow does not wrap round to the other side', () => {
    const m = new AtmosphereModel({ ...SUMMER_DAY, hour: 9, edges: 'relaxed' }), { nx, ny, layer, zs } = m.grid
    // A cloud at the western edge: in the morning its shadow would fall west of it, beyond the edge.
    for (let z = 0; z < zs.length; z++) if (zs[z] >= 6000 && zs[z] <= 9000) for (let y = 0; y < ny; y++) m.cloud[nx * y + z * layer] = 2e-3
    ;(m as unknown as { updateShade(): void }).updateShade()
    expect(Math.min(...m.sunNow)).toBe(1)
  })

  it('switches off: the sun then heats every column as under a clear sky', () => {
    expect(shaded(12, false).m.sunNow.every(v => v === 1)).toBe(true)
  })
})
