import { describe, expect, it } from 'vitest'
import { AtmosphereModel, DT } from '.'
import { SUMMER_DAY } from './fixtures'
import { boundedNumber, dnOf, fallSpeeds, fallSpeedZ, meanVolume, RAIN_MIN, rain2mProcesses, rainNumberChange, RHO_W, XV_MAX, XV_MIN } from './rain2m'

describe('two-moment rain after NSSL (rain2m.ts, Э1 step 1)', () => {
  it('bounds the mean drop between 80 µm and a 6 mm mass-weighted diameter, keeping the mass', () => {
    const q = 2e-3, rho = 1
    // Too few drops (mean drop past the bound): the number rises to the bound; too many: falls to 80 µm.
    const few = boundedNumber(q, 1, rho), many = boundedNumber(q, 1e12, rho)
    expect(q / (RHO_W * few)).toBeCloseTo(XV_MAX, 15); expect(q / (RHO_W * many)).toBeCloseTo(XV_MIN, 20)
    // The mass-weighted diameter at the upper bound: (α+4) Dn = 4 Dn = 6 mm.
    expect(4 * dnOf(XV_MAX)).toBeCloseTo(6e-3, 6)
    // Rain without a number gets Marshall-Palmer's: N = N0 / lambda.
    const lambda = (Math.PI * RHO_W * 8e6 / (rho * q)) ** .25
    expect(boundedNumber(q, 0, rho)).toBeCloseTo(8e6 / lambda / rho, 0)
    expect(boundedNumber(0, 1e5, rho)).toBe(0)
  })

  it('falls faster for bigger drops; the reflectivity faster than the mass, the mass faster than the number', () => {
    const rho = 1.1, small = fallSpeeds(1e-3, 1e6, rho), big = fallSpeeds(1e-3, 1e3, rho)
    expect(big[0]).toBeGreaterThan(small[0])
    for (const [q, n] of [[1e-3, 1e6], [1e-3, 1e4]]) {
      const [m, nn] = fallSpeeds(q, n, rho)
      expect(fallSpeedZ(q, n, rho)).toBeGreaterThan(m); expect(m).toBeGreaterThan(nn)
      expect(m).toBeLessThan(11)
    }
    // Marshall-Palmer rain of 1 g/m3 falls at ~5-6 m/s mass-weighted near the ground.
    const mp = fallSpeeds(1e-3 / 1.2, boundedNumber(1e-3 / 1.2, 0, 1.2), 1.2)[0]
    expect(mp).toBeGreaterThan(4); expect(mp).toBeLessThan(7.5)
  })

  it('makes rain from a deep cloud, and evaporates it in dry air without shrinking the mean drop', () => {
    // In the cloud the air is saturated (the saturation adjustment keeps it there): q = q_s(290 K, 900 hPa).
    const q = Float32Array.of(.01356), cloud = Float32Array.of(3e-3), rain = Float32Array.of(0), num = Float32Array.of(0)
    let t = 0
    for (; t < 1800 && rain[0] < 1e-4; t += DT) rain2mProcesses(q, cloud, rain, num, 0, 290, 9e4, 1.07, DT)
    // Autoconversion by Berry-Reinhardt at 3 g/kg and 600 droplets per cm3: rain within ~20 min, small drops.
    expect(rain[0]).toBeGreaterThan(1e-4); expect(t).toBeLessThan(1500)
    const d = Math.cbrt(6 * meanVolume(rain[0], num[0]) / Math.PI)
    expect(d).toBeGreaterThan(80e-6); expect(d).toBeLessThan(1.5e-3)
    // Dry air below the cloud: rain evaporates, the vapour gains the same, the mean drop mass stays.
    const qd = Float32Array.of(.004), c0 = Float32Array.of(0), r0 = Float32Array.of(1e-3), n0 = Float32Array.of(boundedNumber(1e-3, 0, 1.1))
    const mean0 = r0[0] / n0[0], total0 = qd[0] + r0[0]
    const evap = rain2mProcesses(qd, c0, r0, n0, 0, 295, 9e4, 1.1, DT)
    expect(evap).toBeGreaterThan(0); expect(qd[0] + r0[0]).toBeCloseTo(total0, 9)
    // The evaporation keeps the mean drop mass; the self-collection in the same step only raises it (~1 %).
    expect(r0[0] / n0[0]).toBeGreaterThanOrEqual(mean0 * (1 - 1e-6)); expect(r0[0] / n0[0]).toBeLessThan(mean0 * 1.03)
  })

  it('follows the rain that freezes or melts: a loss keeps the mean drop, a melt adds drops of the melting particles', () => {
    const rain = Float32Array.of(1e-3), num = Float32Array.of(1e4)
    rain[0] = 5e-4; rainNumberChange(rain, num, 0, 1e-3, 1, 0)
    expect(num[0]).toBeCloseTo(5e3, 6)
    rain[0] = 1e-3; rainNumberChange(rain, num, 0, 5e-4, 1, 5e-4 / 2e3)
    expect(num[0]).toBeCloseTo(7e3, 3)
    rain[0] = RAIN_MIN / 2; rainNumberChange(rain, num, 0, 1e-3, 1, 0)
    expect(num[0]).toBe(0)
  })

  it('runs in the model: number carried and falling with the rain, the rain at the ground counted', () => {
    const m = new AtmosphereModel({ ...SUMMER_DAY, seed: 3 })
    m.rainMoments = 2
    const { layer, nz } = m.grid
    // A rain shaft of 2 g/kg from 2 to 4 km over a few columns, Marshall-Palmer number.
    for (let z = 0; z < nz; z++) if (m.grid.zs[z] > 2000 && m.grid.zs[z] < 4000) for (let c = 0; c < 6; c++) { const i = c + z * layer; m.rain[i] = 2e-3; m.rainNumber[i] = boundedNumber(2e-3, 0, m.env.rho[z]) }
    for (let k = 0; k < 200; k++) { m.step(DT); m.time += DT }
    let ground = 0; for (let c = 0; c < layer; c++) ground += m.precipitation[c]
    expect(ground).toBeGreaterThan(0)
    for (let i = 0; i < m.grid.n; i++) {
      expect(m.rainNumber[i]).toBeGreaterThanOrEqual(0)
      if (m.rain[i] > 1e-7) { const xv = m.rain[i] / (RHO_W * m.rainNumber[i]); expect(xv).toBeGreaterThanOrEqual(XV_MIN * .999); expect(xv).toBeLessThanOrEqual(XV_MAX * 1.001) }
    }
  })
})
