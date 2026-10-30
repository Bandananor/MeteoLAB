import { describe, expect, it } from 'vitest'
import { Environment } from './environment'
import { QUIET } from './fixtures'
import { createGrid, DEFAULT_GRID } from './grid'
import { channelShape, flashLimit, Lightning } from './lightning'
import { environmentProfile } from './profiles'

const grid = createGrid(DEFAULT_GRID), air = new Environment(QUIET, grid, environmentProfile(QUIET, grid.height)).rho

/**
 * Charge carriers (ice, graupel, rain, air; C/kg) holding Gaussian charge regions over the domain centre: [height, m;
 * peak density, nC/m³] each, 2.5 km wide and 0.7 km deep — positive charge on the ice, negative on the graupel.
 */
function storm(regions: [number, number][]) {
  const { nx, ny, nz, layer, zs, dx, dy } = grid, carriers = [0, 1, 2, 3].map(() => new Float32Array(grid.n))
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + y * nx + z * layer, r2 = ((x - nx / 2) * dx) ** 2 + ((y - ny / 2) * dy) ** 2
    for (const [h, peak] of regions) carriers[peak > 0 ? 0 : 1][i] += peak * 1e-9 * Math.exp(-r2 / 2500 ** 2 - ((zs[z] - h) / 700) ** 2) / air[z]
  }
  return carriers
}

/** Charge in the domain, C. */
function total(carriers: Float32Array[]) {
  let s = 0
  for (let z = 0; z < grid.nz; z++) for (let i = z * grid.layer; i < (z + 1) * grid.layer; i++) for (const c of carriers) s += c[i] * air[z] * grid.dx * grid.dy * grid.hz[z]
  return s
}

describe('lightning (2.3 step 3)', () => {
  it('a normal tripole discharges inside the cloud: a neutral IC flash between the main charges, no carrier changes sign, the field falls below the threshold', () => {
    const carriers = storm([[10000, 2], [6500, -3.5], [3500, 1]]), before = carriers.map(c => c.slice()), start = total(carriers)
    const lightning = new Lightning(grid, air, 7)
    lightning.solve(carriers)
    expect(lightning.strongest()[1]).toBeGreaterThan(1)
    const flashes = lightning.discharge(carriers, 0)
    expect(flashes.length).toBeGreaterThan(0)
    const [first] = flashes, height = grid.zs[Math.floor(first.start / grid.layer)]
    expect(first.kind).toBe('IC')
    // Started between the main negative and the upper positive charge; positive leaders in the one, negative in the other.
    expect(height).toBeGreaterThan(6500); expect(height).toBeLessThan(10000)
    expect(first.polarity.some(p => p > 0) && first.polarity.some(p => p < 0)).toBe(true)
    // A flash neutralizes some tens of coulombs (Mansell et al. 2010: 6-16 C of each sign in a smaller storm).
    expect(first.charge).toBeGreaterThan(3); expect(first.charge).toBeLessThan(100)
    expect(Math.abs(total(carriers) - start)).toBeLessThan(1e-6 * first.charge)
    for (let k = 0; k < 4; k++) for (let i = 0; i < grid.n; i++) expect(carriers[k][i] * before[k][i]).toBeGreaterThanOrEqual(0)
    lightning.solve(carriers)
    expect(lightning.strongest()[1]).toBeLessThan(1)
  })

  it('without the lower positive charge the main negative charge goes to the ground: a negative CG, the ground supplies the balance', () => {
    const carriers = storm([[9000, 3], [6500, -3]]), start = total(carriers), lightning = new Lightning(grid, air, 7)
    const flashes = lightning.discharge(carriers, 0), [first] = flashes
    expect(first.kind).toBe('CG')
    expect(first.charge).toBeLessThan(0)
    expect(first.ground).toBeGreaterThanOrEqual(0); expect(first.ground).toBeLessThan(grid.layer)
    // The channel is connected: every node grew from one before it, the first from none.
    expect(first.parent[0]).toBe(-1); expect(first.polarity.length).toBe(first.nodes.length)
    for (let c = 1; c < first.nodes.length; c++) expect(first.parent[c]).toBeGreaterThanOrEqual(0), expect(first.parent[c]).toBeLessThan(c)
    // What the cloud gained came from the ground (the CG flashes' charges, opposite).
    const lowered = flashes.reduce((s, f) => s + (f.kind === 'CG' ? f.charge : 0), 0)
    expect(lightning.fromGround).toBeCloseTo(-lowered, 6)
    expect(Math.abs(total(carriers) - start - lightning.fromGround)).toBeLessThan(1e-6 * Math.abs(first.charge))
  })

  it('the drawn channel: every node shifted within its cell, the same shape every time', () => {
    const [flash] = new Lightning(grid, air, 7).discharge(storm([[10000, 2], [6500, -3.5], [3500, 1]]), 0), shape = channelShape(grid, flash)
    expect(Array.from(channelShape(grid, flash))).toEqual(Array.from(shape))
    flash.nodes.forEach((i, c) => {
      const z = Math.floor(i / grid.layer), y = Math.floor((i - z * grid.layer) / grid.nx), x = i - z * grid.layer - y * grid.nx
      expect(Math.abs(shape[c * 3] - x * grid.dx)).toBeLessThanOrEqual(.35 * grid.dx)
      expect(Math.abs(shape[c * 3 + 1] - y * grid.dy)).toBeLessThanOrEqual(.35 * grid.dy)
      expect(Math.abs(shape[c * 3 + 2] - grid.zs[z])).toBeLessThanOrEqual(.35 * grid.dzs[Math.min(z, grid.nz - 2)])
    })
  })

  it('below the breakdown threshold nothing happens', () => {
    const carriers = storm([[9000, .5], [6500, -.5]]), before = carriers.map(c => c.slice()), lightning = new Lightning(grid, air, 7)
    expect(lightning.discharge(carriers, 0)).toEqual([])
    expect(carriers).toEqual(before)
  })

  it('discharges at most flashLimit(dt) times a step: 10 per 3 s of model time, whatever the step', () => {
    expect([flashLimit(3), flashLimit(6), flashLimit(1.5), flashLimit(.75), flashLimit(.1)]).toEqual([10, 20, 5, 3, 1])
    const strong = () => storm([[10000, 8], [6500, -14], [3500, 4]])
    const unlimited = new Lightning(grid, air, 7).discharge(strong(), 0, 50).length
    expect(unlimited).toBeGreaterThan(2)
    expect(new Lightning(grid, air, 7).discharge(strong(), 0, 2)).toHaveLength(2)
  })
})

