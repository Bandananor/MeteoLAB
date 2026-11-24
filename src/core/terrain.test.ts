import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, DT, MaskedProjection, nodeHeights, solidMask, terrainHeights } from '.'
import { PressureSolver } from './pressure'
import { Turbulence } from './turbulence'
import { QUIET } from './fixtures'

const grid = createGrid({ nx: 32, ny: 24, nz: 30, width: 38_400, depth: 28_800, height: 15_000, bottomSpacing: 100 })

describe('terrain (terrain.ts, 3.0 block Д step 1)', () => {
  it('builds a hill, a ridge and a plateau of the asked height, smooth and periodic', () => {
    const hill = terrainHeights({ kind: 'hill', height: 1, width: 5 }, grid), { nx, ny } = grid
    const top = Math.max(...hill)
    expect(top).toBeGreaterThan(800); expect(top).toBeLessThanOrEqual(1000)
    expect(hill[0]).toBeLessThan(.15 * top)
    const ridge = terrainHeights({ kind: 'ridge', height: .8, width: 4 }, grid)
    // A north-south ridge: the same height along a column of x.
    for (let j = 1; j < ny; j++) expect(ridge[nx / 2 + nx * j]).toBeCloseTo(ridge[nx / 2], 3)
    const plateau = terrainHeights({ kind: 'plateau', height: .5, width: 8 }, grid)
    expect(plateau[nx / 2 + nx * ny / 2]).toBeGreaterThan(450); expect(plateau[0]).toBeLessThan(50)
  })

  it('projects a uniform wind over a hill: divergence-free over the fluid, zero in the ground, up the windward slope', () => {
    const rho = Float64Array.from({ length: grid.nz }, (_, z) => 1.2 * Math.exp(-grid.zs[z] / 9000))
    const solver = new PressureSolver(grid, rho), h = terrainHeights({ kind: 'hill', height: 1, width: 5 }, grid), solid = solidMask(grid, h)
    const masked = new MaskedProjection(grid, solver, h), { n, nx, ny, layer } = grid
    const u = new Float32Array(n).fill(10), v = new Float32Array(n), w = new Float32Array(n), p = new Float64Array(solver.cells)
    const before = new Float64Array(solver.cells), after = new Float64Array(solver.cells)
    masked.mask(u, v, w); masked.divergence(u, v, w, before)
    masked.project(u, v, w, DT, p)
    masked.divergence(u, v, w, after)
    const norm = (a: Float64Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0))
    expect(masked.iterations).toBeGreaterThan(0); expect(masked.iterations).toBeLessThan(200)
    expect(norm(after) / norm(before)).toBeLessThan(1e-5)
    for (let i = 0; i < n; i++) if (solid[i]) { expect(u[i]).toBe(0); expect(w[i]).toBe(0) }
    // The ground node (a wall node: w = 0, as level 0) keeps the air on the slope; the node above it a hill's half-width
    // upwind rises, downwind sinks (westerly flow).
    const cy = ny / 2, ground = (x: number) => { let z = 0; while (solid[x + nx * cy + z * layer]) z++; return x + nx * cy + z * layer }, first = (x: number) => ground(x) + layer
    // w is zero at a ground node on or under the ground (a cut cell's node below the ground height).
    for (let x = 0; x < nx; x++) { const k = ground(x); if (grid.zs[Math.floor(k / layer)] <= h[x + nx * cy]) expect(w[k]).toBe(0) }
    const up = first(nx / 2 - 4), down = first(nx / 2 + 3)
    expect(w[up]).toBeGreaterThan(.5); expect(w[down]).toBeLessThan(-.5)
  })

  it('adds no motion to a resting atmosphere: the hill stirs it no more than the flat ground does', () => {
    // The model's own small starting perturbations stir a calm atmosphere to ~0.05 m/s in 5 min with or without terrain.
    const calm = { wind0: 0, wind05: 0, wind1: 0, wind3: 0, wind6: 0, wind10: 0, followStorm: false }
    const strongest = (terrain?: { kind: 'hill'; height: number; width: number }) => {
      const m = new AtmosphereModel({ ...QUIET, ...calm, solarMax: 0, bubble: 0, ...(terrain ? { terrain } : {}) }, grid)
      for (let t = 0; t < 5 * 60; t += DT) { m.step(DT); m.time += DT }
      let w = 0
      for (let i = 0; i < grid.n; i++) w = Math.max(w, Math.abs(m.w[i]))
      return w
    }
    const flat = strongest(), hill = strongest({ kind: 'hill', height: 1, width: 5 })
    expect(flat).toBeLessThan(.1); expect(hill).toBeLessThan(1.3 * flat + 1e-3)
  }, 120_000)

  it('carries water over a hill without losing or making any (the transport faces into the ground are closed)', () => {
    const m = new AtmosphereModel({ ...QUIET, wind3: 12, wind6: 15, followStorm: false, bubble: 1.5, terrain: { kind: 'hill', height: 1, width: 5 } }, grid)
    const total = () => {
      let s = 0
      for (let z = 0; z < grid.nz; z++) for (let c = 0; c < grid.layer; c++) { const i = c + z * grid.layer; s += (m.q[i] + m.cloud[i] + m.ice[i] + m.rain[i] + m.snow[i] + m.graupel[i] + m.hail[i]) * m.env.rho[z] * grid.hz[z] * m.volumeShare![i] }
      return s
    }
    const before = total()
    for (let k = 0; k < 60; k++) { m.step(DT); m.time += DT }
    expect(Math.abs(total() - before) / before).toBeLessThan(1e-7)
  }, 120_000)

  it('drops the rain on the slope: into the rain gauge of the column under it, nothing into the ground, no water lost', () => {
    const m = new AtmosphereModel({ ...QUIET, followStorm: false, bubble: 0, terrain: { kind: 'plateau', height: .5, width: 8 } }, grid)
    const { nx, ny, layer, hz } = grid, c = nx / 2 + nx * (ny / 2), g = m.groundLevel![c], rho = m.env.rho
    expect(g).toBeGreaterThan(2)
    for (let z = g + 3; z < g + 10; z++) m.rain[c + z * layer] = 2e-3
    let mass = 0
    const vs = m.volumeShare!
    for (let z = 0; z < grid.nz; z++) mass += m.rain[c + z * layer] * rho[z] * hz[z] * vs[c + z * layer]
    for (let k = 0; k < 400; k++) m.beginStep(DT)
    let left = 0
    for (let z = 0; z < grid.nz; z++) left += m.rain[c + z * layer] * rho[z] * hz[z] * vs[c + z * layer]
    for (let z = 0; z < g; z++) expect(m.rain[c + z * layer]).toBe(0)
    // Nearly all of it reached the gauge of that one column (no frame motion over terrain), as mm = kg/m2, and what
    // is still falling (the slow tail of the thinning rain) makes up the rest.
    expect(left).toBeLessThan(.01 * mass)
    expect(Math.abs(m.precipitation[c] + left - mass) / mass).toBeLessThan(1e-6)
    expect(Math.abs(m.precipitation.reduce((s, x) => s + x, 0) - m.precipitation[c])).toBe(0)
  })

  it('heats the air above the slope, not the ground: solid nodes keep their values, the air gets the flat ground\'s heat', () => {
    const sunny = { ...QUIET, solarMax: 1000, wind0: 0, wind05: 0, wind1: 0, wind3: 0, wind6: 0, wind10: 0, followStorm: false, bubble: 0 }
    const { nx, ny, nz, layer, n, hz } = grid, c = nx / 2 + nx * (ny / 2)
    // The heat the air gained, J/m2: rho cp pi h dtheta over the fluid nodes.
    const heated = (terrain?: { kind: 'plateau'; height: number; width: number }) => {
      const m = new AtmosphereModel({ ...sunny, ...(terrain ? { terrain } : {}) }, grid), theta = Float32Array.from(m.theta), q = Float32Array.from(m.q)
      for (let k = 0; k < 100; k++) { m.step(DT); m.time += DT }
      let heat = 0
      for (let z = 0; z < nz; z++) for (let b = 0; b < layer; b++) { const i = b + z * layer; heat += m.env.rho[z] * hz[z] * (m.volumeShare?.[i] ?? 1) * 1004 * m.env.exner[z] * (m.theta[i] - theta[i]) }
      return { m, theta, q, heat }
    }
    const flat = heated(), { m, theta, q, heat } = heated({ kind: 'plateau', height: .5, width: 8 }), g = m.groundLevel![c], solid = m.solid!
    for (let i = 0; i < n; i++) if (solid[i]) { expect(m.theta[i]).toBe(theta[i]); expect(m.q[i]).toBe(q[i]) }
    expect(m.theta[c + g * layer] - theta[c + g * layer]).toBeGreaterThan(.05)
    // The same sunshine heats the air by the same amount over the plateau as over the flat ground (0.02 % on 24.11).
    expect(Math.abs(heat / flat.heat - 1)).toBeLessThan(2e-3)
    // The plateau's ground node is a wall node, as the flat ground's level 0: it warms as much (it warmed 17 % less
    // while it owned a full layer, before the wall node).
    const plateauTop = m.theta[c + g * layer] - theta[c + g * layer], flatGround = flat.m.theta[c] - flat.theta[c]
    expect(Math.abs(plateauTop / flatGround - 1)).toBeLessThan(.06)
    expect(m.w[c + g * layer]).toBe(0)
  }, 120_000)

  it('carries a uniform warming along the slope unchanged: the stencils read ghost values in the ground, not a jump', () => {
    // Two runs of a stable westerly over a hill, one 1 K warmer at every fluid node: their difference is the transport of
    // a uniform 1 K. With the solid nodes' own values in the stencils it lost up to 0.14 K at the slope in 2 min.
    const wind = { wind0: 10, wind05: 10, wind1: 10, wind3: 10, wind6: 10, wind10: 10 }
    const model = (warm: number) => {
      const m = new AtmosphereModel({ ...QUIET, ...wind, followStorm: false, bubble: 0, terrain: { kind: 'hill', height: 1, width: 5 } }, grid)
      for (let i = 0; i < grid.n; i++) if (!m.solid![i]) m.theta[i] += warm
      return m
    }
    const a = model(0), b = model(1)
    for (let k = 0; k < 20; k++) { a.step(DT); a.time += DT; b.step(DT); b.time += DT }
    let worst = 0
    for (let i = 0; i < grid.n - 3 * grid.layer; i++) if (!a.solid![i]) worst = Math.max(worst, Math.abs(b.theta[i] - a.theta[i] - 1))
    expect(worst).toBeLessThan(1e-3)
    // The ground keeps its own values after the transport.
    for (let i = 0; i < grid.n; i++) if (a.solid![i]) { expect(a.u[i]).toBe(0); expect(a.rain[i]).toBe(0) }
  }, 120_000)

  it('reads the ground as the profile continued: a cold pool along the slope gets the tendency of its own extension', () => {
    // One transport tendency of theta = environment + a cold pool by height (-3 K at the sea-level ground, 0 at 800 m)
    // over a hill after a minute of westerly; the reference continues the same field into the ground. The model's ghosts
    // (the wall node's departure on each level's environment) against the wall node's value repeated, and against the
    // solid nodes' own values (the transport before the ghosts). Private members through a cast: the transport itself.
    const wind = { wind0: 10, wind05: 10, wind1: 10, wind3: 10, wind6: 10, wind10: 10 }
    const m = new AtmosphereModel({ ...QUIET, ...wind, followStorm: false, bubble: 0, terrain: { kind: 'hill', height: 1, width: 5 } }, grid)
    for (let k = 0; k < 10; k++) { m.step(DT); m.time += DT }
    const inner = m as unknown as { flux: { setVelocityMasked(u: Float32Array, v: Float32Array, w: Float32Array): void; tendency(q: Float32Array, t: Float64Array, z0: number, z1: number, monotone: boolean): void }; fillGround(f: Float32Array[], save: boolean): void }
    inner.flux.setVelocityMasked(m.u, m.v, m.w)
    const { n, nz, layer, zs } = grid, solid = m.solid!, ground = m.groundLevel!, env = m.env.theta, pool = (z: number) => -3 * Math.max(0, 1 - z / 800)
    const field = (ghost: (i: number, c: number, z: number) => number) => Float32Array.from({ length: n }, (_, i) => { const z = Math.floor(i / layer), c = i % layer; return solid[i] ? ghost(i, c, z) : env[z] + pool(zs[z]) })
    const tendency = (a: Float32Array) => { const t = new Float64Array(n); inner.flux.tendency(a, t, 0, nz, false); return t }
    const own = Float32Array.from(m.theta), reference = tendency(field((_, __, z) => env[z] + pool(zs[z])))
    const error = (a: Float32Array) => { const t = tendency(a); let e = 0; for (let i = 0; i < n - 3 * layer; i++) if (!solid[i]) e = Math.max(e, Math.abs(t[i] - reference[i])); return e }
    const ghosts = field(() => 0)
    m.theta.set(ghosts); inner.fillGround([m.theta], false); ghosts.set(m.theta)
    const model = error(ghosts), repeated = error(field((_, c) => env[ground[c]] + pool(zs[ground[c]]))), before = error(field(i => own[i]))
    expect(model).toBeLessThan(.6 * repeated)
    expect(model).toBeLessThan(.3 * before)
  }, 120_000)

  it('mixes an unstable layer over the slope: the solid node under it is a wall, not a cold neighbour', () => {
    const h = terrainHeights({ kind: 'plateau', height: .5, width: 8 }, grid), solid = solidMask(grid, h), { n, nz, layer, nx, ny, zs } = grid
    const turbulence = new Turbulence(grid, Array.from({ length: nz }, () => 1.1)), c = nx / 2 + nx * (ny / 2)
    turbulence.setTerrain(solid, nodeHeights(grid, solid))
    let g = 0
    while (solid[c + g * layer]) g++
    // Heated air over the ground: 2 K/km superadiabatic above every column's ground node; the solid nodes keep the cold
    // environment (300 K + 6 K/km), so a difference through them sees a stable jump.
    const theta = new Float32Array(n), env = Float64Array.from(zs, z => 300 + .006 * z)
    for (let b = 0; b < layer; b++) {
      let base = 0
      while (solid[b + base * layer]) base++
      for (let z = 0; z < nz; z++) theta[b + z * layer] = z < base ? env[z] : 303 - .002 * (zs[z] - zs[base])
    }
    turbulence.viscosity(new Float32Array(n), new Float32Array(n), new Float32Array(n), theta, env, .18, DT)
    expect(turbulence.km[c + g * layer]).toBeGreaterThan(0)
    expect(turbulence.km[c + (g - 1) * layer]).toBe(0)
  })

  it('takes a 1 m plateau for the flat ground: the cut cells change the flow by a 1 m sliver, not a level', () => {
    // A storm's first minutes over flat ground and over a plateau 1 m high (a hundredth of the lowest layer): with cut
    // cells the plateau shaves 1 m off level 0's half layer; with a staircase it would be flat ground or a 100 m step.
    const run = (terrain?: { kind: 'plateau'; height: number; width: number }) => {
      const m = new AtmosphereModel({ ...QUIET, followStorm: false, bubble: 1.5, ...(terrain ? { terrain } : {}) }, grid)
      for (let t = 0; t < 3 * 60; t += DT) { m.step(DT); m.time += DT }
      return m
    }
    const flat = run(), low = run({ kind: 'plateau', height: .001, width: 8 })
    expect(low.solid!.some(s => s === 1)).toBe(false)
    let top = 0, diff = 0
    for (let i = 0; i < grid.n; i++) { top = Math.max(top, Math.abs(flat.w[i])); diff = Math.max(diff, Math.abs(low.w[i] - flat.w[i])) }
    expect(top).toBeGreaterThan(1)
    expect(diff / top).toBeLessThan(.02)
  }, 120_000)
})
