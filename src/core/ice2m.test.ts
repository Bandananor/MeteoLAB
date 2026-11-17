import { describe, expect, it } from 'vitest'
import { AtmosphereModel, DT } from '.'
import { SUMMER_DAY } from './fixtures'
import { boundedIceNumber, densityOf, fallLaw, gammaFn, GRAUPEL_2M, HAIL_2M, ice2mProcesses, largestDiameter, momentSpeed, upperGamma } from './ice2m'
import { boundedNumber } from './rain2m'

const node = (v: Partial<Record<string, number>>) => {
  const f = (k: string) => Float32Array.of(v[k] ?? 0)
  return { theta: f('theta'), q: f('q'), cloud: f('cloud'), ice: f('ice'), iceNumber: f('iceNumber'), snow: f('snow'), rain: f('rain'), rainNumber: f('rainNumber'),
    graupel: f('graupel'), graupelNumber: f('graupelNumber'), graupelVolume: f('graupelVolume'), hail: f('hail'), hailNumber: f('hailNumber'), hailVolume: f('hailVolume') }
}

describe('two-moment graupel and hail after NSSL (ice2m.ts, Э1 step 2)', () => {
  it('has its mathematics right: gamma, the incomplete gamma tail, the fall-speed table', () => {
    expect(gammaFn(5)).toBeCloseTo(24, 10); expect(gammaFn(.5)).toBeCloseTo(Math.sqrt(Math.PI), 10); expect(gammaFn(2.9)).toBeCloseTo(1.8273551, 6)
    expect(upperGamma(1, 2)).toBeCloseTo(Math.exp(-2), 12); expect(upperGamma(2, 1)).toBeCloseTo(2 * Math.exp(-1), 12); expect(upperGamma(4, 0)).toBe(1)
    expect(fallLaw(450)).toEqual([145.26, .60572]); expect(fallLaw(900)[0]).toBeGreaterThan(189); expect(fallLaw(100)[0]).toBeCloseTo((62.923 + 94.122) / 2, 3)
  })

  it('takes the density from the volume within its bounds and bounds the mean particle', () => {
    expect(densityOf(GRAUPEL_2M, 1e-3, 1e-3 / 400)).toBeCloseTo(400, 3)
    expect(densityOf(GRAUPEL_2M, 1e-3, 1)).toBe(170); expect(densityOf(HAIL_2M, 1e-3, 1)).toBe(500); expect(densityOf(HAIL_2M, 1e-3, 0)).toBe(800)
    // A few huge particles: the number rises so the mass-weighted diameter stays at 20 mm.
    const n = boundedIceNumber(GRAUPEL_2M, 1e-3, 1e-3, 1e-3 / 500), xv = 1e-3 / (500 * n)
    expect(4 * Math.cbrt(6 * xv / Math.PI) / Math.cbrt(6)).toBeCloseTo(20e-3, 6)
  })

  it('falls faster when denser and bigger; reflectivity faster than mass faster than number', () => {
    const light = momentSpeed(GRAUPEL_2M, 1e-3, 1e3, 1e-3 / 200, 1, 3), dense = momentSpeed(GRAUPEL_2M, 1e-3, 1e3, 1e-3 / 800, 1, 3)
    expect(dense).toBeGreaterThan(light)
    const z = momentSpeed(HAIL_2M, 2e-3, 100, 2e-3 / 900, 1, 6), m = momentSpeed(HAIL_2M, 2e-3, 100, 2e-3 / 900, 1, 3), nn = momentSpeed(HAIL_2M, 2e-3, 100, 2e-3 / 900, 1, 0)
    expect(z).toBeGreaterThan(m); expect(m).toBeGreaterThan(nn); expect(m).toBeGreaterThan(10); expect(m).toBeLessThan(45)
  })

  it('finds the largest stones from the tail: bigger for fewer, bigger stones', () => {
    const many = largestDiameter(HAIL_2M, 2e-3, 1e4, 2e-3 / 900, 1), few = largestDiameter(HAIL_2M, 2e-3, 10, 2e-3 / 900, 1)
    expect(few).toBeGreaterThan(many); expect(few).toBeGreaterThan(20e-3); expect(many).toBeLessThan(15e-3)
  })

  it('rimes graupel in a supercooled cloud, densifies it, and melts it into drops above 0 °C', () => {
    const exner = .8, p = 6e4, rho = .8
    const f = node({ theta: 263.15 / exner, q: 2.6e-3, cloud: 2e-3, graupel: 1e-3, graupelNumber: 1e4, graupelVolume: 1e-3 / 300 })
    const water = f.cloud[0] + f.graupel[0] + f.q[0]
    for (let k = 0; k < 20; k++) ice2mProcesses(f, 0, exner, p, rho, DT)
    expect(f.graupel[0]).toBeGreaterThan(1e-3); expect(f.cloud[0]).toBeLessThan(2e-3)
    expect(f.cloud[0] + f.graupel[0] + f.q[0] + f.rain[0]).toBeCloseTo(water, 8)
    expect(f.graupel[0] / f.graupelVolume[0]).toBeGreaterThan(300)
    const warm = node({ theta: 283.15 / .95, q: 5e-3, graupel: 2e-3, graupelNumber: 2e3, graupelVolume: 2e-3 / 600 })
    const r = ice2mProcesses(warm, 0, .95, 9e4, 1.1, DT)
    expect(r.cooling).toBeGreaterThan(0); expect(warm.rain[0]).toBeGreaterThan(0); expect(warm.rainNumber[0]).toBeGreaterThan(0)
    expect(warm.rain[0] + warm.graupel[0]).toBeCloseTo(2e-3, 8)
  })

  it('freezes drops into graupel below 0 °C (Bigg)', () => {
    const f = node({ theta: 253.15 / .7, q: 1e-3, rain: 1e-3, rainNumber: boundedNumber(1e-3, 0, .7) })
    ice2mProcesses(f, 0, .7, 5e4, .7, DT)
    expect(f.graupel[0]).toBeGreaterThan(0); expect(f.graupelNumber[0]).toBeGreaterThan(0)
    // Water kept (the new graupel also sublimates a little in air subsaturated over ice).
    expect(f.graupel[0] + f.rain[0] + f.q[0]).toBeCloseTo(2e-3, 8)
  })

  it('runs in the model with two-moment rain: numbers and volumes stay with their mass', () => {
    const m = new AtmosphereModel({ ...SUMMER_DAY, seed: 5 })
    m.rainMoments = 2; m.iceMoments = 2
    const { layer, nz, zs } = m.grid
    for (let z = 0; z < nz; z++) if (zs[z] > 3000 && zs[z] < 7000) for (let c = 0; c < 8; c++) { const i = c + z * layer; m.graupel[i] = 2e-3; m.graupelNumber[i] = 2e3; m.graupelVolume[i] = 2e-3 / 500; m.hail[i] = 1e-3; m.hailNumber[i] = 50; m.hailVolume[i] = 1e-3 / 900 }
    for (let k = 0; k < 120; k++) { m.step(DT); m.time += DT }
    let ground = 0; for (let c = 0; c < layer; c++) ground += m.precipitation[c]
    expect(ground).toBeGreaterThan(0)
    for (let i = 0; i < m.grid.n; i++) {
      for (const [q, n, v] of [[m.graupel, m.graupelNumber, m.graupelVolume], [m.hail, m.hailNumber, m.hailVolume]] as const) {
        expect(Number.isFinite(n[i])).toBe(true); expect(n[i]).toBeGreaterThanOrEqual(0)
        if (q[i] > 1e-7) { expect(n[i]).toBeGreaterThan(0); const d = q[i] / v[i]; expect(d).toBeGreaterThan(160); expect(d).toBeLessThan(910) }
      }
    }
  })
})
