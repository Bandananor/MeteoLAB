import { describe, expect, it } from 'vitest'
import { takahashiCharge, TAKAHASHI_LWC, TAKAHASHI_TABLE } from './takahashi'
import { takahashiCollision } from './charge'

describe('the Takahashi (1978) charging table of WRF-ELEC (takahashi.ts)', () => {
  it('has 30 rows of cloud water by 31 temperatures', () => {
    expect(TAKAHASHI_LWC.length).toBe(30); expect(TAKAHASHI_TABLE.length).toBe(30)
    expect(TAKAHASHI_TABLE.every(r => r.length === 31)).toBe(true)
  })
  it('reads the file\'s values at its nodes and interpolates between them', () => {
    expect(takahashiCharge(-10, .4)).toBeCloseTo(33, 6) // positive graupel at moderate water, -10 °C
    expect(takahashiCharge(-15, 2)).toBeCloseTo(-33, 6) // negative at -15 °C and 2 g/m³
    expect(takahashiCharge(-20, 30)).toBeCloseTo(24.42, 6)
    expect(takahashiCharge(-9.5, .45)).toBeCloseTo((34.65 + 29.7) / 2, 6)
  })
  it('gives nothing at 0 °C, below 0.01 g/m³ or colder than -40 °C, and tapers from -30 °C', () => {
    expect(takahashiCharge(0, 1)).toBe(0); expect(takahashiCharge(-10, .005)).toBe(0); expect(takahashiCharge(-41, 1)).toBe(0)
    expect(takahashiCharge(-35, .4)).toBeCloseTo(-1.65 * .75, 6)
  })
  it('scales by size and speed as TAKA does, within ±500 fC', () => {
    expect(takahashiCollision(-10, .4, 100e-6, 8)).toBeCloseTo(5 * 33e-15, 20)
    expect(Math.abs(takahashiCollision(-10, .4, 1e-3, 30))).toBeLessThanOrEqual(500e-15)
  })
})
