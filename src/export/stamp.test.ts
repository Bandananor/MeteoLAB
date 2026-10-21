import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULTS } from '../defaults'
import { toCsv } from '../share'
import { crc32, setRunLink, stampColumns, stampPng } from './stamp'

/** The chunks of a PNG: type, data, whether the stored CRC is right. */
function chunks(png: Uint8Array) {
  const v = new DataView(png.buffer, png.byteOffset), out: { type: string; data: Uint8Array; crcOk: boolean }[] = []
  for (let o = 8; o < png.length;) {
    const length = v.getUint32(o), type = String.fromCharCode(...png.subarray(o + 4, o + 8))
    out.push({ type, data: png.subarray(o + 8, o + 8 + length), crcOk: crc32(png.subarray(o + 4, o + 8 + length)) === v.getUint32(o + 8 + length) })
    o += 12 + length
  }
  return out
}
/** A 1 x 1 PNG: signature, IHDR, IDAT, IEND. */
const PIXEL = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0))

describe('export stamp (E4)', () => {
  afterEach(() => setRunLink(() => ''))

  it('computes the standard CRC-32', () => expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926))

  it('puts UTF-8 text chunks after IHDR, with right CRCs, the picture untouched', () => {
    const png = stampPng(PIXEL, { Software: 'MeteoLab v2.9', Description: 'Экран прибора', Comment: '' })
    const list = chunks(png)
    expect(list.map(c => c.type)).toEqual(['IHDR', 'iTXt', 'iTXt', 'IDAT', 'IEND'])
    expect(list.every(c => c.crcOk)).toBe(true)
    const text = list.filter(c => c.type === 'iTXt').map(c => { const zero = c.data.indexOf(0); return [new TextDecoder().decode(c.data.subarray(0, zero)), new TextDecoder().decode(c.data.subarray(zero + 5))] })
    expect(text).toEqual([['Software', 'MeteoLab v2.9'], ['Description', 'Экран прибора']])
    expect(chunks(PIXEL).map(c => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
  })

  it('leads every CSV with the version, the seed and the link (the run now, or each row its own)', () => {
    const made: number[] = []
    setRunLink(c => { made.push(c?.seed ?? 0); return `https://x/?seed=${c?.seed ?? 5}` })
    const now = toCsv([{ t: 0 }, { t: 30 }], [...stampColumns(() => 5), ['t_s', r => r.t]]).split('\n')
    expect(now[0]).toBe('model_version,seed,run_link,t_s')
    expect(now[1]).toBe('"dev",5,"https://x/?seed=5",0')
    // The run's link is made once for the file.
    expect(made).toEqual([0])
    const rows = [11, 12].map(seed => ({ config: { ...DEFAULTS, seed } }))
    const each = toCsv(rows, [...stampColumns<(typeof rows)[number]>(r => r.config.seed, r => r.config)]).split('\n')
    expect(each.slice(1, 3)).toEqual(['"dev",11,"https://x/?seed=11"', '"dev",12,"https://x/?seed=12"'])
  })
})
