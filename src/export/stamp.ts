/**
 * What every export carries so its run can be repeated (roadmap E4): the model's version and the link to the run — its
 * settings and seed, as «Поделиться» makes it. main.ts gives the link maker; until it does, the link is empty. What was
 * done by hand during a run (interventions) is not in a link: the run's file (.meteolab) keeps that.
 */
import type { SimConfig } from '../core/config'
import { MODEL_VERSION } from '../version'

let maker: (config?: SimConfig) => string = () => ''
export function setRunLink(make: (config?: SimConfig) => string) { maker = make }
/** The link to the run now, or to a run with `config` (an ensemble's member, a cell of the regime map). */
export const runLink = (config?: SimConfig) => maker(config)

/** The first CSV columns: the version, the seed and the link (the run now's, or each row's own `config`). */
export function stampColumns<T>(seed: (row: T) => number, config?: (row: T) => SimConfig): [string, (row: T) => number | string][] {
  const now = config ? '' : runLink()
  return [['model_version', () => MODEL_VERSION], ['seed', seed], ['run_link', r => config ? runLink(config(r)) : now]]
}

/** A picture's or a video's text fields: the program with its version, what it shows, the link. */
export const mediaStamp = (description: string) => ({ Software: `MeteoLab ${MODEL_VERSION}`, Description: description, Comment: runLink() })

let table: Uint32Array | undefined
/** CRC-32 (PNG, zlib) of `bytes`. */
export function crc32(bytes: Uint8Array) {
  table ??= Uint32Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0 })
  let c = 0xffffffff
  for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * The PNG with UTF-8 text chunks (iTXt) after its header: read by exiftool, Pillow (`Image.open(f).text`), most image
 * viewers' properties. Keywords are PNG's own (Software, Description, Comment); empty texts are left out.
 */
export function stampPng(png: Uint8Array, text: Record<string, string>): Uint8Array<ArrayBuffer> {
  const utf8 = new TextEncoder(), chunks: number[] = []
  for (const [key, value] of Object.entries(text)) {
    if (!value) continue
    // keyword \0, compression flag and method 0, no language tag \0, no translated keyword \0, the text.
    const body = new Uint8Array([...utf8.encode(`iTXt${key}`), 0, 0, 0, 0, 0, ...utf8.encode(value)]), length = body.length - 4
    const crc = crc32(body)
    chunks.push(length >>> 24, length >>> 16 & 255, length >>> 8 & 255, length & 255, ...body, crc >>> 24, crc >>> 16 & 255, crc >>> 8 & 255, crc & 255)
  }
  // The signature (8 bytes) and IHDR (4 + 4 + 13 + 4) come first.
  const at = 8 + 25, out = new Uint8Array(png.length + chunks.length)
  out.set(png.subarray(0, at)); out.set(chunks, at); out.set(png.subarray(at), at + chunks.length)
  return out
}

/** A PNG blob stamped (stampPng). */
export const stampPngBlob = async (blob: Blob, text: Record<string, string>) => new Blob([stampPng(new Uint8Array(await blob.arrayBuffer()), text)], { type: 'image/png' })
