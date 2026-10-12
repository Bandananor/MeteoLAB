import { describe, expect, it } from 'vitest'
import { BUILTIN, colorAt, lookup, lutIndex, Palettes, parsePal, ticks, toPal } from './palettes'

const nws = BUILTIN.find(p => p.id === 'z-nws')!, classic = BUILTIN.find(p => p.id === 'v-classic')!

describe('radar palettes', () => {
  it('keeps the old tables: NWS reflectivity in 5 dBZ steps from 5, velocity clamped below -40', () => {
    expect(colorAt(nws, 4.9)).toBeNull()
    expect(colorAt(nws, 5)).toEqual([4, 233, 231, 255]); expect(colorAt(nws, 52)).toEqual([253, 0, 0, 255]); expect(colorAt(nws, 90)).toEqual([253, 253, 253, 255])
    expect(colorAt(classic, -60)).toEqual([0, 255, 166, 255]); expect(colorAt(classic, 2)).toEqual([90, 70, 70, 255]); expect(colorAt(classic, NaN)).toBeNull()
  })

  it('blends a gradient stop to the next stop or to its own second colour', () => {
    const p = { id: 'x', name: 'x', kind: 'Z' as const, stops: [{ value: 0, color: [0, 0, 0] as const }, { value: 10, color: [100, 200, 0] as const, to: [200, 0, 0] as const }, { value: 20, color: [0, 0, 255] as const, solid: true }] }
    expect(colorAt(p, 5)).toEqual([50, 100, 0, 255]); expect(colorAt(p, 15)).toEqual([150, 100, 0, 255]); expect(colorAt(p, 30)).toEqual([0, 0, 255, 255])
    // The lookup agrees with colorAt at its entries' centres.
    const lut = lookup(p), k = lutIndex('Z', 5)
    expect(Array.from(lut.slice(k * 4, k * 4 + 4))).toEqual(colorAt(p, -30 + 120 * (k + .5) / 1024))
  })

  it('reads .pal files of the hobby radar programs: Color, SolidColor, Color4, units and scale', () => {
    const velocity = parsePal('; velocity\nProduct: BV\nUnits: KTS\nStep: 10\nColor: -64 0 255 0 0 100 0\nColor: 0 120 120 120\nSolidColor: 10 255 0 0\nRF: 128 0 128\n', 'Z', 'GR')
    expect(velocity.kind).toBe('V'); expect(velocity.stops.map(s => +s.value.toFixed(2))).toEqual([-32.92, 0, 5.14])
    expect(velocity.stops[0].to).toEqual([0, 100, 0]); expect(velocity.stops[2].solid).toBe(true)
    const scaled = parsePal('Product: BV\nUnits: KTS\nScale: 1.9426\nColor: -20 0 0 0', 'Z')
    expect(scaled.stops[0].value).toBeCloseTo(-20 / 1.9426, 6)
    const cc = parsePal('Product: CC\nColor4: 0.2 0 0 0 0\nColor: 0.9 0 255 0\nColor: 1.0 255 0 255', 'Z')
    expect(cc.kind).toBe('RHO'); expect(cc.stops[0].color).toBeNull()
    expect(() => parsePal('Product: BR\nUnits: DBZ', 'Z')).toThrow()
  })

  it('writes .pal back so that reading it gives the same palette', () => {
    for (const p of BUILTIN) {
      const back = parsePal(toPal(p), p.kind === 'Z' ? 'V' : 'Z')
      expect(back.kind).toBe(p.kind)
      for (const v of [-30, -5, 0, .5, .95, 1, 2.5, 12, 33, 47, 61, 80]) expect(colorAt({ ...back, id: '' }, v)).toEqual(colorAt(p, v))
    }
  })

  it('keeps the user palettes and the choice per product in the storage', () => {
    const store = new Map<string, string>(), storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    const a = new Palettes(storage)
    expect(a.chosen('Z').id).toBe('z-nws')
    const mine = a.put({ name: 'Моя', kind: 'Z', stops: [{ value: 10, color: [1, 2, 3], solid: true }] })
    const b = new Palettes(storage)
    expect(b.chosen('Z')).toEqual(mine); expect(b.all('Z').map(p => p.id)).toContain(mine.id); expect(b.all('V').map(p => p.id)).not.toContain(mine.id)
    b.choose('V', 'v-cvd'); b.remove(mine.id)
    const c = new Palettes(storage)
    expect(c.chosen('Z').id).toBe('z-nws'); expect(c.chosen('V').id).toBe('v-cvd')
    // Junk in the storage is dropped, not trusted.
    store.set('meteolab-palettes', JSON.stringify({ user: [{ id: 'x', name: 'x', kind: 'Z', stops: [{ value: 'a', color: [1, 2, 3] }] }], chosen: {} }))
    expect(new Palettes(storage).all('Z').every(p => p.builtin)).toBe(true)
  })

  it('puts 4-7 round ticks on a colour bar', () => {
    expect(ticks([5, 75])).toEqual([10, 20, 30, 40, 50, 60, 70])
    expect(ticks([.7, 1.05])).toEqual([.7, .8, .9, 1])
    expect(ticks([-40, 40])).toEqual([-40, -20, 0, 20, 40])
  })
})
