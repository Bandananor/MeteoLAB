import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, DT, waterBudget } from '.'
import { SUMMER_DAY } from './fixtures'

describe('the domain water budget (water.ts)', () => {
  it('closes in a periodic domain: the ground and hand vapour equal the reservoirs, rain forms, efficiency is a share', () => {
    const m = new AtmosphereModel({ ...SUMMER_DAY }, createGrid({ nx: 32, ny: 32, nz: 30, width: 38_400, depth: 38_400, height: 16_000 }))
    const start = waterBudget(m).remainder
    for (let t = 0; t < 25 * 60; t += DT) { m.step(DT); m.time += DT }
    const b = waterBudget(m)
    expect(b.condensed).toBeGreaterThan(0); expect(b.surface).toBeGreaterThan(0); expect(b.evaporated).toBeGreaterThanOrEqual(b.rainEvaporated)
    // The flows explain the reservoirs to a part in a thousand of what condensed (float32 sums, the transport's fills).
    expect(Math.abs(b.remainder - start)).toBeLessThan(1e-3 * (b.condensed + b.surface))
    expect(b.efficiency).toBeGreaterThanOrEqual(0); expect(b.efficiency).toBeLessThan(1)
  }, 120_000)
})
