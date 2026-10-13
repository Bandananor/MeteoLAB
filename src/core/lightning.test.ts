import { describe, expect, it } from 'vitest'
import { Environment } from './environment'
import { QUIET } from './fixtures'
import { createGrid, DEFAULT_GRID } from './grid'
import { channelShape, Lightning } from './lightning'
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
    expect(first.parent[0]).toBe(-1)
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
})
