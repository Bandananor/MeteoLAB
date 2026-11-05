import { describe, expect, it } from 'vitest'
import { AtmosphereModel, SCENARIOS, COLD_POOL, EDGE_ZONE, LINE_THERMAL, qsatP, rotationSummary, startOf, tornadoSigns, uhScale, createGrid, customGrid, DEFAULT_GRID, mesoGrid, domainGrid, DT, LARGE_GRID } from '.'
import { SUMMER_DAY } from './fixtures'
import { cleanSettings, decodeSettings, encodeSettings } from '../share'

/** Fastest of `steps` model steps after two warm-up steps, ms (the fastest is the least disturbed by the machine). */
function stepTime(model: AtmosphereModel, steps = 6) {
  let best = Infinity
  for (let k = 0; k < steps + 2; k++) {
    const t0 = performance.now(); model.step(DT); model.time += DT
    if (k >= 2) best = Math.min(best, performance.now() - t0)
  }
  return best
}

describe('large domain (96 x 72 km)', () => {
  it('costs about 4x the standard domain per step: nothing in the step grows faster than the area', { timeout: 120_000, retry: 2 }, () => {
    const standard = new AtmosphereModel({ ...SUMMER_DAY }, createGrid(DEFAULT_GRID)), large = new AtmosphereModel({ ...SUMMER_DAY }, createGrid(LARGE_GRID))
    // Three alternating rounds, the fastest step of each domain: timed once, first, before the JIT had warmed up, the
    // standard one came out slow on a cloud runner (ratio 2.3), and other test files running alongside disturb any one timing.
    let small = Infinity, big = Infinity
    for (let round = 0; round < 3; round++) { small = Math.min(small, stepTime(standard, 4)); big = Math.min(big, stepTime(large, 4)) }
    const ratio = big / small
    const area = (LARGE_GRID.nx * LARGE_GRID.ny) / (DEFAULT_GRID.nx * DEFAULT_GRID.ny)
    // 4x the columns. The old O(n^2) Fourier transform made it ~6x: the upper bound is what matters; the lower one only
    // catches a broken measurement (allow 2-5.5x for timing noise). Up to three tries: on a shared cloud runner, with
    // other test files running alongside, one try once measured 7.0 (2026-10-12; 3.98-4.07 on a quiet laptop) — a real
    // cost that grows faster than the area fails every try.
    expect(area).toBe(4)
    expect(ratio).toBeGreaterThan(2); expect(ratio).toBeLessThan(5.5)
  })
})

describe('a domain of the user\'s own size (SimConfig.domainSize)', () => {
  it('fits the size to steps of 12 x 9 km within the limits, at the standard spacing', () => {
    expect(customGrid([60, 45])).toMatchObject({ nx: 50, ny: 40, width: 60_000, depth: 45_000 })
    // Off the steps: rounded; beyond the limits: held there; nonsense: the smallest.
    expect(customGrid([50, 40])).toMatchObject({ width: 48_000, depth: 36_000 })
    expect(customGrid([1000, 1])).toMatchObject({ width: 144_000, depth: 18_000 })
    expect(customGrid([NaN, NaN])).toMatchObject({ width: 24_000, depth: 18_000 })
    expect(domainGrid('custom', undefined, [36, 27])).toMatchObject({ nx: 30, ny: 24 })
    // Without a size, 'custom' is the standard domain.
    expect(domainGrid('custom')).toEqual(DEFAULT_GRID)
  })

  it('runs on an odd-sized grid (30 x 24 columns: the pressure and the field solvers take any size)', () => {
    const config = { ...SUMMER_DAY, domain: 'custom' as const, domainSize: [36, 27] as [number, number] }, m = new AtmosphereModel(config)
    expect([m.grid.nx, m.grid.ny]).toEqual([30, 24])
    for (let k = 0; k < 20; k++) { m.step(DT); m.time += DT }
    expect(m.u.every(Number.isFinite) && m.w.every(Number.isFinite)).toBe(true)
    expect(m.diagnostics().updraft).toBeGreaterThan(.3)
  })
})

