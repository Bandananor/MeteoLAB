// Light frames of a precise run (roadmap C2): the prognostic fields of a saved state (state.ts) at one byte a node, so a
// run's course can be played back with the instruments. A frames file: 'MLFR', the header length (uint32), a JSON
// header (format, version, settings, grid, seconds between frames), padding to 4 bytes, then the frames one after another,
// each a record: its byte length (uint32), its model time (float32), its gzip-compressed payload. Records are only ever
// appended, so a run writes them as it goes; a reader finds them by walking the lengths.
//
// A payload: the time, the mesocyclone's persistence, the charge carried to the ground and the flash counts (float64),
// then each of STATE_FIELDS level by level — per level an offset and a scale (float32), then one byte a node — and the
// STATE_COLUMNS as float32. A hydrometeor is stored as its square root, so weak echoes keep their
// detail near zero (the smallest step of rain then ~1e-7 kg/kg); the others linearly. Decoded, a frame is a SavedState:
// applyState puts it into a model like a saved file (to within the bytes' resolution).
import type { SimConfig } from './config'
import type { Grid } from './grid'
import type { AtmosphereModel } from './model'
import { STATE_COLUMNS, STATE_FIELDS, type SavedState, type StateHeader } from './state'

const MAGIC = 'MLFR', VERSION = 1, STATE_VERSION = 3
/** Hydrometeors (never negative, mostly zero, spanning decades): stored as square roots. The vapour is linear: nearly
 * uniform on a level, its level's own range keeps it to ~1e-6 kg/kg. */
const ROOTED: ReadonlySet<string> = new Set(['cloud', 'rain', 'cold', 'ice', 'snow', 'graupel', 'hail', 'iceNumber'])
/** Bytes of the record's own head: the payload's length and the frame's time. */
export const RECORD_HEAD = 8

export interface FramesHeader { format: 'meteolab-frames'; version: number; config: unknown; nx: number; ny: number; nz: number; every: number }
export interface FrameEntry { offset: number; length: number; time: number }

type FrameModel = Pick<AtmosphereModel, 'grid' | 'time' | 'rotation' | 'chargeGround' | 'flashCount' | (typeof STATE_FIELDS)[number] | (typeof STATE_COLUMNS)[number]>

const pad4 = (n: number) => Math.ceil(n / 4) * 4
const fieldBytes = (nz: number, n: number) => 8 * nz + pad4(n)

/** The file's start: the magic, the header, padding. */
export function framesHeader(config: SimConfig, grid: Pick<Grid, 'nx' | 'ny' | 'nz'>, every: number): Uint8Array {
  const header: FramesHeader = { format: 'meteolab-frames', version: VERSION, config, nx: grid.nx, ny: grid.ny, nz: grid.nz, every }
  const json = new TextEncoder().encode(JSON.stringify(header)), out = new Uint8Array(pad4(8 + json.length))
  out.set(new TextEncoder().encode(MAGIC)); new DataView(out.buffer).setUint32(4, json.length, true); out.set(json, 8)
  return out
}

/** Reads the header from the file's first bytes (at least the header's length); throws if it is not a frames file. */
export function readFramesHeader(bytes: Uint8Array): { header: FramesHeader; start: number } {
  if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) throw new Error('not a MeteoLab frames file')
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true)
  if (8 + length > bytes.length) throw new Error('the frames file is truncated')
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as FramesHeader
  if (header?.format !== 'meteolab-frames' || header.version !== VERSION) throw new Error('unknown frames format or version')
  return { header, start: pad4(8 + length) }
}

