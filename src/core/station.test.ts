import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, DEFAULT_GRID, domainPoint, DT, groundPoint, hydrostaticPressure, Station, STATION_RECORD, surfacePressure } from '.'
import { SUMMER_DAY } from './fixtures'

const smallGrid = () => createGrid({ ...DEFAULT_GRID, nx: 16, ny: 12, width: 16 * 1200, depth: 12 * 1125 })

describe('virtual weather station', () => {
  it('stays on the ground while the domain moves over it', () => {
    const m = { grid: smallGrid(), frame: [8, -3] as const, time: 900 }, g = groundPoint(m, 5000, 7000), d = domainPoint(m, g.x, g.y)
    expect(d.x).toBeCloseTo(5000, 6); expect(d.y).toBeCloseTo(7000, 6)
    // After 900 s at 8 m/s east the ground point that was under x = 5000 is 7.2 km further east in ground coordinates.
    expect(g.x).toBeCloseTo(5000 + 7200, 6)
  })

  it('reads the starting environment, then a cold pool as colder air, higher pressure and the gust', () => {
    const model = new AtmosphereModel({ ...SUMMER_DAY, bubble: 0, followStorm: false }, smallGrid()), { layer, nx, dx, dy, zs } = model.grid
    const station = new Station(4.5 * dx, 5.5 * dy)
    station.observe(model)
    const first = station.records[0]
    expect(first.temp).toBeCloseTo(SUMMER_DAY.surfaceTemp, 0)
    expect(first.dew).toBeLessThan(first.temp)
    expect(first.pressure).toBeCloseTo(model.env.p[0] / 100, 1)
    // A cold pool 6 K colder below 1 km under the station (columns x 2-7, y 3-8) and an 18 m/s outflow at the ground.
    const deep = zs.findIndex(z => z > 1000)
    for (let y = 3; y <= 8; y++) for (let x = 2; x <= 7; x++) { for (let k = 0; k < deep; k++) model.theta[x + y * nx + k * layer] -= 6; model.u[x + y * nx] = 18 }
    model.time = STATION_RECORD; station.observe(model)
    const after = station.records[1]
    expect(first.temp - after.temp).toBeGreaterThan(5)
    expect(after.pressure - first.pressure).toBeGreaterThan(1.5)
    expect(after.gust).toBeGreaterThan(17)
    expect(Math.abs(after.dir - 270)).toBeLessThan(20)
  })

  it('takes the rain rate from the growth of the ground total', () => {
    const model = new AtmosphereModel({ ...SUMMER_DAY, bubble: 0, followStorm: false }, smallGrid()), { nx, dx, dy } = model.grid
    const station = new Station(3 * dx, 2 * dy)
    station.observe(model)
    model.precipitation[3 + 2 * nx] = 5; model.time = 600; station.observe(model)
    expect(station.records[1].rainTotal).toBe(5)
    expect(station.records[1].rainRate).toBeCloseTo(30, 6)
  })

  it('has no net pressure perturbation over the domain', () => {
    const model = new AtmosphereModel({ ...SUMMER_DAY, bubble: 1 }, smallGrid())
    expect(Math.abs(surfacePressure(model).reduce((a, b) => a + b, 0))).toBeLessThan(1e-6)
  })
})

describe('the pressure at the ground (2.6.1)', () => {
  it('is the model\u2019s own once it has stepped: under a wide shallow cold pool close to the hydrostatic one', () => {
    const g = createGrid({ ...DEFAULT_GRID, nx: 40, ny: 32 }), m = new AtmosphereModel({ ...SUMMER_DAY, followStorm: false, bubble: 0, solarMax: 0 }, g), { nx, layer, zs, dx, dy } = g
    for (let z = 0; zs[z] < 1000; z++) for (let c = 0; c < layer; c++) if (Math.hypot((c % nx) * dx - 24_000, Math.floor(c / nx) * dy - 18_000) < 8000) m.theta[c + z * layer] -= 5
    const centre = Math.round(24_000 / dx) + nx * Math.round(18_000 / dy)
    // Before a step the model has no pressure yet: the hydrostatic estimate stands in.
    expect(surfacePressure(m)[centre]).toBe(hydrostaticPressure(m)[centre])
    for (let k = 0; k < 2; k++) { m.step(DT); m.time += DT }
    const own = surfacePressure(m)[centre], hydro = hydrostaticPressure(m)[centre]
    expect(own).not.toBe(hydro); expect(own).toBeGreaterThan(.75 * hydro); expect(own).toBeLessThan(1.05 * hydro)
    expect(Math.abs(surfacePressure(m).reduce((a, b) => a + b, 0))).toBeLessThan(1e-6)
  })
})