describe('the mesoscale mode (SimConfig.domain \'meso\', 2 km spacing)', () => {
  it('fits the size to steps of 24 x 18 km within the limits, at 2 km in x and y', () => {
    expect(domainGrid('meso')).toMatchObject({ nx: 96, ny: 72, nz: 50, width: 192_000, depth: 144_000 })
    expect(mesoGrid([240, 180])).toMatchObject({ nx: 120, ny: 90, width: 240_000, depth: 180_000 })
    expect(mesoGrid([200, 150])).toMatchObject({ width: 192_000, depth: 144_000 })
    expect(mesoGrid([1000, 1])).toMatchObject({ width: 288_000, depth: 72_000 })
    expect(mesoGrid([NaN, NaN])).toMatchObject({ width: 96_000, depth: 72_000 })
    // The precise run's spacing still overrides it; the setting passes through links and saved files.
    expect(domainGrid('meso', undefined, [96, 72], 1)).toMatchObject({ nx: 96, ny: 72 })
    expect(cleanSettings({ domain: 'meso', domainSize: [240, 180] })).toEqual({ domain: 'meso', domainSize: [240, 180] })
  })

  it('starts by nudging unless a front starts the storms or the thermals are asked for', () => {
    expect(startOf({ domain: 'meso' })).toBe('nudge')
    expect(startOf({ domain: 'meso', start: 'thermals' })).toBe('thermals')
    expect(startOf({ domain: 'meso', start: 'line' })).toBe('line')
    expect(startOf({ domain: 'meso', front: 3 })).toBe('thermals')
    expect(startOf({ domain: 'large' })).toBe('thermals')
    expect(startOf({})).toBe('thermals')
  })

  it('scales the UH thresholds with the grid, unchanged on 1.2 km', () => {
    expect(uhScale(1200)).toBe(1); expect(uhScale(2000)).toBeCloseTo(.6); expect(uhScale(500)).toBeCloseTo(2.4)
    expect(new AtmosphereModel({ ...SUMMER_DAY }).rotation.uhScale).toBe(1)
    expect(new AtmosphereModel({ ...SUMMER_DAY, domain: 'meso', domainSize: [96, 72] }).rotation.uhScale).toBeCloseTo(.6)
    // UH 150 on 2 km is rotation (threshold 200 x 0.6 = 120), on 1.2 km it is not; UH 0-1 km 15 a low mesocyclone (12).
    const r = { uh: 150, uh01: 15, uh03: 0, persisted: 0 }, p = { bottom: null, top: null }
    expect(rotationSummary(r, p)).toMatch(/^поток не вращается|^the updraught does not rotate/)
    expect(rotationSummary({ ...r, uhScale: .6 }, p)).toMatch(/UH 150/)
    expect(rotationSummary({ ...r, uhScale: .6 }, p)).toMatch(/UH 0–1/)
    const signs = (uhScale?: number) => tornadoSigns({ uh01: 15, uhScale, lowHeld: 600, mesoHeld: 0, stp: 0, srh01: 0, lcl: 2, cold: 0 }).level
    expect(signs()).toBe(0); expect(signs(.6)).toBe(2)
  })

  it('runs on the smallest mesoscale domain (48 x 36 columns of 2 km)', () => {
    const m = new AtmosphereModel({ ...SUMMER_DAY, domain: 'meso', domainSize: [96, 72] })
    expect([m.grid.nx, m.grid.ny, m.grid.dx, m.grid.dy]).toEqual([48, 36, 2000, 2000])
    for (let k = 0; k < 20; k++) { m.step(DT); m.time += DT }
    expect(m.u.every(Number.isFinite) && m.w.every(Number.isFinite)).toBe(true)
    expect(m.diagnostics().updraft).toBeGreaterThan(.3)
  })
})

describe('a finer horizontal grid (SimConfig.spacing, roadmap C2)', () => {
  it('keeps the domain and the levels and sets the same spacing in x and y', () => {
    expect(domainGrid('standard', undefined, undefined, .5)).toMatchObject({ nx: 96, ny: 72, nz: 50, width: 48_000, depth: 36_000 })
    expect(domainGrid('large', undefined, undefined, .25)).toMatchObject({ nx: 384, ny: 288, width: 96_000 })
    expect(domainGrid('custom', 22, [36, 27], .6)).toMatchObject({ nx: 60, ny: 45, height: 22_000 })
    expect(domainGrid('standard', undefined, undefined, undefined)).toEqual(DEFAULT_GRID)
    // Not finer than 0.25 km (a link could ask for any number), and it passes through links and saved files.
    expect(domainGrid('standard', undefined, undefined, .01)).toMatchObject({ nx: 192, ny: 144 })
    expect(cleanSettings({ spacing: .5 })).toEqual({ spacing: .5 })
  })

  it('runs at 0.6 km (80 x 60 columns)', () => {
    const m = new AtmosphereModel({ ...SUMMER_DAY, spacing: .6 })
    expect([m.grid.nx, m.grid.ny, m.grid.dx, m.grid.dy]).toEqual([80, 60, 600, 600])
    for (let k = 0; k < 10; k++) { m.step(DT); m.time += DT }
    expect(m.u.every(Number.isFinite) && m.w.every(Number.isFinite)).toBe(true)
    expect(m.diagnostics().updraft).toBeGreaterThan(.3)
  })
})

