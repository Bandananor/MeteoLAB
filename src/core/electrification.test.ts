import { describe, expect, it } from 'vitest'
import { AtmosphereModel, DT } from '.'
import { QUIET } from './fixtures'
import { qsatP } from './microphysics'

/** A quiet model with a block of mixed-phase cloud (cloud water, ice, snow, graupel) at the levels between z0 and z1, m. */
function mixedPhase(lightning = true, z0 = 5500, z1 = 7500) {
  const m = new AtmosphereModel({ ...QUIET, lightning }), { nx, ny, nz, layer, zs } = m.grid
  for (let z = 0; z < nz; z++) if (zs[z] >= z0 && zs[z] <= z1) for (let y = ny / 2 - 3; y < ny / 2 + 3; y++) for (let x = nx / 2 - 3; x < nx / 2 + 3; x++) {
    const i = x + y * nx + z * layer
    m.cloud[i] = 1e-3; m.ice[i] = 5e-4; m.snow[i] = 5e-4; m.graupel[i] = 2e-3
    // Saturated over water, so the droplets neither evaporate nor grow much in a few steps.
    m.q[i] = Math.max(m.q[i], qsatP(m.theta[i] * m.env.exner[z] - 273.15, m.env.p[z]))
  }
  return m
}

describe('electrification in the model (2.3 step 2)', () => {
  it('collisions in a mixed-phase cloud separate charge without creating any: the domain stays neutral', () => {
    const m = mixedPhase()
    for (let k = 0; k < 10; k++) { m.step(DT); m.time += DT }
    // Separated charge, C: |charge| of every carrier summed over the nodes' air mass.
    const { nz, layer, dx, dy, hz } = m.grid
    let separated = 0
    for (let z = 0; z < nz; z++) for (let i = z * layer; i < (z + 1) * layer; i++) separated += (Math.abs(m.chargeIce[i]) + Math.abs(m.chargeGraupel[i]) + Math.abs(m.chargeRain[i])) * m.env.rho[z] * dx * dy * hz[z]
    expect(separated).toBeGreaterThan(0)
    // Charge has been separated (graupel one sign, crystals the other)…
    const graupel = m.chargeGraupel.reduce((s, c) => s + c, 0), ice = m.chargeIce.reduce((s, c) => s + c, 0)
    expect(Math.abs(graupel)).toBeGreaterThan(0); expect(Math.sign(graupel)).toBe(-Math.sign(ice))
    // …and the total, with what fell to the ground, is still zero to rounding.
    expect(Math.abs(m.totalCharge() + m.chargeGround)).toBeLessThan(1e-5 * separated)
  })

  it('a charged block moves and falls with its carriers, and the charge is conserved (WENO transport)', () => {
    const m = mixedPhase(true, 8000, 9500), { n } = m.grid
    // No cloud water: no new charging; a net positive charge on the graupel only.
    m.cloud.fill(0)
    for (let i = 0; i < n; i++) if (m.graupel[i] > 0) m.chargeGraupel[i] = 1e-9 / m.env.rho[Math.floor(i / m.grid.layer)]
    const start = m.totalCharge(), heightOf = () => { let s = 0, h = 0; for (let i = 0; i < n; i++) { const c = m.chargeGraupel[i]; s += c; h += c * m.grid.zs[Math.floor(i / m.grid.layer)] } return h / s }
    const h0 = heightOf()
    for (let k = 0; k < 20; k++) { m.step(DT); m.time += DT }
    expect(Math.abs(m.totalCharge() + m.chargeGround - start) / start).toBeLessThan(1e-4)
    // The graupel (~5 m/s) has carried its charge down by roughly its fall in a minute.
    expect(h0 - heightOf()).toBeGreaterThan(150)
  })

  it('a strongly charged cloud flashes during the step, and the charge with what went to the ground is conserved', () => {
    const m = new AtmosphereModel({ ...QUIET, lightning: true }), { nx, ny, nz, layer, zs, dx, dy } = m.grid
    // Negative charge on graupel at 6.5 km under positive charge on ice at 9 km, 3 nC/m³ at the centre: above the threshold.
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = x + y * nx + z * layer, r2 = ((x - nx / 2) * dx) ** 2 + ((y - ny / 2) * dy) ** 2, rho = m.env.rho[z]
      m.chargeIce[i] = 3e-9 * Math.exp(-r2 / 2500 ** 2 - ((zs[z] - 9000) / 700) ** 2) / rho
      m.chargeGraupel[i] = -3e-9 * Math.exp(-r2 / 2500 ** 2 - ((zs[z] - 6500) / 700) ** 2) / rho
    }
    const start = m.totalCharge()
    m.step(DT); m.time += DT
    expect(m.flashes.length).toBeGreaterThan(0)
    expect(m.flashCount.ic + m.flashCount.cg).toBe(m.flashes.length)
    expect(m.flashes.every(f => f.time === DT)).toBe(true)
    expect(Math.abs(m.totalCharge() + m.chargeGround - start)).toBeLessThan(1e-3)
  })

  it('switched off, or without the ice microphysics, no charge appears', () => {
    for (const m of [mixedPhase(false), (() => { const w = mixedPhase(); w.config.microphysics = 'warm'; return w })()]) {
      for (let k = 0; k < 5; k++) { m.step(DT); m.time += DT }
      expect(m.chargeGraupel.every(c => c === 0) && m.chargeIce.every(c => c === 0)).toBe(true)
    }
  })
})
