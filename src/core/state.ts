// A saved experiment (.meteolab file): the prognostic fields of the model at one moment, so a run can be continued
// later or passed on. Layout: 'MLAB', the header length (uint32), a JSON header (format, version, settings, model time,
// grid size), padding to 4 bytes, then the fields as float32 in STATE_FIELDS / STATE_COLUMNS order. Everything else the
// step needs (fall speeds, pressure, the ground under the moving domain) it recomputes from these.
import type { SimConfig } from './config'
import type { AtmosphereModel } from './model'

export const STATE_FIELDS = ['u', 'v', 'w', 'theta', 'q', 'cloud', 'rain', 'cold', 'ice', 'snow', 'graupel', 'hail'] as const
export const STATE_COLUMNS = ['precipitation', 'hailGround', 'hailSize'] as const
const MAGIC = 'MLAB', VERSION = 1

export interface StateHeader { format: 'meteolab-state'; version: number; config: unknown; time: number; persisted: number; nx: number; ny: number; nz: number }
export interface SavedState { header: StateHeader; data: Float32Array }

type StateModel = Pick<AtmosphereModel, 'grid' | 'time' | 'rotation' | (typeof STATE_FIELDS)[number] | (typeof STATE_COLUMNS)[number]>

export function saveState(m: StateModel, config: SimConfig): ArrayBuffer {
  const { nx, ny, nz, n, layer } = m.grid
  const header: StateHeader = { format: 'meteolab-state', version: VERSION, config, time: m.time, persisted: m.rotation.persisted, nx, ny, nz }
  const json = new TextEncoder().encode(JSON.stringify(header)), start = Math.ceil((8 + json.length) / 4) * 4
  const buffer = new ArrayBuffer(start + (STATE_FIELDS.length * n + STATE_COLUMNS.length * layer) * 4), bytes = new Uint8Array(buffer)
  bytes.set(new TextEncoder().encode(MAGIC)); new DataView(buffer).setUint32(4, json.length, true); bytes.set(json, 8)
  const data = new Float32Array(buffer, start)
  let o = 0
  for (const k of STATE_FIELDS) { data.set(m[k], o); o += n }
  for (const k of STATE_COLUMNS) { data.set(m[k], o); o += layer }
  return buffer
}

/** Reads a saved state; throws with a readable message if the file is not one (or of an unknown version). */
export function readState(buffer: ArrayBuffer): SavedState {
  if (buffer.byteLength < 8 || new TextDecoder().decode(new Uint8Array(buffer, 0, 4)) !== MAGIC) throw new Error('это не файл состояния MeteoLab')
  const length = new DataView(buffer).getUint32(4, true)
  if (8 + length > buffer.byteLength) throw new Error('файл обрезан')
  let header: StateHeader
  try { header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, length))) } catch { throw new Error('заголовок файла повреждён') }
  if (header?.format !== 'meteolab-state' || header.version !== VERSION) throw new Error('неизвестный формат или версия файла')
  for (const k of ['time', 'persisted', 'nx', 'ny', 'nz'] as const) if (!Number.isFinite(header[k]) || header[k] < 0) throw new Error('заголовок файла повреждён')
  const start = Math.ceil((8 + length) / 4) * 4, cells = header.nx * header.ny, size = STATE_FIELDS.length * cells * header.nz + STATE_COLUMNS.length * cells
  if (buffer.byteLength !== start + size * 4) throw new Error('размер файла не сходится с сеткой')
  return { header, data: new Float32Array(buffer, start, size) }
}

/** Puts a saved state into a model of the same grid (build it from the state's settings first). */
export function applyState(m: StateModel, state: SavedState) {
  const { nx, ny, nz, n, layer } = m.grid, h = state.header
  if (h.nx !== nx || h.ny !== ny || h.nz !== nz) throw new Error(`сетка файла ${h.nx}×${h.ny}×${h.nz}, а у модели ${nx}×${ny}×${nz}`)
  let o = 0
  for (const k of STATE_FIELDS) { m[k].set(state.data.subarray(o, o + n)); o += n }
  for (const k of STATE_COLUMNS) { m[k].set(state.data.subarray(o, o + layer)); o += layer }
  m.time = h.time; m.rotation.persisted = h.persisted
}
