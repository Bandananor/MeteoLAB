import { describe, expect, it } from 'vitest'
import { lgZaToDbz, PHENOMENA, phenomenon, squallSpeed } from '.'

describe('the phenomena map of the Russian radars (phenomena.ts)', () => {
  const lv = { h0: 3.5, h22: 6, tropopause: 12, motion: 0 }
  const column = (c: Partial<Parameters<typeof phenomenon>[0]>) => ({ top: 0, strongest: -20, z1: -20, z2: -20, zh3: -20, zCore: -20, zmax: -20, mesh: 0, ...c })

  it('keeps the GIMET-2010 codes and the RD units (dBZ = 10 lg Za + 18)', () => {
    expect(PHENOMENA.map(p => p.code)).toEqual([...Array(20).keys(), 31])
    expect(lgZaToDbz(2.8)).toBe(46); expect(lgZaToDbz(4)).toBe(58)
  })

  it('tells cloud, precipitation and showers apart, graded by Z1 (18 / 30 / 46 dBZ)', () => {
    expect(phenomenon(column({}), lv)).toBe(0)
    expect(phenomenon(column({ top: 7 }), lv)).toBe(1)
    expect(phenomenon(column({ top: 3, z1: 5 }), lv)).toBe(2)
    expect(phenomenon(column({ top: 3, z1: 25 }), lv)).toBe(3)
    expect(phenomenon(column({ top: 3, z1: 40 }), lv)).toBe(4)
    expect(phenomenon(column({ top: 6, z2: 25 }), lv)).toBe(6)
    expect(phenomenon(column({ top: 5, z1: 25, z2: 25 }), lv)).toBe(7)
    expect(phenomenon(column({ top: 5, z1: 50, z2: 40 }), lv)).toBe(9)
  })

  it('finds thunder by Y = H lg Z3 against Y_cr = H(-22 °C) lg Z3min (7.2 here), +6, +14', () => {
    // lg Z3 1.0 (28 dBZ) at a 10 km top: Y 10 > 7.2; 1.5 (33 dBZ): 15 > 13.2; 2.5 (43 dBZ): 25 > 21.2.
    expect(phenomenon(column({ top: 10, z1: 30, z2: 30, zh3: 28 }), lv)).toBe(10)
    expect(phenomenon(column({ top: 10, z1: 30, z2: 30, zh3: 33 }), lv)).toBe(11)
    expect(phenomenon(column({ top: 10, z1: 30, z2: 30, zh3: 43 }), lv)).toBe(12)
    // Not with the top below the -22 °C level, however strong the echo.
    expect(phenomenon(column({ top: 5.5, z1: 50, z2: 50, zh3: 50 }), lv)).toBe(9)
  })

  it('finds hail by RD 52.04.320-91 (58 dBZ, or 55 with a 10 km top, a 46 dBZ core above H0 + 1.4 km) and grades it', () => {
    // lg Z3 2.7 at a 9 km top: Y 24.3 > 21.2, thunder > 90 %.
    const storm = { top: 9, z1: 50, z2: 55, zh3: 45, zCore: 50 }
    expect(phenomenon(column({ ...storm, zmax: 56 }), lv)).toBe(12)
    expect(phenomenon(column({ ...storm, zmax: 59 }), lv)).toBe(13)
    expect(phenomenon(column({ ...storm, top: 10, zmax: 56 }), lv)).toBe(13)
    expect(phenomenon(column({ ...storm, zmax: 59, zCore: 40 }), lv)).toBe(12)
    expect(phenomenon(column({ ...storm, zmax: 64 }), lv)).toBe(14)
    expect(phenomenon(column({ ...storm, zmax: 64, mesh: 25 }), lv)).toBe(15)
  })

  it('estimates the squall speed by RD table 2.7 and marks squalls of >= 15 m/s; a tornado above the tropopause', () => {
    expect(squallSpeed(5)).toBe(0); expect(squallSpeed(40)).toBeCloseTo(19.5); expect(squallSpeed(200)).toBe(30)
    const storm = column({ top: 11, z1: 50, z2: 54, zh3: 45, zCore: 47, zmax: 54, strongest: 54 })
    expect(phenomenon(storm, lv)).toBe(12)
    expect(phenomenon(storm, { ...lv, motion: 20 })).toBe(16)
    expect(phenomenon(storm, { ...lv, motion: 60 })).toBe(17)
    expect(phenomenon(storm, { ...lv, motion: 100 })).toBe(18)
    expect(phenomenon({ ...storm, top: 15.5, hook: true }, lv)).toBe(19)
    expect(phenomenon({ ...storm, top: 15.5, strongest: 50, hook: true }, lv)).toBe(12)
    // Not without a hook echo, however high the top.
    expect(phenomenon({ ...storm, top: 15.5 }, lv)).toBe(12)
    // Not without thunder > 90 %: lg Z3 1.5 (33 dBZ) at 11 km gives Y 16.5, 71-90 %.
    expect(phenomenon({ ...storm, zh3: 33 }, { ...lv, motion: 100 })).toBe(11)
    // Nor away from a convective core (>= 46 dBZ above H0 + 1.4 km).
    expect(phenomenon({ ...storm, zCore: 40 }, { ...lv, motion: 100 })).toBe(12)
    expect(phenomenon(column({ top: 9, z1: 50, z2: 55, zh3: 33, zCore: 50, zmax: 64 }), lv)).toBe(11)
  })
})
