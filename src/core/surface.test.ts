import { describe, expect, it } from 'vitest'
import { AtmosphereModel, CP, dragCoefficient, insolation, LONGWAVE_LOSS, LV, SURFACES, surfaceFluxes, type SimConfig } from '.'
import { QUIET, SUMMER_DAY } from './fixtures'

describe('surface energy balance', () => {
  it('follows the cosine of the solar zenith angle, including latitude', () => {
    const at = (latitude: number, hour: number) => insolation({ ...SUMMER_DAY, latitude, hour, solarMax: 1000 }, 0)
    expect(at(0, 12)).toBeCloseTo(1000, 6)
    expect(at(45, 12)).toBeCloseTo(1000 * Math.SQRT1_2, 6)
    expect(at(60, 12)).toBeCloseTo(500, 6)
    expect(at(45, 5)).toBe(0)
  })

  it('splits the absorbed shortwave into longwave loss, storage, H and LE', () => {
    for (const surfaceType of Object.keys(SURFACES) as SimConfig['surfaceType'][]) for (const soilMoisture of [0, 45, 100]) {
      const config = { ...SUMMER_DAY, surfaceType, soilMoisture }, f = surfaceFluxes(config, 0), storage = SURFACES[surfaceType].storage
      expect(f.sensible + f.latent).toBeCloseTo(f.available, 9)
      expect(f.available / (1 - storage) + LONGWAVE_LOSS).toBeCloseTo(f.absorbed, 9)
      expect(f.sensible).toBeGreaterThanOrEqual(0); expect(f.latent).toBeGreaterThanOrEqual(0)
    }
    // Moist grass evaporates, dry soil and city mostly heat the air, water evaporates regardless of the soil slider.
    const bowen = (surfaceType: SimConfig['surfaceType'], soilMoisture = 45) => { const f = surfaceFluxes({ ...SUMMER_DAY, surfaceType, soilMoisture }, 0); return f.sensible / f.latent }
    expect(bowen('grass')).toBeLessThan(2); expect(bowen('urban', 15)).toBeGreaterThan(20); expect(bowen('water', 0)).toBeLessThan(.3)
  })

  it('drags the ground wind with a roughness-dependent coefficient, leaving the environment steady', () => {
    const cd = (surfaceType: SimConfig['surfaceType']) => dragCoefficient({ ...SUMMER_DAY, surfaceType }, 652)
    expect(cd('grass')).toBeGreaterThan(.0015); expect(cd('grass')).toBeLessThan(.003)
    expect(cd('water')).toBeLessThan(cd('grass')); expect(cd('urban')).toBeGreaterThan(2 * cd('grass'))
    // A 10 m/s gust on top of the background decays over hours, not seconds (the old x0.94 took ~16 s). Measured as the
    // column's momentum: on the stretched grid the 50 m ground layer also mixes the gust up into the next levels.
    const model = new AtmosphereModel({ ...QUIET, solarMax: 0 }), { layer, nz, hz } = model.grid, e = model.env
    for (let i = 0; i < layer; i++) model.u[i] += 10
    model.step(1)
    let momentum = 0
    for (let z = 0; z < nz; z++) momentum += e.rho[z] * hz[z] * (model.u.slice(z * layer, (z + 1) * layer).reduce((a, b) => a + b, 0) / layer - e.u[z])
    expect(momentum / (e.rho[0] * hz[0] * 10)).toBeGreaterThan(.99)
  })

  it('puts exactly H and LE into the air column', () => {
    const config = { ...QUIET, solarMax: 1000, hour: 12, wind0: 0, wind3: 0, wind6: 0, wind10: 0 }, model = new AtmosphereModel(config)
    const { layer, zs, hz } = model.grid, e = model.env, theta0 = model.theta.slice(), q0 = model.q.slice(), f = surfaceFluxes(config, 0)
    model.step(1)
    let heat = 0, moisture = 0
    // The fluxes go into the levels below 500 m (at least the two lowest), each owning hz of the column.
    const low = Math.max(2, zs.findIndex(z => z >= 500))
    for (let z = 0; z < low; z++) for (let i = z * layer; i < (z + 1) * layer; i++) {
      const h = hz[z]
      heat += e.rho[z] * CP * e.exner[z] * (model.theta[i] - theta0[i]) * h; moisture += e.rho[z] * LV * (model.q[i] - q0[i]) * h
    }
    expect(heat / layer / f.sensible).toBeCloseTo(1, 2)
    expect(moisture / layer / f.latent).toBeCloseTo(1, 2)
  })
})
