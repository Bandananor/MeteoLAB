import { describe, expect, it } from 'vitest'
import { avcCodec, writeMp4 } from './mp4'

/** The boxes of a buffer (or of a box's body from `from`): type, where its body starts, where it ends. */
function boxes(b: Uint8Array, from = 0, to = b.length) {
  const v = new DataView(b.buffer, b.byteOffset), out: { type: string; body: number; end: number }[] = []
  for (let o = from; o < to;) {
    const size = v.getUint32(o), type = String.fromCharCode(...b.subarray(o + 4, o + 8))
    out.push({ type, body: o + 8, end: o + size }); o += size
  }
  return out
}
/** The box found down a path of types, each the child of the one before (`skip`: bytes before a box's children). */
function find(b: Uint8Array, path: string[]) {
  const skip: Record<string, number> = { stsd: 8, dref: 8, avc1: 78, meta: 4 }
  let span = { body: 0, end: b.length }, parent = ''
  for (const type of path) { const f = boxes(b, span.body + (skip[parent] ?? 0), span.end).find(x => x.type === type); if (!f) throw new Error(`no ${type}`); span = f; parent = type }
  return span
}

describe('MP4 writer', () => {
  const frame = (n: number, fill: number) => new Uint8Array(n).fill(fill)
  const samples = [{ data: frame(10, 1), key: true }, { data: frame(7, 2), key: false }, { data: frame(5, 3), key: false }, { data: frame(9, 4), key: true }]
  const avcC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 0])
  const file = writeMp4(samples, avcC, 1280, 720, 30), v = new DataView(file.buffer)

  it('has ftyp, moov before the frames, then mdat with every frame in order', () => {
    expect(boxes(file).map(b => b.type)).toEqual(['ftyp', 'moov', 'mdat'])
    const mdat = boxes(file)[2]
    expect(mdat.end).toBe(file.length)
    expect(Array.from(file.subarray(mdat.body))).toEqual(samples.flatMap(s => Array.from(s.data)))
  })

  it('points the chunk offset at the first frame and lists sizes, key frames and the frame duration', () => {
    const stbl = ['moov', 'trak', 'mdia', 'minf', 'stbl']
    const stco = find(file, [...stbl, 'stco']), mdat = boxes(file)[2]
    expect(v.getUint32(stco.body + 8)).toBe(mdat.body)
    const stsz = find(file, [...stbl, 'stsz'])
    expect(v.getUint32(stsz.body + 8)).toBe(4)
    expect([0, 1, 2, 3].map(k => v.getUint32(stsz.body + 12 + 4 * k))).toEqual([10, 7, 5, 9])
    const stss = find(file, [...stbl, 'stss'])
    expect([v.getUint32(stss.body + 4), v.getUint32(stss.body + 8), v.getUint32(stss.body + 12)]).toEqual([2, 1, 4])
    const stts = find(file, [...stbl, 'stts']), mdhd = find(file, ['moov', 'trak', 'mdia', 'mdhd'])
    // 1000 ticks a frame at 30 000 ticks a second: 1/30 s; four frames.
    expect([v.getUint32(stts.body + 8), v.getUint32(stts.body + 12)]).toEqual([4, 1000])
    expect([v.getUint32(mdhd.body + 12), v.getUint32(mdhd.body + 16)]).toEqual([30000, 4000])
  })

  it('carries the picture size and the decoder record', () => {
    const avc1 = find(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'avc1'])
    expect([v.getUint16(avc1.body + 24), v.getUint16(avc1.body + 26)]).toEqual([1280, 720])
    const record = find(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'avc1', 'avcC'])
    expect(Array.from(file.subarray(record.body, record.end))).toEqual(Array.from(avcC))
    const tkhd = find(file, ['moov', 'trak', 'tkhd'])
    expect([v.getUint32(tkhd.body + 76) / 65536, v.getUint32(tkhd.body + 80) / 65536]).toEqual([1280, 720])
  })

  it('keeps the tags in udta (iTunes-style, UTF-8) and still points at the frames', () => {
    const tagged = writeMp4(samples, avcC, 1280, 720, 30, { Software: 'MeteoLab v2.9', Comment: 'https://x/?seed=7', Description: '' }), tv = new DataView(tagged.buffer)
    expect(boxes(tagged).map(b => b.type)).toEqual(['ftyp', 'moov', 'mdat'])
    const text = (atom: string) => { const d = find(tagged, ['moov', 'udta', 'meta', 'ilst', atom, 'data']); expect(tv.getUint32(d.body)).toBe(1); return new TextDecoder().decode(tagged.subarray(d.body + 8, d.end)) }
    expect(text('©too')).toBe('MeteoLab v2.9')
    expect(text('©cmt')).toBe('https://x/?seed=7')
    // An empty text is left out.
    expect(() => find(tagged, ['moov', 'udta', 'meta', 'ilst', 'desc'])).toThrow()
    expect(tv.getUint32(find(tagged, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco']).body + 8)).toBe(boxes(tagged)[2].body)
    expect(() => find(file, ['moov', 'udta'])).toThrow()
  })

  it('picks the lowest H.264 level that holds the picture and the rate', () => {
    expect(avcCodec(1280, 720, 30)).toBe('avc1.64001f')
    expect(avcCodec(1920, 1080, 30)).toBe('avc1.640028')
    expect(avcCodec(1920, 1080, 60)).toBe('avc1.64002a')
    expect(avcCodec(3840, 2160, 30)).toBe('avc1.640033')
    expect(avcCodec(7680, 4320, 30)).toBeNull()
  })
})
