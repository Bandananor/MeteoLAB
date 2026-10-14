import { describe, expect, it } from 'vitest'
import { chargingRate, collisionCharge, criticalRar, crystalDiameter, crystalNumber, MAX_COLLISION_CHARGE, transferCharge } from './charge'

describe('electrification (2.3): non-inductive charging and charge carried with the water', () => {
  it('the critical rime accretion rate of Saunders and Peck (1998): ~1.1 g/m²/s at -7 °C, rising to ~3.4 at -24 °C', () => {
    expect(criticalRar(-7.35)).toBeCloseTo(1.14, 2); expect(criticalRar(-10)).toBeCloseTo(1.19, 2); expect(criticalRar(-15)).toBeCloseTo(1.65, 2)
    for (let t = -8; t >= -23; t--) expect(criticalRar(t)).toBeGreaterThan(criticalRar(t + 1))
    expect(criticalRar(-20)).toBeCloseTo(2.76, 1); expect(criticalRar(-23.7)).toBeCloseTo(3.39, 1)
    // Held outside the fit.
    expect(criticalRar(-2)).toBe(criticalRar(-7.35)); expect(criticalRar(-30)).toBe(criticalRar(-23.7))
  })

  it('the per-collision charge: B d^a continuous at 155 and 452 µm; graupel + at high RAR, − at low RAR; none above 0 or below -33 °C', () => {
    for (const d of [155e-6, 452e-6]) { const below = collisionCharge(-15, 3, d * (1 - 1e-9), 3), above = collisionCharge(-15, 3, d, 3); expect(above / below).toBeCloseTo(1, 2) }
    // Riming hard at -10 °C (RAR 3 > ~1.0): positive graupel — the lower positive charge region.
    expect(collisionCharge(-10, 3, 100e-6, 5)).toBeGreaterThan(0)
    // At -20 °C with a moderate rate (1 < 2.8): negative graupel — the main negative region at -10…-25 °C.
    expect(collisionCharge(-20, 1, 100e-6, 5)).toBeLessThan(0)
    // Tens of femtocoulombs at most for 100 µm crystals at 5 m/s, as in the laboratory.
    expect(Math.abs(collisionCharge(-20, 1.4, 100e-6, 5))).toBeGreaterThan(1e-16); expect(Math.abs(collisionCharge(-20, 1.4, 100e-6, 5))).toBeLessThanOrEqual(MAX_COLLISION_CHARGE)
    expect(collisionCharge(1, 3, 100e-6, 5)).toBe(0); expect(collisionCharge(-35, 3, 100e-6, 5)).toBe(0); expect(collisionCharge(-15, .05, 100e-6, 5)).toBe(0)
    expect(Math.abs(collisionCharge(-15, 20, 3e-3, 30))).toBe(MAX_COLLISION_CHARGE)
  })

  it('charging needs supercooled cloud water, crystals and rimers; its sign follows the riming', () => {
    const rho = .7, args = [rho, 1e-3, 5e-4, 5e-4, 2e-3, 0, .8] as const
    expect(chargingRate(-15, ...args)).not.toBe(0)
    expect(chargingRate(-15, rho, 0, 5e-4, 5e-4, 2e-3, 0, .8)).toBe(0)
    expect(chargingRate(-15, rho, 1e-3, 0, 0, 2e-3, 0, .8)).toBe(0)
    expect(chargingRate(-15, rho, 1e-3, 5e-4, 5e-4, 0, 0, .8)).toBe(0)
    expect(chargingRate(5, ...args)).toBe(0)
    // Little cloud water at -20 °C: negative graupel; much of it at -10 °C: positive.
    expect(chargingRate(-20, rho, 2e-4, 5e-4, 5e-4, 2e-3, 0, .8)).toBeLessThan(0)
    expect(chargingRate(-10, rho, 2e-3, 5e-4, 5e-4, 2e-3, 0, .8)).toBeGreaterThan(0)
    // A mature updraft's flank (1 g/m³ of graupel and of ice, 0.2 g/m³ of cloud water): ~0.01-10 nC/m³ per minute, the
    // order that builds storm fields in ten minutes or so where many such nodes charge.
    // The effective water (0.6 of the cloud water) at the charging rimers' impact speed (6 m/s): at -20 °C graupel turns
    // positive only above ~0.8 g/m³ of cloud water (the strong core), negative below it (the flanks, the anvil).
    expect(chargingRate(-20, 1, 1.5e-3, 5e-4, 5e-4, 2e-3, 0, .8)).toBeGreaterThan(0)
    expect(chargingRate(-20, 1, .5e-3, 5e-4, 5e-4, 2e-3, 0, .8)).toBeLessThan(0)
    // In wet growth the crystals stick: no charge.
    expect(chargingRate(-10, rho, 2e-3, 5e-4, 5e-4, 2e-3, 0, .8, true)).toBe(0)
    const perMinute = Math.abs(chargingRate(-20, rho, 3e-4, 1.4e-3, 1e-3, 1.4e-3, 0, .8)) * 60
    expect(perMinute).toBeGreaterThan(1e-11); expect(perMinute).toBeLessThan(1e-8)
    expect(crystalDiameter(1e-3, rho, -20)).toBeGreaterThan(50e-6); expect(crystalDiameter(1e-3, rho, -20)).toBeLessThan(300e-6 + 1e-12)
    // Crystals of a convective core: tens to 150 per litre from the ice mass, not the 0.03 per litre of primary
    // nucleation at -6 °C.
    expect(crystalNumber(-6, 3e-4, rho)).toBeGreaterThan(100e3); expect(crystalNumber(-6, 3e-4, rho)).toBeLessThanOrEqual(150e3)
    expect(crystalNumber(-6, 0, rho)).toBeLessThan(100); expect(crystalNumber(-35, 1e-6, rho)).toBeGreaterThan(1e4)
  })

  it('charge follows the mass between carriers; what evaporates leaves its charge to the ions; the sum never changes', () => {
    const sum = (c: number[]) => c.reduce((a, b) => a + b, 0)
    // Half the rain freezes into graupel: half of the rain's charge moves to the graupel.
    let c = [0, 0, 2e-9, 0]
    transferCharge(c, [0, 0, 1e-3, 0], [0, 5e-4, 5e-4, 0])
    expect(c[2]).toBeCloseTo(1e-9, 20); expect(c[1]).toBeCloseTo(1e-9, 20)
    // All the graupel melts into rain.
    c = [0, -3e-9, 0, 0]; transferCharge(c, [0, 1e-3, 0, 0], [0, 0, 1e-3, 0]); expect(c).toEqual([0, 0, -3e-9, 0])
    // Ice sublimates by half, nothing gains: half its charge stays in the air as ions.
    c = [4e-9, 0, 0, 0]; transferCharge(c, [1e-3, 0, 0, 0], [5e-4, 0, 0, 0]); expect(c[0]).toBeCloseTo(2e-9, 20); expect(c[3]).toBeCloseTo(2e-9, 20)
    // Graupel loses 1 g/kg, of which 0.25 goes into rain (shedding) and the rest evaporates.
    c = [0, 8e-9, 0, 0]
    transferCharge(c, [0, 2e-3, 0, 0], [0, 1e-3, 2.5e-4, 0])
    expect(c[1]).toBeCloseTo(4e-9, 20); expect(c[2]).toBeCloseTo(1e-9, 20); expect(c[3]).toBeCloseTo(3e-9, 20)
    // Graupel collects cloud water (riming): the droplets' charge goes with them.
    c = [0, 0, 0, 6e-9]; transferCharge(c, [0, 1e-3, 0, 1e-3], [0, 1.5e-3, 0, 5e-4]); expect(c[1]).toBeCloseTo(3e-9, 20); expect(c[3]).toBeCloseTo(3e-9, 20)
    // Growth from vapour only (deposition): no charge appears.
    c = [1e-9, 0, 0, 0]; transferCharge(c, [1e-3, 0, 0, 0], [2e-3, 0, 0, 0]); expect(c).toEqual([1e-9, 0, 0, 0])
    // A precipitation carrier without mass (a transport tail) passes its charge to the ions; ions in clear air stay.
    c = [0, 5e-12, 0, 2e-12]; transferCharge(c, [0, 0, 0, 0], [0, 0, 0, 0]); expect(c[1]).toBe(0); expect(c[3]).toBeCloseTo(7e-12, 25)
    // Whatever happens, the total is unchanged.
    c = [3e-9, -5e-9, 1e-9, -2e-10]; const before = sum(c)
    transferCharge(c, [1e-3, 2e-3, 5e-4, 3e-4], [2e-4, 2.6e-3, 0, 1e-4]); expect(sum(c)).toBeCloseTo(before, 22)
  })
})
