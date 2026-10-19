// What the lightning detector derives from the model's flashes (core/lightning.ts): where they are on the ground now,
// the flash rate minute by minute, lightning jumps, the flash density, and the numbers of one flash for its card.
import { L } from '../i18n'
import type { Flash, Grid } from '../core'

/** What the detector needs of the model: the grid, the domain's motion over the ground (m/s) and the time now. */
export interface DetectorSource { grid: Grid; frame: readonly [number, number]; time: number }

/** Where a flash's point (grid node) is now relative to the domain, m: the ground stays, the domain moved on with the storm. */
export function nodeNow(m: DetectorSource, flash: Flash, node: number) {
  const { nx, layer, dx, dy, zs } = m.grid, z = Math.floor(node / layer), y = Math.floor((node - z * layer) / nx), x = node - z * layer - y * nx, ago = m.time - flash.time
  return { x: x * dx - m.frame[0] * ago, y: y * dy - m.frame[1] * ago, z: zs[z] }
}

/**
 * The detector's location of a flash, m relative to the domain now: where a CG struck the ground; for an IC the
 * centre of its channel in plan (as a VHF network places it).
 */
export function flashPoint(m: DetectorSource, flash: Flash) {
  if (flash.kind === 'CG') return nodeNow(m, flash, flash.ground)
  // Centre over the channel, periodic in x and y: around the first node.
  const first = nodeNow(m, flash, flash.nodes[0]), { width, depth } = m.grid
  let sx = 0, sy = 0
  for (const n of flash.nodes) {
    const p = nodeNow(m, flash, n)
    sx += p.x - width * Math.round((p.x - first.x) / width); sy += p.y - depth * Math.round((p.y - first.y) / depth)
  }
  return { x: sx / flash.nodes.length, y: sy / flash.nodes.length, z: first.z }
}

/** Flashes in one minute: IC, negative CG, positive CG. */
export interface RateBin { t: number; ic: number; cgNeg: number; cgPos: number }

/** Flashes per model minute from minute `from` (s, a multiple of 60) to the one containing `until`. */
export function flashRates(flashes: readonly Flash[], from: number, until: number): RateBin[] {
  const bins: RateBin[] = []
  for (let t = from; t <= until; t += 60) bins.push({ t, ic: 0, cgNeg: 0, cgPos: 0 })
  for (const f of flashes) {
    // A flash at the very end of a minute's last step counts in that minute (times are step ends: 3, 6, … 60).
    const k = Math.ceil((f.time - from) / 60) - 1
    if (k < 0 || k >= bins.length) continue
    if (f.kind === 'IC') bins[k].ic++; else if (f.charge < 0) bins[k].cgNeg++; else bins[k].cgPos++
  }
  return bins
}

/** All flashes of a minute bin. */
export const total = (b: RateBin) => b.ic + b.cgNeg + b.cgPos

/** The total flash rate, per minute, below which a rise is not called a jump (Schultz et al. 2009: 10 flashes a minute). */
export const JUMP_FLOOR = 10

/**
 * Lightning jumps, by the 2σ algorithm of Schultz et al. (2009): the total flash rate averaged over 2 minutes, its rate
 * of change (DFRDT, per minute per minute, over 2 minutes); a jump when DFRDT exceeds twice its standard deviation over
 * the 10 minutes before (five 2-minute values) while the rate is at least JUMP_FLOOR. Returns the minutes (bin times,
 * s) where a jump begins; a jump held over consecutive minutes is reported once.
 */
export function lightningJumps(bins: readonly RateBin[]): number[] {
  const rate = (k: number) => (total(bins[k]) + total(bins[k - 1])) / 2
  const dfrdt = (k: number) => (rate(k) - rate(k - 2)) / 2
  const jumps: number[] = []
  let inJump = false
  for (let k = 13; k < bins.length; k++) {
    const past = [2, 4, 6, 8, 10].map(d => dfrdt(k - d)), mean = past.reduce((a, b) => a + b, 0) / past.length
    const sigma = Math.sqrt(past.reduce((s, v) => s + (v - mean) ** 2, 0) / past.length)
    const jump = rate(k) >= JUMP_FLOOR && dfrdt(k) > 2 * sigma && dfrdt(k) > 0
    if (jump && !inJump) jumps.push(bins[k].t)
    inJump = jump
  }
  return jumps
}

/**
 * Flash density over the domain now: flashes per km² in `cell`-sized squares (m) of the ground, counting the
 * flashes since `since` (s) at their detector location; periodic like the domain.
 */
export function flashDensity(m: DetectorSource, flashes: readonly Flash[], since: number, cell: number) {
  const cols = Math.max(1, Math.round(m.grid.width / cell)), rows = Math.max(1, Math.round(m.grid.depth / cell))
  const cw = m.grid.width / cols, ch = m.grid.depth / rows, density = new Float32Array(cols * rows), area = cw * ch / 1e6
  for (const f of flashes) {
    if (f.time < since) continue
    const p = flashPoint(m, f), c = ((Math.floor(p.x / cw) % cols) + cols) % cols, r = ((Math.floor(p.y / ch) % rows) + rows) % rows
    density[c + r * cols] += 1 / area
  }
  return { cols, rows, density }
}

/** The numbers of one flash for its card. */
export function flashFacts(m: DetectorSource, flash: Flash) {
  const { width, depth } = m.grid, start = nodeNow(m, flash, flash.start)
  let length = 0, reach = 0, low = Infinity, high = 0, positive = 0
  for (let c = 0; c < flash.nodes.length; c++) {
    const p = nodeNow(m, flash, flash.nodes[c])
    low = Math.min(low, p.z); high = Math.max(high, p.z)
    if (flash.polarity[c] > 0) positive++
    const dxs = p.x - start.x - width * Math.round((p.x - start.x) / width), dys = p.y - start.y - depth * Math.round((p.y - start.y) / depth)
    reach = Math.max(reach, Math.hypot(dxs, dys))
    if (c === 0) continue
    const q = nodeNow(m, flash, flash.nodes[flash.parent[c]])
    length += Math.hypot(p.x - q.x - width * Math.round((p.x - q.x) / width), p.y - q.y - depth * Math.round((p.y - q.y) / depth), p.z - q.z)
  }
  return {
    kind: flash.kind === 'IC' ? L('внутриоблачная (IC)', 'in-cloud (IC)') : flash.charge < 0 ? L('в землю, отрицательная (−CG)', 'to ground, negative (−CG)') : L('в землю, положительная (+CG)', 'to ground, positive (+CG)'),
    /** Height where the breakdown began, km. */ start: start.z / 1000,
    /** Lowest and highest point of the channel, km. */ low: low / 1000, high: high / 1000,
    /** Total length of the channel's segments and its farthest horizontal reach from the start, km. */ length: length / 1000, reach: reach / 1000,
    /** Share of the channel that was positive leader (in negative charge). */ positiveShare: positive / flash.nodes.length,
    /** Charge: IC — of each sign neutralized; CG — lowered to the ground, signed, C. */ charge: flash.charge,
    /** Channel potential, MV. */ potential: flash.potential / 1e6,
  }
}