describe('conduction and corona (2.7)', () => {
  const { nx, ny, nz, layer, zs, dx, dy } = grid
  const net = (carriers: Float32Array[], i: number) => carriers.reduce((s, c) => s + c[i], 0)
  const centre = (z: number) => nx / 2 + ny / 2 * nx + z * layer
  const level = (m: number) => zs.findIndex(h => h >= m)

  it('relaxes charge in clear air on ε0/σ and conserves it with what leaves for the ground and the top', () => {
    const carriers = storm([[10000, 1]]), start = total(carriers), lightning = new Lightning(grid, air, 7), z = level(10000)
    const before = net(carriers, centre(z))
    lightning.solve(carriers)
    const lost = lightning.conduct(carriers[3], 10)
    // σ(10 km) = 2e-14 e^(10/6) ≈ 1.06e-13 S/m: ~12% in 10 s at the peak (a little less: the field there is not all its own).
    const relaxed = 1 - net(carriers, centre(z)) / before
    expect(relaxed).toBeGreaterThan(.05); expect(relaxed).toBeLessThan(.15)
    expect(lost).toBe(lightning.conducted)
    expect(Math.abs(total(carriers) - start + lost)).toBeLessThan(1e-9 * Math.abs(start))
  })

  it('a charged cloud gets a screening layer of the opposite sign at its edge; inside it relaxes ten times slower', () => {
    const carriers = storm([[10000, 1]]), lightning = new Lightning(grid, air, 7), cloudy = new Float32Array(grid.n)
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++)
      if (Math.hypot((x - nx / 2) * dx, (y - ny / 2) * dy) < 4000 && Math.abs(zs[z] - 10000) < 1500) cloudy[x + y * nx + z * layer] = 1e-3
    const z = level(10000), before = net(carriers, centre(z))
    lightning.cloud([cloudy])
    for (let k = 0; k < 60; k++) { lightning.solve(carriers); lightning.conduct(carriers[3], 10) }
    // Ten minutes: in clear air the peak would be nearly gone (~e^-6); inside the cloud ~half of it is left.
    expect(net(carriers, centre(z)) / before).toBeGreaterThan(.3)
    // Just outside the cloud's top and side the ions have brought negative charge.
    const top = level(11500 + 200), side = Math.round(4000 / dx) + 1
    expect(net(carriers, centre(top))).toBeLessThan(0)
    expect(net(carriers, nx / 2 + side + ny / 2 * nx + z * layer)).toBeLessThan(0)
  })

  it('under a negative charge the ground gives positive corona once its field exceeds 5 kV/m', () => {
    const carriers = storm([[5000, -4]]), start = total(carriers), lightning = new Lightning(grid, air, 7)
    lightning.solve(carriers)
    const field = -lightning.phi[centre(1)] / grid.dzs[0]
    expect(field).toBeGreaterThan(5e3)
    const lost = lightning.conduct(carriers[3], 10)
    expect(net(carriers, centre(1))).toBeGreaterThan(0)
    expect(Math.abs(total(carriers) - start + lost)).toBeLessThan(1e-9 * Math.abs(start))
    // Weak charge: no corona, the lowest level under it only gets the (positive) conduction current from the ground.
    const weak = storm([[5000, -.01]]), quiet = new Lightning(grid, air, 7)
    quiet.solve(weak)
    expect(Math.abs(quiet.phi[centre(1)] / grid.dzs[0])).toBeLessThan(5e3)
    // Over the sea: none, the lowest level only gets the conduction current (much smaller).
    const sea = storm([[5000, -4]]), wet = new Lightning(grid, air, 7)
    wet.corona = false; wet.solve(sea); wet.conduct(sea[3], 10)
    expect(net(sea, centre(1))).toBeLessThan(.1 * net(carriers, centre(1)))
  })
})