describe('the reference squall-line starts (start line-thermal and cold-pool)', () => {
  const GRID = { ...DEFAULT_GRID, nx: 20, ny: 8, nz: 20 }
  const make = (start: 'line-thermal' | 'cold-pool' | 'thermals') => new AtmosphereModel({ ...SUMMER_DAY, solarMax: 0, start }, createGrid(GRID))
  const plain = make('thermals'), level = (m: AtmosphereModel, k: number) => m.grid.zs.findIndex(z => z >= k)

  it('the line thermal: ~2 K at 1.5 km in the middle, the same along y but for the ±0.2 K noise, nothing far from it', () => {
    const m = make('line-thermal'), { nx, ny, layer, dx, width } = m.grid, z = level(m, LINE_THERMAL.zc), mid = Math.round(width / 2 / dx)
    for (let y = 0; y < ny; y++) {
      const i = mid + nx * y + layer * z
      expect(m.theta[i] - m.env.thetaEnv(m.grid.zs[z])).toBeGreaterThan(LINE_THERMAL.amplitude * .8 - LINE_THERMAL.noise)
      expect(m.theta[i] - m.env.thetaEnv(m.grid.zs[z])).toBeLessThan(LINE_THERMAL.amplitude + LINE_THERMAL.noise + .05)
      expect(m.theta[nx * y + layer * z]).toBeCloseTo(plain.theta[nx * y + layer * z], 3)
    }
    expect(m.q[mid + layer * z]).toBe(plain.q[mid + layer * z])
  })

  it('the cold pool: -6 K at the ground west of the middle, east of the relaxation zone; none east of it or above 2.5 km; the relative humidity kept', () => {
    const m = make('cold-pool'), { nx, layer, dx } = m.grid, top = level(m, COLD_POOL.depth), c = Math.ceil(EDGE_ZONE / dx) + 1
    // Open sides in x by default: periodic ones would give the pool a second front at the seam.
    expect(m.edges()).toBe('relaxed-x'); expect(make('line-thermal').edges()).toBe('periodic')
    const dth = (i: number) => m.theta[i] - plain.theta[i]
    expect(dth(c)).toBeLessThan(-COLD_POOL.deficit * .95 + COLD_POOL.noise); expect(dth(c)).toBeGreaterThan(-COLD_POOL.deficit - COLD_POOL.noise)
    expect(dth(1)).toBe(0); expect(dth(nx - 2)).toBe(0); expect(dth(c + layer * top)).toBe(0)
    const p = m.env.p[0], ex = m.env.exner[0], rh = (mm: AtmosphereModel) => mm.q[c] / qsatP(mm.theta[c] * ex - 273.15, p)
    expect(rh(m)).toBeCloseTo(rh(plain), 6); expect(m.q[c]).toBeLessThan(plain.q[c])
  })

  it('both pass the links', () => {
    for (const start of ['line-thermal', 'cold-pool'] as const) expect(cleanSettings({ start }).start).toBe(start)
  })
})

describe('the Bow echo scenario (Weisman 1993)', () => {
  const bow = SCENARIOS.find(x => x.name === 'Bow echo')!
  it('starts from one ellipsoidal 2 K thermal a third of the way in, on the mesoscale domain', () => {
    const config = { ...SUMMER_DAY, ...bow.values }, grid = createGrid(domainGrid(config.domain, config.top, config.domainSize)), model = new AtmosphereModel(config, grid)
    const { nx, ny, nz, dx, dy, zs, width, depth } = grid
    expect([width, depth]).toEqual([168_000, 162_000]); expect(model.edges()).toBe('relaxed-x'); expect(model.frame).toEqual([22.5, 0])
    let peak = 0, at = 0, warm = 0
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      const d = model.theta[i] - model.env.thetaEnv(zs[z])
      if (d > peak) { peak = d; at = i } if (d > .05) warm++
    }
    expect(peak).toBeGreaterThan(1.8); expect(peak).toBeLessThanOrEqual(2.001)
    const x = at % nx, y = Math.floor(at / nx) % ny
    expect(Math.abs(x * dx - width / 3)).toBeLessThan(2 * dx); expect(Math.abs(y * dy - depth / 2)).toBeLessThan(2 * dy)
    // Only the one thermal: nothing warm farther than its radius.
    expect(warm).toBeLessThan(Math.PI * (10_000 / dx) ** 2 * 12)
  })

  it('asks for the precise run at 1 km and survives a link', () => {
    expect(bow.precise).toEqual({ spacing: 1, minutes: 240, every: 300 })
    const names = SCENARIOS.map(x => x.name), base = { ...SUMMER_DAY, ...bow.values }
    expect(decodeSettings(encodeSettings({ ...base, bubble: .5 }, base, 'Bow echo'), names)?.scenario).toBe(names.indexOf('Bow echo'))
    expect(decodeSettings(encodeSettings({ ...SUMMER_DAY, start: 'ellipsoid' }, SUMMER_DAY, null), names)?.values.start).toBe('ellipsoid')
  })
})
