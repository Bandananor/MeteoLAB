// A saved experiment (.meteolab file): the prognostic fields of the model at one moment, so a run can be continued
// later or passed on. Layout: 'MLAB', the header length (uint32), a JSON header (format, version, settings, model time,
// grid size), padding to 4 bytes, then the fields as float32 in STATE_FIELDS / STATE_COLUMNS order. Everything else the
// step needs (fall speeds, pressure, the ground under the moving domain) it recomputes from these.
import { L } from '../i18n'
import type { SimConfig } from './config'
import type { AtmosphereModel } from './model'

export const STATE_FIELDS = ['u', 'v', 'w', 'theta', 'q', 'cloud', 'rain', 'cold', 'ice', 'snow', 'graupel', 'hail', 'chargeIce', 'chargeGraupel', 'chargeRain', 'chargeAir', 'iceNumber'] as const
export const STATE_COLUMNS = ['precipitation', 'hailGround', 'hailSize'] as const
/**
 * Version 2 (2.3) adds the four charge fields and the lightning counts, version 3 (2.7.2) the number of ice crystals;
 * older files still load, without charge (version 1) and with the crystals rebuilt from the ice by the first step.
 */
const MAGIC = 'MLAB', VERSION = 3, V1_FIELDS = 12, V2_FIELDS = 16

export interface StateHeader {
  format: 'meteolab-state'; version: number; config: unknown; time: number; persisted: number; nx: number; ny: number; nz: number
  /** Version 2: charge carried to the ground (C) and the flashes since the start. */
  chargeGround?: number; flashCount?: { ic: number; cg: number }
}
export interface SavedState { header: StateHeader; data: Float32Array }

type StateModel = Pick<AtmosphereModel, 'grid' | 'time' | 'rotation' | 'chargeGround' | 'flashCount' | 'flashes' | (typeof STATE_FIELDS)[number] | (typeof STATE_COLUMNS)[number]>

/** The fields a file of this version holds. */
const fieldsOf = (version: number) => version === 1 ? STATE_FIELDS.slice(0, V1_FIELDS) : version === 2 ? STATE_FIELDS.slice(0, V2_FIELDS) : STATE_FIELDS

export function saveState(m: StateModel, config: SimConfig): ArrayBuffer {
  const { nx, ny, nz, n, layer } = m.grid
  const header: StateHeader = { format: 'meteolab-state', version: VERSION, config, time: m.time, persisted: m.rotation.persisted, nx, ny, nz, chargeGround: m.chargeGround, flashCount: { ...m.flashCount } }
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
  if (buffer.byteLength < 8 || new TextDecoder().decode(new Uint8Array(buffer, 0, 4)) !== MAGIC) throw new Error(L('это не файл состояния MeteoLab', 'this is not a MeteoLab state file'))
  const length = new DataView(buffer).getUint32(4, true)
  if (8 + length > buffer.byteLength) throw new Error(L('файл обрезан', 'the file is truncated'))
  let header: StateHeader
  try { header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, length))) } catch { throw new Error(L('заголовок файла повреждён', 'the file’s header is damaged')) }
  if (header?.format !== 'meteolab-state' || (header.version !== VERSION && header.version !== 2 && header.version !== 1)) throw new Error(L('неизвестный формат или версия файла', 'unknown file format or version'))
  for (const k of ['time', 'persisted', 'nx', 'ny', 'nz'] as const) if (!Number.isFinite(header[k]) || header[k] < 0) throw new Error(L('заголовок файла повреждён', 'the file’s header is damaged'))
  const start = Math.ceil((8 + length) / 4) * 4, cells = header.nx * header.ny, size = fieldsOf(header.version).length * cells * header.nz + STATE_COLUMNS.length * cells
  if (buffer.byteLength !== start + size * 4) throw new Error(L('размер файла не сходится с сеткой', 'the file’s size does not match the grid'))
  return { header, data: new Float32Array(buffer, start, size) }
}

/**
 * Puts a saved state into a model of the same grid (build it from the state's settings first). The flashes after the
 * state's time are forgotten (a rewind); a version 1 file has no charge.
 */
export function applyState(m: StateModel, state: SavedState) {
  const { nx, ny, nz, n, layer } = m.grid, h = state.header
  if (h.nx !== nx || h.ny !== ny || h.nz !== nz) throw new Error(L(`сетка файла ${h.nx}×${h.ny}×${h.nz}, а у модели ${nx}×${ny}×${nz}`, `the file’s grid is ${h.nx}×${h.ny}×${h.nz}, the model’s ${nx}×${ny}×${nz}`))
  let o = 0
  for (const k of STATE_FIELDS.slice(fieldsOf(h.version).length)) m[k].fill(0)
  for (const k of fieldsOf(h.version)) { m[k].set(state.data.subarray(o, o + n)); o += n }
  for (const k of STATE_COLUMNS) { m[k].set(state.data.subarray(o, o + layer)); o += layer }
  m.time = h.time; m.rotation.persisted = h.persisted
  // The rotation diagnostics are not saved: recomputed from the fields (on a model; not on a bare holder of fields).
  ;(m as { refreshRotation?: () => void }).refreshRotation?.()
  m.chargeGround = h.chargeGround ?? 0; m.flashCount = { ic: h.flashCount?.ic ?? 0, cg: h.flashCount?.cg ?? 0 }
  const kept = m.flashes.findIndex(f => f.time > h.time)
  if (kept >= 0) m.flashes.length = kept
}
