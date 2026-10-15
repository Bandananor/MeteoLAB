import { describe, expect, it } from 'vitest'
import { computeSky, hazeExtinction, luminance, SKY_COLS, SKY_ROWS, SUN_LEVELS, SUN_TOP, visibility } from './sky'

const deg = Math.PI / 180, haze = hazeExtinction(.7)
const at = (s: ReturnType<typeof computeSky>, row: number, col: number) => [0, 1, 2].map(c => s.sky[(row * SKY_COLS + col) * 3 + c])
const sunAt = (s: ReturnType<typeof computeSky>, km: number) => { const i = Math.round(km / SUN_TOP * (SUN_LEVELS - 1)); return [0, 1, 2].map(c => s.sunByHeight[i * 3 + c]) }

describe('sky', () => {
  const noon = computeSky(60 * deg, haze, .2), sunset = computeSky(0, haze, .2), after = computeSky(-2.5 * deg, haze, .2), dusk = computeSky(-6 * deg, haze, .2)

  it('is blue at noon, paler toward the horizon, and the sky gives a fraction of the sun\'s light', () => {
    const zenith = at(noon, SKY_ROWS - 1, SKY_COLS - 1), horizon = at(noon, 0, SKY_COLS - 1)
    expect(zenith[2]).toBeGreaterThan(zenith[1]); expect(zenith[1]).toBeGreaterThan(zenith[0])
    expect(luminance(horizon)).toBeGreaterThan(luminance(zenith))
    expect(horizon[2] / horizon[0]).toBeLessThan(zenith[2] / zenith[0])
    const share = luminance(noon.skyIrradiance) / luminance(noon.sunIrradiance)
    console.log(`Небо: полдень — доля неба ${share.toFixed(2)}, зенит ${zenith.map(v => v.toFixed(3))}, горизонт ${horizon.map(v => v.toFixed(3))}`)
    expect(share).toBeGreaterThan(.08); expect(share).toBeLessThan(.35)
  })

  it('reddens the setting sun and keeps it for the anvil after it has set for the ground', () => {
    const ground = sunAt(sunset, 0)
    expect(ground[0]).toBeGreaterThan(ground[1]); expect(ground[1]).toBeGreaterThan(ground[2])
    expect(sunAt(after, 0)[0]).toBe(0)
    const anvil = sunAt(after, 12)
    console.log(`Небо: солнце на горизонте у земли ${ground.map(v => v.toFixed(3))}, на 2.5° под горизонтом на 12 км ${anvil.map(v => v.toFixed(3))}`)
    expect(anvil[0]).toBeGreaterThan(.05); expect(anvil[0]).toBeGreaterThan(anvil[2])
  })

  it('darkens through the twilight, its zenith staying blue (the ozone)', () => {
    const z = at(dusk, SKY_ROWS - 1, SKY_COLS >> 1)
    console.log(`Небо: при −6° освещённость ${luminance(dusk.skyIrradiance).toExponential(2)} против ${luminance(noon.skyIrradiance).toExponential(2)} днём, зенит ${z.map(v => v.toExponential(2))}`)
    expect(luminance(dusk.skyIrradiance)).toBeLessThan(luminance(noon.skyIrradiance) * 2e-3)
    expect(z[2]).toBeGreaterThan(z[0])
    // Toward the set sun the horizon glows warm (mid civil twilight; by -6° the glow is low and faint).
    const glow = at(computeSky(-3 * deg, haze, .2), 2, 0)
    expect(glow[0]).toBeGreaterThan(glow[2])
  })

  it('gives the twilight\'s light as observed (~3 lx at -6°, ~0.01 lx at -12°, for ~1e5 lx with the sun high)', () => {
    const lux = (el: number) => { const st = computeSky(el * deg, haze, .2); return luminance(st.skyIrradiance) + luminance(st.sunIrradiance) }
    const high = lux(90), civil = lux(-6) / high * 1e5, nautical = lux(-12) / high * 1e5
    console.log(`Небо: освещённость земли при −6° ${civil.toFixed(2)} лк, при −12° ${nautical.toFixed(4)} лк`)
    expect(civil).toBeGreaterThan(1); expect(civil).toBeLessThan(10)
    expect(nautical).toBeGreaterThan(.002); expect(nautical).toBeLessThan(.05)
  })

  it('makes damp air turbid', () => {
    expect(visibility(hazeExtinction(.4))).toBeGreaterThan(30)
    expect(visibility(hazeExtinction(.95))).toBeLessThan(15)
  })
})
