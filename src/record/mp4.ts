/**
 * A minimal MP4 writer for one H.264 video track (the video recording, 2.9): the encoded frames as WebCodecs gives them
 * (length-prefixed NAL units, `avc` format) with the decoder's avcC record, all in one chunk after the moov box (moov
 * first, so a player can start before the whole file is read). No audio, no B-frames (WebCodecs' H.264 encoders make
 * none), a constant frame duration; 32-bit offsets, so a file stays under 4 GB (MAX_BYTES). Text tags go in moov's udta as
 * iTunes-style metadata (what ffprobe, exiftool and players show as encoder, description, comment).
 */

/** One encoded frame: its bytes and whether it is a key frame. */
export interface Sample { data: Uint8Array; key: boolean }

/** Larger files would need 64-bit chunk offsets (co64) and mdat size. */
export const MAX_BYTES = 0xffff_fff0

const ascii = (s: string) => Array.from(s, c => c.charCodeAt(0))
const u16 = (v: number) => [v >>> 8 & 255, v & 255]
const u32 = (v: number) => [v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255]

/** A box: its size, its four-letter type and its body (bytes or nested boxes). */
function box(type: string, ...parts: (number[] | Uint8Array)[]) {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0), out = new Uint8Array(size)
  out.set([...u32(size), ...ascii(type)])
  let o = 8
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
/** A full box: a box whose body starts with a version byte and three flag bytes. */
const full = (type: string, version: number, flags: number, ...parts: (number[] | Uint8Array)[]) => box(type, [version, flags >>> 16 & 255, flags >>> 8 & 255, flags & 255], ...parts)
/** The tags' iTunes atoms: ©too the encoder, desc the description, ©cmt the comment. */
const TAGS: Record<string, string> = { Software: '©too', Description: 'desc', Comment: '©cmt' }
const utf8 = new TextEncoder()
/** udta with the tags (known keys, non-empty texts) or nothing. */
function userData(tags: Record<string, string>) {
  const items = Object.entries(tags).filter(([k, v]) => TAGS[k] && v).map(([k, v]) => box(TAGS[k], box('data', u32(1), u32(0), utf8.encode(v))))
  if (!items.length) return []
  return [box('udta', full('meta', 0, 0, full('hdlr', 0, 0, u32(0), ascii('mdir'), ascii('appl'), u32(0), u32(0), [0]), box('ilst', ...items)))]
}
/** The identity transform of mvhd and tkhd (16.16 and 2.30 fixed point). */
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].flatMap(u32)

/**
 * The MP4 file of `samples` (in decode order, the first a key frame), `fps` frames a second, the picture `width` x
 * `height`, decoded with `avcC` (VideoDecoderConfig.description from the encoder), with text `tags` (Software,
 * Description, Comment).
 */
export function writeMp4(samples: Sample[], avcC: Uint8Array, width: number, height: number, fps: number, tags: Record<string, string> = {}) {
  if (!samples.length) throw new Error('no frames')
  // The media's clock: 1000 ticks a frame (exact for any whole fps); the movie's in ms.
  const timescale = Math.round(fps * 1000), delta = 1000, count = samples.length
  const ms = Math.round(count * 1000 / fps), mediaDuration = count * delta
  const bytes = samples.reduce((n, s) => n + s.data.length, 0)
  const moov = (offset: number) => box('moov',
    full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(ms), u32(0x10000), u16(0x100), Array(10).fill(0), MATRIX, Array(24).fill(0), u32(2)),
    box('trak',
      full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(ms), Array(8).fill(0), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width * 65536), u32(height * 65536)),
      box('mdia',
        full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(mediaDuration), u16(0x55c4), u16(0)),
        full('hdlr', 0, 0, u32(0), ascii('vide'), Array(12).fill(0), [...ascii('VideoHandler'), 0]),
        box('minf',
          full('vmhd', 0, 1, Array(8).fill(0)),
          box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
          box('stbl',
            full('stsd', 0, 0, u32(1), box('avc1', Array(6).fill(0), u16(1), Array(16).fill(0), u16(width), u16(height), u32(0x480000), u32(0x480000), u32(0), u16(1), Array(32).fill(0), u16(0x18), u16(0xffff), box('avcC', avcC))),
            full('stts', 0, 0, u32(1), u32(count), u32(delta)),
            full('stss', 0, 0, u32(samples.filter(s => s.key).length), samples.flatMap((s, k) => s.key ? u32(k + 1) : [])),
            full('stsc', 0, 0, u32(1), u32(1), u32(count), u32(1)),
            full('stsz', 0, 0, u32(0), u32(count), samples.flatMap(s => u32(s.data.length))),
            full('stco', 0, 0, u32(1), u32(offset)))))),
    ...userData(tags))
  const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isomiso2avc1mp41'))
  // The offset of the frames: after ftyp, moov (its size does not depend on the offset) and mdat's header.
  const head = ftyp.length + moov(0).length + 8
  if (head + bytes > MAX_BYTES) throw new Error('the video is over 4 GB')
  const out = new Uint8Array(head + bytes)
  out.set(ftyp); out.set(moov(head), ftyp.length); out.set([...u32(8 + bytes), ...ascii('mdat')], head - 8)
  let o = head
  for (const s of samples) { out.set(s.data, o); o += s.data.length }
  return out
}

/**
 * The H.264 codec string (avc1.PPCCLL) of the High profile at the lowest level that holds `width` x `height` at `fps`
 * (H.264 table A-1: macroblocks a frame and a second); null beyond level 5.2.
 */
export function avcCodec(width: number, height: number, fps: number) {
  const frame = Math.ceil(width / 16) * Math.ceil(height / 16), rate = frame * fps
  const levels: [number, number, number][] = [[30, 1620, 40500], [31, 3600, 108000], [32, 5120, 216000], [40, 8192, 245760], [42, 8704, 522240], [50, 22080, 589824], [51, 36864, 983040], [52, 36864, 2073600]]
  const level = levels.find(([, f, r]) => frame <= f && rate <= r)
  return level ? `avc1.6400${level[0].toString(16).padStart(2, '0')}` : null
}
