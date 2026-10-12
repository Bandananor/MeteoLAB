import { describe, expect, it } from 'vitest'
import { dropAxisRatio, dualPol, reflectivity } from '.'

// Signs and magnitudes from the dual-polarisation literature (Kumjian 2013; Bringi and Chandrasekar 2001), S band.
describe('dual polarisation (ZDR, rho_hv, KDP)', () => {
  it('flattens raindrops with size: spheres below 1 mm, ~0.8 at 4 mm', () => {
    expect(dropAxisRatio(.5)).toBeCloseTo(1, 2)
    expect(dropAxisRatio(2)).toBeGreaterThan(.9); expect(dropAxisRatio(2)).toBeLessThan(.96)
    expect(dropAxisRatio(4)).toBeGreaterThan(.75); expect(dropAxisRatio(4)).toBeLessThan(.85)
  })

  it('rain: ZDR and KDP grow with the rain (bigger drops), rho_hv stays near 1', () => {
    const at = (gkg: number) => dualPol(1.1, gkg / 1000, 0, 0, 15)
    const light = at(.1), moderate = at(1), heavy = at(4)
    expect(light.zdr).toBeGreaterThan(.2); expect(light.zdr).toBeLessThan(1)
    expect(moderate.zdr).toBeGreaterThan(light.zdr); expect(heavy.zdr).toBeGreaterThan(moderate.zdr); expect(heavy.zdr).toBeLessThan(4)
    for (const d of [light, moderate, heavy]) expect(d.rho).toBeGreaterThan(.99)
    // ~50 dBZ rain: KDP of the order of 1 deg/km.
    const two = at(2)
    expect(reflectivity(1.1, .002, 0, 0, 15)).toBeGreaterThan(47); expect(two.kdp).toBeGreaterThan(.5); expect(two.kdp).toBeLessThan(2.5)
    expect(heavy.kdp).toBeGreaterThan(two.kdp)
  })

  it('hail: high Z with ZDR near zero; mixed with rain while melting, rho_hv drops', () => {
    const dry = dualPol(1, 0, 0, 0, -10, .004), wet = dualPol(1, .003, 0, 0, 5, .004)
    expect(reflectivity(1, 0, 0, 0, -10, .004)).toBeGreaterThan(55); expect(Math.abs(dry.zdr)).toBeLessThan(.5)
    expect(wet.rho).toBeLessThan(.93); expect(wet.zdr).toBeLessThan(dualPol(1, .003, 0, 0, 5).zdr)
  })

  it('the melting layer: melting snow raises ZDR and lowers rho_hv against dry snow above', () => {
    const dry = dualPol(.8, 0, .002, 0, -5), melting = dualPol(1, .0005, .002, 0, 1)
    expect(dry.rho).toBeGreaterThan(.98); expect(dry.zdr).toBeLessThan(.6)
    expect(melting.rho).toBeLessThan(.95); expect(melting.zdr).toBeGreaterThan(dry.zdr)
  })

  it('nothing without precipitation', () => {
    const d = dualPol(1, 0, 0, 0, 10)
    expect(d.zdr).toBeNaN(); expect(d.rho).toBeNaN(); expect(d.kdp).toBeNaN()
  })
})