async function gzip(data: Uint8Array<ArrayBuffer>, mode: 'compress' | 'decompress') {
  const stream = new Blob([data]).stream().pipeThrough(mode === 'compress' ? new CompressionStream('gzip') : new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** One frame of the model as it is now: a record to append to the file. */
export async function encodeFrame(m: FrameModel): Promise<Uint8Array> {
  const { nz, n, layer } = m.grid, size = 40 + STATE_FIELDS.length * fieldBytes(nz, n) + STATE_COLUMNS.length * layer * 4
  const payload = new Uint8Array(size), view = new DataView(payload.buffer)
  ;[m.time, m.rotation.persisted, m.chargeGround, m.flashCount.ic, m.flashCount.cg].forEach((v, k) => view.setFloat64(8 * k, v, true))
  let o = 40
  for (const key of STATE_FIELDS) {
    const a = m[key], rooted = ROOTED.has(key), params = new Float32Array(payload.buffer, o, 2 * nz), bytes = payload.subarray(o + 8 * nz, o + 8 * nz + n)
    for (let z = 0; z < nz; z++) {
      const i0 = z * layer, i1 = i0 + layer
      let lo = Infinity, hi = -Infinity
      for (let i = i0; i < i1; i++) { const v = rooted ? Math.sqrt(Math.max(0, a[i])) : a[i]; if (v < lo) lo = v; if (v > hi) hi = v }
      // Rooted fields start at zero, so a level of rain only keeps zero exact.
      if (rooted) lo = 0
      const scale = hi > lo ? (hi - lo) / 255 : 0
      params[2 * z] = lo; params[2 * z + 1] = scale
      for (let i = i0; i < i1; i++) { const v = rooted ? Math.sqrt(Math.max(0, a[i])) : a[i]; bytes[i] = scale > 0 ? Math.round((v - lo) / scale) : 0 }
    }
    o += fieldBytes(nz, n)
  }
  for (const key of STATE_COLUMNS) { new Float32Array(payload.buffer, o, layer).set(m[key]); o += layer * 4 }
  const packed = await gzip(payload, 'compress'), record = new Uint8Array(RECORD_HEAD + packed.length), head = new DataView(record.buffer)
  head.setUint32(0, packed.length, true); head.setFloat32(4, m.time, true); record.set(packed, RECORD_HEAD)
  return record
}

/** A frame's payload (the record without its head) as a saved state of the file's settings. */
export async function decodeFrame(packed: Uint8Array<ArrayBuffer>, header: FramesHeader): Promise<SavedState> {
  const { nx, ny, nz } = header, layer = nx * ny, n = layer * nz, payload = await gzip(packed, 'decompress')
  if (payload.length !== 40 + STATE_FIELDS.length * fieldBytes(nz, n) + STATE_COLUMNS.length * layer * 4) throw new Error('a frame does not match the grid')
  const view = new DataView(payload.buffer), [time, persisted, chargeGround, ic, cg] = [0, 1, 2, 3, 4].map(k => view.getFloat64(8 * k, true))
  const data = new Float32Array(STATE_FIELDS.length * n + STATE_COLUMNS.length * layer)
  let o = 40, d = 0
  for (const key of STATE_FIELDS) {
    const rooted = ROOTED.has(key), params = new Float32Array(payload.buffer, o, 2 * nz), bytes = payload.subarray(o + 8 * nz, o + 8 * nz + n)
    for (let z = 0; z < nz; z++) {
      const lo = params[2 * z], scale = params[2 * z + 1]
      for (let i = z * layer, e = i + layer; i < e; i++) { const v = lo + bytes[i] * scale; data[d + i] = rooted ? v * v : v }
    }
    o += fieldBytes(nz, n); d += n
  }
  for (let k = 0; k < STATE_COLUMNS.length; k++) { data.set(new Float32Array(payload.buffer, o, layer), d); o += layer * 4; d += layer }
  const state: StateHeader = { format: 'meteolab-state', version: STATE_VERSION, config: header.config, time, persisted, nx, ny, nz, chargeGround, flashCount: { ic, cg } }
  return { header: state, data }
}

/**
 * The frames of a file by walking the records: `read` gives bytes of the file (a File's slice in the browser, a file
 * handle in Node), `size` its length. A record cut short at the end (a run stopped while writing it) is left out.
 */
export async function frameIndex(read: (offset: number, length: number) => Promise<Uint8Array>, size: number, start: number): Promise<FrameEntry[]> {
  const frames: FrameEntry[] = []
  for (let o = start; o + RECORD_HEAD <= size;) {
    const head = await read(o, RECORD_HEAD), view = new DataView(head.buffer, head.byteOffset, RECORD_HEAD), length = view.getUint32(0, true)
    if (o + RECORD_HEAD + length > size) break
    frames.push({ offset: o + RECORD_HEAD, length, time: view.getFloat32(4, true) })
    o += RECORD_HEAD + length
  }
  return frames
}
