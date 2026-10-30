import { describe, expect, it } from 'vitest'
import { createGrid, Turbulence } from '.'

describe('Smagorinsky-Lilly turbulence', () => {
  const grid = createGrid({ nx: 16, ny: 12, nz: 8, width: 16 * 1200, depth: 12 * 1125, height: 7 * 652 })
  const rho = Array.from({ length: grid.nz }, (_, z) => 1.2 * Math.exp(-z * grid.dz / 8400))
  const f = (g: (x: number, y: number, z: number) => number) => Float32Array.from({ length: grid.n }, (_, i) => g(i % grid.nx, Math.floor(i / grid.nx) % grid.ny, Math.floor(i / grid.layer)))
  // A sheared jet: strong deformation in the middle of the box.
  const u = f((_x, y, z) => 10 * Math.sin(2 * Math.PI * y / grid.ny) * (z > 0 && z < grid.nz - 1 ? 1 : 0)), v = f(() => 0), w = f(() => 0)

  it('mixes where the flow deforms and the air is not too stable, never in a stable calm environment', () => {
    const t = new Turbulence(grid, rho), neutral = new Array(grid.nz).fill(300)
    t.viscosity(u, v, w, f(() => 300), neutral, .18, 1)
    expect(Math.max(...t.km)).toBeGreaterThan(50)
    const stable = Array.from({ length: grid.nz }, (_, z) => 300 + z * grid.dz * .004)
    t.viscosity(f(() => 5), v, w, f((_x, _y, z) => stable[z]), stable, .18, 1)
    expect(Math.max(...t.km)).toBe(0)
  })

  it('smooths a perturbation, conserving its mass', () => {
    const t = new Turbulence(grid, rho), neutral = new Array(grid.nz).fill(300)
    t.viscosity(u, v, w, f(() => 300), neutral, .18, 1)
    const q = f((x, y, z) => (x === 8 && y === 0 && z === 3 ? 1 : 0)), base = new Array(grid.nz).fill(0)
    const mass = (a: Float32Array) => { let m = 0; for (let i = 0; i < a.length; i++) { const z = Math.floor(i / grid.layer); m += a[i] * rho[z] * (z === 0 || z === grid.nz - 1 ? .5 : 1) } return m }
    const before = mass(q)
    for (let s = 0; s < 200; s++) t.mix(q, base, 3, 1)
    expect(Math.max(...q)).toBeLessThan(.9); expect(Math.min(...q)).toBeGreaterThanOrEqual(0)
    expect(Math.abs(mass(q) / before - 1)).toBeLessThan(1e-4)
  })

  // The stretched grid of the model's levels (100 m at the ground), where the explicit cap binds.
  const tall = createGrid({ nx: 6, ny: 5, nz: 30, width: 6 * 2000, depth: 5 * 2000, height: 15_000, bottomSpacing: 100 })
  const rhoT = Array.from({ length: tall.nz }, (_, z) => 1.2 * Math.exp(-tall.zs[z] / 8400))
  const column = () => Float32Array.from({ length: tall.n }, (_, i) => Math.floor(i / tall.layer) === 4 ? 1 : 0)
  const massT = (a: Float32Array) => { let m = 0; for (let i = 0; i < a.length; i++) { const z = Math.floor(i / tall.layer); m += a[i] * rhoT[z] * tall.hz[z] } return m }

  it('implicit vertical diffusion (experiment 30.10.2026): the explicit result for a small step, mass kept, no overshoot for a huge one', () => {
    const run = (implicit: boolean, K: number, dt: number, steps: number) => {
      const t = new Turbulence(tall, rhoT); t.anisotropic = true; t.implicitVertical = implicit
      t.km.fill(K); t.kh.fill(0)
      const q = column(); for (let s = 0; s < steps; s++) t.mix(q, null, 1, dt)
      return q
    }
    // K dt / dz^2 = 1e-4 at the ground: both schemes are accurate and agree to first order in dt.
    const a = run(false, 10, .1, 100), b = run(true, 10, .1, 100)
    let worst = 0; for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
    expect(worst).toBeLessThan(.01)
    expect(Math.abs(massT(b) / massT(column()) - 1)).toBeLessThan(1e-5)
    // K dt / dz^2 = 3 at the ground (6 over its half layer): the explicit form blows up, the implicit stays within 0..1
    // and keeps the mass.
    const blown = run(false, 1e4, 3, 20)
    expect(blown.some(v => !(Math.abs(v) <= 1))).toBe(true)
    const c = run(true, 1e4, 3, 20)
    expect(Math.max(...c)).toBeLessThanOrEqual(1); expect(Math.min(...c)).toBeGreaterThanOrEqual(0)
    expect(Math.abs(massT(c) / massT(column()) - 1)).toBeLessThan(1e-5)
  })

  it('the vertical filter width dz and the implicit vertical drop the cap: K is what the scheme asks', () => {
    const uu = Float32Array.from({ length: tall.n }, (_, i) => 0.02 * tall.zs[Math.floor(i / tall.layer)]), zero = new Float32Array(tall.n), neutral = new Array(tall.nz).fill(300), th = new Float32Array(tall.n).fill(300)
    const k = (length: 'cube' | 'dz', implicit: boolean) => { const t = new Turbulence(tall, rhoT); t.anisotropic = true; t.verticalLength = length; t.implicitVertical = implicit; t.viscosity(uu, zero, zero, th, neutral, .18, 3); return t.km[2 * tall.layer] }
    const cap = .05 * Math.min(tall.dzs[1], tall.dzs[2]) ** 2 / 3
    expect(k('cube', false)).toBeCloseTo(cap, 6)
    expect(k('cube', true)).toBeGreaterThan(1.5 * cap)
    expect(k('dz', false)).toBeLessThan(cap / 5)
    // Without the anisotropic mode km mixes the horizontal too: 'dz' must not shrink it.
    const iso = (length: 'cube' | 'dz') => { const t = new Turbulence(tall, rhoT); t.verticalLength = length; t.viscosity(uu, zero, zero, th, neutral, .18, 3); return t.kh[2 * tall.layer] }
    expect(iso('dz')).toBe(iso('cube'))
  })

  it('the implicit vertical solve: K = 0 leaves the field bit for bit, a varying K and density match a dense solve', () => {
    const t = new Turbulence(tall, rhoT); t.anisotropic = true; t.implicitVertical = true; t.kh.fill(0)
    const q = Float32Array.from({ length: tall.n }, (_, i) => Math.sin(i * .37) + 2), base = Array.from({ length: tall.nz }, (_, z) => 1 + z * .01)
    const before = q.slice(); t.km.fill(0); t.mix(q, base, 3, 3)
    expect(q.every((v, i) => Object.is(v, before[i]))).toBe(true)
    // One column against Gaussian elimination of the full matrix.
    for (let i = 0; i < tall.n; i++) t.km[i] = 50 + 400 * Math.abs(Math.sin(i))
    const { nz, layer, dzs, hz } = tall, c = 7, dt = 3, f = 3, A = Array.from({ length: nz }, () => new Float64Array(nz)), b = new Float64Array(nz)
    for (let z = 0; z < nz; z++) { A[z][z] = 1; b[z] = q[c + z * layer] - base[z] }
    for (let z = 0; z < nz - 1; z++) { const face = dt * f * (rhoT[z] + rhoT[z + 1]) / 2 * (t.km[c + z * layer] + t.km[c + (z + 1) * layer]) / 2 / dzs[z]; A[z][z] += face / (rhoT[z] * hz[z]); A[z][z + 1] -= face / (rhoT[z] * hz[z]); A[z + 1][z + 1] += face / (rhoT[z + 1] * hz[z + 1]); A[z + 1][z] -= face / (rhoT[z + 1] * hz[z + 1]) }
    for (let p = 0; p < nz; p++) for (let r = p + 1; r < nz; r++) { const m = A[r][p] / A[p][p]; for (let k = p; k < nz; k++) A[r][k] -= m * A[p][k]; b[r] -= m * b[p] }
    const x = new Float64Array(nz); for (let r = nz - 1; r >= 0; r--) { let s = b[r]; for (let k = r + 1; k < nz; k++) s -= A[r][k] * x[k]; x[r] = s / A[r][r] }
    t.mix(q, base, f, dt)
    for (let z = 0; z < nz; z++) expect(q[c + z * layer]).toBeCloseTo(x[z] + base[z], 5)
  })
})
