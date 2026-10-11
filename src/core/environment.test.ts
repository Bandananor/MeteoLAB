import { describe, expect, it } from 'vitest'
import { createGrid, Environment, NIGHT_DEPTH, parcelIndices, SCENARIOS, type SimConfig } from '.'
import { SUMMER_DAY } from './fixtures'

describe('wind profile', () => {
  const at = (windDir0: number, windDir3: number) => new Environment({ ...SUMMER_DAY, windDir0, windDir3 }, createGrid())

  it('turns across north along the shorter arc', () => {
    // The old linear lerp gave 180° halfway from 350° to 10°: the wind blew from the opposite side.
    expect(at(350, 10).windDirection(1500)).toBeCloseTo(0, 9)
    expect(at(10, 350).windDirection(750)).toBeCloseTo(5, 9)
    expect(at(300, 60).windDirection(1500)).toBeCloseTo(0, 9)
    const [u, v] = at(350, 10).windUV(1500)
    expect(v).toBeLessThan(0); expect(Math.abs(u)).toBeLessThan(1e-9)
  })

  it('passes through the optional 0.5 and 1 km nodes (curved low-level hodograph)', () => {
    const env = new Environment({ ...SUMMER_DAY, wind0: 5, windDir0: 120, wind05: 10, windDir05: 150, wind1: 14, windDir1: 180, wind3: 20, windDir3: 240 }, createGrid())
    expect(env.windScalar(500)).toBe(10); expect(env.windDirection(1000)).toBe(180)
    expect(env.windScalar(750)).toBeCloseTo(12, 9); expect(env.windDirection(2000)).toBeCloseTo(210, 9)
    // Without the nodes the lowest 3 km is one straight segment, as before.
    const plain = new Environment({ ...SUMMER_DAY, wind0: 5, windDir0: 120, wind3: 20, windDir3: 240 }, createGrid())
    expect(plain.windScalar(1500)).toBeCloseTo(12.5, 9)
  })

  it('keeps profiles that do not cross north unchanged', () => {
    expect(at(160, 185).windDirection(1500)).toBe(172.5)
    expect(at(140, 200).windDirection(3000)).toBe(200)
  })
})

describe('slider profiles are not unstable by themselves (Environment.neutralise)', () => {
  // Before 2026-10-11 the virtual potential temperature fell by up to 43 K/km at the moist layer's top and the air above
  // the lid cooled at 11-12.5 K/km: both overturned in ~30 min with no sun and no thermal. What is left is the 10 m
  // table interpolated: up to -0.35 K/km over 25 m (0.01 K), nothing that could overturn.
  const unstable = (values: Partial<SimConfig>) => {
    const env = new Environment({ ...SUMMER_DAY, ...values }, createGrid()), thv = (z: number) => env.thetaEnv(z) * (1 + .61 * env.qEnv(z))
    let worst = 0
    for (let z = 0; z < 14_000; z += 25) worst = Math.min(worst, (thv(z + 25) - thv(z)) / .025)
    return worst
  }
  for (const s of SCENARIOS.filter(s => !s.values.profile)) it(`${s.name}: dθv/dz above -0.5 K/km`, () => expect(unstable(s.values)).toBeGreaterThan(-.5))
  it('the steepest slider settings too: a superadiabatic lapse, a strong lid, a deep moist layer', () => {
    expect(unstable({ lapseLow: 11, rhSurface: 90, rhLow: 20, capStrength: 6, capHeight: .5, moistLayer: 2.5 })).toBeGreaterThan(-.5)
    expect(unstable({ lapseLow: 9.8, capStrength: 4, capHeight: 2, moistLayer: 1.5, nightInversion: 8 })).toBeGreaterThan(-.5)
  })
  it('keeps the vapour and warms only where needed: «Летний день» CAPE within 5 % of the plain profile', () => {
    const grid = createGrid(), env = new Environment({ ...SUMMER_DAY, ...SCENARIOS[0].values }, grid)
    expect(env.temperatureEnv(500)).toBeCloseTo(28 - 9.3 * .5, 6)
    // Plain profile (2026-10-10): ML CAPE 2721 J/kg.
    expect(Math.abs(parcelIndices(env, grid.height).ml.cape / 2721 - 1)).toBeLessThan(.05)
  })
})

describe('night inversion (the dawn sounding)', () => {
  const grid = createGrid(), day = new Environment({ ...SUMMER_DAY, moistLayer: 1 }, grid), dawn = new Environment({ ...SUMMER_DAY, moistLayer: 1, nightInversion: 6 }, grid)

  // The deficit itself: the temperatures differ by more where the neutralising warmth differs (above the moist layer).
  it('cools the ground air by nightInversion, the residual layer by a quarter of it, and nothing above the lid', () => {
    expect(day.temperatureEnv(0) - dawn.temperatureEnv(0)).toBeCloseTo(6, 6)
    expect(dawn.nightDeficit(NIGHT_DEPTH)).toBeCloseTo(1.5, 6)
    expect(dawn.nightDeficit(1200)).toBeCloseTo(1.5, 6)
    expect(dawn.nightDeficit(3000)).toBe(0); expect(day.nightDeficit(0)).toBe(0)
  })

  it('keeps the inversion moist but not saturated, and caps the surface parcel of «Суточный ход» until the sun', () => {
    const values = { ...SUMMER_DAY, ...SCENARIOS.find(s => s.name === 'Суточный ход')!.values }, morning = new Environment(values, grid)
    const t = morning.temperatureEnv(0), td = morning.dewpoint(morning.qEnv(0), 0)
    expect(td).toBeLessThan(t)
    expect(t - td).toBeLessThan(6)
    expect(parcelIndices(morning, grid.height).sb.cin).toBeGreaterThan(100)
    expect(parcelIndices(new Environment({ ...values, nightInversion: 0 }, grid), grid.height).sb.cin).toBeLessThan(10)
  })
})
