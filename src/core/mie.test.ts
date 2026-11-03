import { describe, expect, it } from 'vitest'
import { dielectricFactor, mie, porousIce, specificAttenuation, speciesZ } from '.'

describe('Mie scattering of spheres for the radar (mie.ts)', () => {
  it('reproduces the Bohren-Huffman and miepython test cases', () => {
    // BHMIE's example (Bohren & Huffman 1983, appendix A): m 1.55, x = 2 pi 0.525 / 0.6328.
    const bh = mie(2 * Math.PI * .525 / .6328, [1.55, 0])
    expect(bh.ext).toBeCloseTo(3.10543, 4); expect(bh.sca).toBeCloseTo(3.10543, 4); expect(bh.back).toBeCloseTo(2.92534, 4)
    // miepython tests: m 1.5, x = 2 pi (Q_back 2.53277025110356); m 1.55 - 0.1i (absorbing) at that x.
    expect(mie(2 * Math.PI, [1.5, 0]).back).toBeCloseTo(2.53277025110356, 9)
    const absorbing = mie(2 * Math.PI * .525 / .6328, [1.55, .1])
    expect(absorbing.ext).toBeCloseTo(2.86165, 3); expect(absorbing.sca).toBeCloseTo(1.66425, 3); expect(absorbing.back).toBeCloseTo(.20600, 3)
  })

  it('tends to Rayleigh for small spheres, water-like indices included', () => {
    for (const m of [[9.075, 1.253], [7.351, 2.785], [1.786, 2.5e-4]] as const) {
      const x = .01
      expect(mie(x, m).back / (4 * x ** 4 * dielectricFactor(m))).toBeCloseTo(1, 3)
    }
  })

  it('mixes ice with air so that |K|² = (rho / 917)² |K_ice|² (Maxwell Garnett, air the matrix)', () => {
    const ice = [1.786, 0] as const
    expect(porousIce(ice, 400)[0]).toBeCloseTo(1.295, 3); expect(porousIce(ice, 900)[0]).toBeCloseTo(1.767, 2)
    expect(dielectricFactor(porousIce(ice, 400)) / dielectricFactor(ice)).toBeCloseTo((400 / 917) ** 2, 6)
  })

  it('makes large hail weaker at C and X than at S, and leaves small particles Rayleigh', () => {
    const dbz = (hail: number, band: 'S' | 'C' | 'X', wavelength: number, tc = -10) => 10 * Math.log10(speciesZ(1, 0, 0, 0, tc, hail, { band, wavelength }).hail)
    const rayleigh = 10 * Math.log10(speciesZ(1, 0, 0, 0, -10, .005).hail)
    // 5 g/m3 of dry hail (N0 4e4, slope ~390 m^-1: Z from ~1.5 cm stones).
    const s = dbz(.005, 'S', 10), c = dbz(.005, 'C', 5.3), x = dbz(.005, 'X', 3.2)
    expect(rayleigh - s).toBeGreaterThan(0); expect(rayleigh - s).toBeLessThan(2)
    expect(rayleigh - c).toBeGreaterThan(2.5); expect(x).toBeLessThan(c); expect(c).toBeLessThan(s)
    // Light drizzle-sized rain: the same as Rayleigh at every band.
    const rain = (band: 'S' | 'C' | 'X', wavelength: number) => speciesZ(1, 1e-5, 0, 0, 10, 0, { band, wavelength }).rain / speciesZ(1, 1e-5, 0, 0, 10).rain
    expect(rain('X', 3.2)).toBeCloseTo(1, 1); expect(rain('S', 10)).toBeCloseTo(1, 1)
  })
})

describe('attenuation by graupel and hail from the Mie extinction (attenuation.ts)', () => {
  it('puts melting hail at C band within the observed 1-4 dB/km and dry hail at S near nothing', () => {
    const a = (band: 'S' | 'C' | 'X', wavelength: number, hail: number, tc: number) => specificAttenuation(1, 0, 0, hail, tc, 20_000, band, wavelength).a
    // Melting hail at C (Borowska et al. 2011 and others: A_H ~1-4 dB/km in hail cores).
    expect(a('C', 5.3, .003, 5)).toBeGreaterThan(1); expect(a('C', 5.3, .005, 5)).toBeLessThan(4.5)
    // Dry hail: negligible at S, a few tenths at C, more at X (scattering by large ice).
    expect(a('S', 10, .005, -10)).toBeLessThan(.1); expect(a('X', 3.2, .005, -10)).toBeGreaterThan(a('C', 5.3, .005, -10))
  })
})
