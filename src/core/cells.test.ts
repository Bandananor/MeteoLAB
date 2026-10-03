import { describe, expect, it } from 'vitest'
import { AtmosphereModel, CELL_CONFIRM, type CellStats, cellStage, CellTracker, createGrid, OCCLUSION_COLD, UH_MESOCYCLONE } from '.'
import { QUIET } from './fixtures'

const small = () => new AtmosphereModel({ ...QUIET }, createGrid({ nx: 16, ny: 12, nz: 20, width: 19_200, depth: 13_500, height: 15_000, bottomSpacing: 100 }))

/** Clears the fields, then puts cloudy updraught cores (w at 2-8 km) on the given columns. */
function cores(m: AtmosphereModel, list: { x: number; y: number; w: number; r?: number; uh?: number }[]) {
  const { nx, ny, nz, layer, zs } = m.grid
  m.w.fill(0); m.cloud.fill(0); m.uhColumn.fill(0)
  for (const c of list) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (Math.hypot(x - c.x, y - c.y) > (c.r ?? 1.5)) continue
    for (let z = 0; z < nz; z++) if (zs[z] > 2000 && zs[z] < 8000) { m.w[x + nx * y + z * layer] = c.w; m.cloud[x + nx * y + z * layer] = 1e-3 }
    m.uhColumn[x + nx * y] = c.uh ?? 0
  }
}

const stats = (s: Partial<CellStats>): CellStats => ({ updraft: 20, downdraft: 5, uh: 0, anticyclonic: 0, uh01: 0, uh03: 0, cloudTop: 10, rainRate: 0, coldPool: 0, coldUnder: 0, area: 10, ...s })

describe('cell tracking', () => {
  it('keeps the number of a moving cell and measures its motion', () => {
    const m = small(), t = new CellTracker()
    for (let s = 0; s <= 300; s += 12) { m.time = s; cores(m, [{ x: 4 + s / 60, y: 6, w: 15 }]); t.update(m) }
    expect(t.cells.map(c => c.id)).toEqual([1])
    // One column (1.2 km) a minute: 20 m/s eastward.
    expect(t.cells[0].u).toBeCloseTo(20, 0); expect(Math.abs(t.cells[0].v)).toBeLessThan(1)
  })

  it('gives no number to a fragment that splits off and merges back within CELL_CONFIRM', () => {
    const m = small(), t = new CellTracker()
    for (let s = 0; s <= 400; s += 12) {
      m.time = s
      cores(m, [{ x: 6, y: 6, w: 20 }, ...(s > 200 && s < 200 + CELL_CONFIRM - 30 ? [{ x: 10, y: 6, w: 8, r: .5 }] : [])])
      t.update(m)
    }
    expect(t.cells.map(c => c.id)).toEqual([1])
  })

  it('lets the rotating part of a split keep the number (the right mover stays the same cell)', () => {
    const m = small(), t = new CellTracker()
    for (let s = 0; s <= 600; s += 12) {
      m.time = s
      // One core until 3 min, then two that drift apart; the southern one (smaller y) rotates cyclonically.
      const d = Math.max(0, s - 180) / 120
      cores(m, s < 180 ? [{ x: 8, y: 6, w: 20, r: 2.5 }] : [{ x: 8, y: 6 - d, w: 20, uh: UH_MESOCYCLONE + 100 }, { x: 8, y: 6.5 + d, w: 15, r: 1 }])
      t.update(m)
    }
    const [right, left] = t.cells
    expect(right.id).toBe(1); expect(right.y).toBeLessThan(left.y)
    expect(left.id).toBe(2); expect(left.parent).toBe(1); expect(left.origin).toBe('split')
  })

  it('reports a merger, and the older cell keeps its number', () => {
    const m = small(), t = new CellTracker()
    let merged = false
    for (let s = 0; s <= 600; s += 12) {
      m.time = s
      // Two cells 7 columns apart close in after 4 min and become one core.
      const gap = Math.max(0, 3.5 - Math.max(0, s - 240) / 40)
      cores(m, s < 60 ? [{ x: 4.5, y: 6, w: 20 }] : [{ x: 8 - gap, y: 6, w: 20 }, { x: 8 + gap, y: 6, w: 15 }])
      t.update(m)
      if (t.ended.length) { expect(t.ended).toEqual([{ id: 2, into: 1 }]); merged = true }
    }
    expect(merged).toBe(true); expect(t.cells.map(c => c.id)).toEqual([1])
  })
})

describe('cell stages', () => {
  const ordinary = { supercell: false, leftMover: false, occluded: false, peakW: 25, peakUH: 0, age: 900 }
  it('follows an ordinary cell from cumulus to decay', () => {
    expect(cellStage(ordinary, stats({}))).toBe('growing')
    expect(cellStage(ordinary, stats({ rainRate: 20 }))).toBe('mature')
    expect(cellStage(ordinary, stats({ updraft: 8, rainRate: 20 }))).toBe('dissipating')
    expect(cellStage(ordinary, stats({ updraft: 10, downdraft: 14, rainRate: 20 }))).toBe('dissipating')
    expect(cellStage(ordinary, stats({ uh: 300 }))).toBe('rotating')
    // Rotation of both signs (a vortex pair) is not a developing mesocyclone.
    expect(cellStage(ordinary, stats({ uh: 300, anticyclonic: 280 }))).toBe('growing')
    expect(cellStage({ ...ordinary, stage: 'rotating' }, stats({ uh: 300, anticyclonic: 280 }))).toBe('rotating')
  })

  it('tells the supercell stages apart', () => {
    const sc = { ...ordinary, supercell: true, peakW: 40, peakUH: 1500 }
    expect(cellStage(sc, stats({ updraft: 35, uh: 1200, rainRate: 50 }))).toBe('supercell')
    expect(cellStage(sc, stats({ updraft: 35, uh: 800, rainRate: 50, coldUnder: OCCLUSION_COLD + 1 }))).toBe('occluding')
    expect(cellStage({ ...sc, occluded: true }, stats({ updraft: 35, uh: 1200, rainRate: 50 }))).toBe('cycling')
    expect(cellStage(sc, stats({ updraft: 30, uh: 250 }))).toBe('supercell-weak')
    expect(cellStage(sc, stats({ updraft: 12, uh: 50 }))).toBe('supercell-decay')
  })
})
