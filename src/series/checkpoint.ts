/**
 * A series' finished runs kept as they finish (tools/series.ts, `resume`): one JSON line per run after a header line,
 * so a series stopped by Ctrl+C, a crash or a laptop switched off goes on from where it stood and the runs it kept are
 * bit-for-bit those it would have written (the swaths as float32 in base64, not decimals).
 */
import type { MemberResult } from '../ensemble/member'

/** The first line: which series file (its text's FNV-1a hash), how many runs, and the model version that ran them. */
export interface CheckpointHeader { checkpoint: 1; series: string; runs: number; version: string }

const SWATHS = ['rainTotal', 'hailSize', 'gustMax', 'uhMax'] as const

/** FNV-1a, 32 bits, as 8 hex digits: enough to tell one series file from another. */
export function seriesFingerprint(text: string) {
  let h = 0x811c9dc5
  for (let k = 0; k < text.length; k++) { h ^= text.charCodeAt(k); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

const toBase64 = (a: Float32Array) => { const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let s = ''; for (let k = 0; k < b.length; k += 0x8000) s += String.fromCharCode(...b.subarray(k, k + 0x8000)); return btoa(s) }
const fromBase64 = (s: string) => { const b = atob(s), u = new Uint8Array(b.length); for (let k = 0; k < b.length; k++) u[k] = b.charCodeAt(k); return new Float32Array(u.buffer) }

export const checkpointHeader = (text: string, runs: number, version: string) => JSON.stringify({ checkpoint: 1, series: seriesFingerprint(text), runs, version } satisfies CheckpointHeader)

/** One finished run as a line (no newline at the end). */
export function checkpointLine(index: number, r: MemberResult) {
  const swaths = Object.fromEntries(SWATHS.map(k => [k, toBase64(r[k])]))
  return JSON.stringify({ index, ...r, ...swaths })
}

/**
 * The runs a checkpoint file kept, by index, for this series file and number of runs; an error when the file belongs
 * to another series. A torn last line (the process killed while writing it) is dropped: that run is simply run again.
 */
export function readCheckpoint(file: string, text: string, runs: number): { header: CheckpointHeader; results: Map<number, MemberResult> } | { error: string } {
  const lines = file.split('\n').filter(l => l.trim())
  let header: CheckpointHeader
  try { header = JSON.parse(lines[0] ?? '') } catch { return { error: 'not a series checkpoint' } }
  if (header?.checkpoint !== 1) return { error: 'not a series checkpoint' }
  if (header.series !== seriesFingerprint(text) || header.runs !== runs) return { error: 'the checkpoint belongs to another series file (or the file has changed since)' }
  const results = new Map<number, MemberResult>()
  for (const line of lines.slice(1)) {
    let o: MemberResult & { index: number } & Record<string, unknown>
    try { o = JSON.parse(line) } catch { continue }
    if (!Number.isInteger(o.index) || o.index < 0 || o.index >= runs) continue
    const { index, ...rest } = o
    for (const k of SWATHS) (rest as Record<string, unknown>)[k] = fromBase64(o[k] as unknown as string)
    results.set(index, rest as MemberResult)
  }
  return { header, results }
}
