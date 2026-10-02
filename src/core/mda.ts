import { beamHeight, type PPI, RADAR_TILTS } from './ppi'

/** Polar scan of the detection: 500 m gates out to 60 km, 1.5° beams. */
const STEP = 500, GATES = 120, BEAMS = 240
/** Smallest change of radial velocity across a shear segment, m/s (a rotational velocity of 5 m/s). */
export const MDA_MIN_DV = 10
/**
 * Largest diameter of a circulation (length of a shear segment), m, and the smallest azimuthal shear across it, 1/s: weaker
 * broad shear also shows on the outer flank of an anticyclone (~2e-3); the model's mesocyclones give ~4e-3.
 */
const MAX_DIAMETER = 10_000, MIN_SHEAR = 3e-3
/** A 2D feature needs shear segments at this many range gates (1-1.5 km deep along the beam). */
const MIN_SEGMENTS = 3
/** Features of different tilts at most this far apart (m) belong to one vertical circulation; a gap of one tilt is allowed. */
const STACK_DISTANCE = 3000, TILT_GAP = 2
/** A detection must show on at least this many tilts and over this depth, m. */
export const MDA_MIN_TILTS = 3, MDA_MIN_DEPTH = 1500
/** A detection within this distance (m) of one in the previous scan is the same circulation. */
const TRACK_DISTANCE = 5000

/**
 * Strength from the rotational velocity, roughly the standard mesocyclone nomograph at ranges under ~50 km (25, 35 and
 * 45 kt for weak, moderate and strong); below it, a circulation too weak to be called a mesocyclone.
 */
export type MesoStrength = 'circulation' | 'weak' | 'moderate' | 'strong'
export const MESO_STRENGTH: Record<MesoStrength, { name: string; vrot: number }> = {
  circulation: { name: 'Циркуляция (ниже порога мезоциклона)', vrot: MDA_MIN_DV / 2 },
  weak: { name: 'Слабый мезоциклон', vrot: 12.5 },
  moderate: { name: 'Умеренный мезоциклон', vrot: 18 },
  strong: { name: 'Сильный мезоциклон', vrot: 23 },
}
export const mesoStrength = (vrot: number): MesoStrength => vrot >= MESO_STRENGTH.strong.vrot ? 'strong' : vrot >= MESO_STRENGTH.moderate.vrot ? 'moderate' : vrot >= MESO_STRENGTH.weak.vrot ? 'weak' : 'circulation'

/** A cyclonic shear feature on one tilt. */
export interface ShearFeature {
  tilt: number; x: number; y: number; range: number; azimuth: number; height: number
  /** Half the velocity difference across the strongest segment, m/s, and that segment's length, m. */ vrot: number; diameter: number
}

/** A circulation found on several tilts (MDA-style detection). */
export interface Circulation {
  id: number; born: number
  /** Ground position of the lowest feature, m from the domain corner; range (m) and azimuth (degrees) from the radar. */ x: number; y: number; range: number; azimuth: number
  /** Strongest rotational velocity of the stack, m/s, and the diameter there, m. */ vrot: number; diameter: number
  /** Rotational velocity of the lowest feature, m/s. */ lowVrot: number
  /** Heights of the lowest and highest feature, m, and the number of tilts. */ base: number; top: number; tilts: number
  strength: MesoStrength
  /** Hook echo around it at the lowest tilt, if there is one (see hookEcho). */ hook: HookEcho | null
  features: ShearFeature[]
}

/** Cyclonic shear segments of one range gate: runs of radial velocity increasing clockwise (inbound left, outbound right). */
function segments(v: Float32Array, gate: number, range: number) {
  const smooth = new Float32Array(BEAMS), arc = range * 2 * Math.PI / BEAMS, out: { b0: number; b1: number; dv: number; length: number }[] = []
  for (let b = 0; b < BEAMS; b++) {
    const a = v[((b + BEAMS - 1) % BEAMS) * GATES + gate], c = v[b * GATES + gate], d = v[((b + 1) % BEAMS) * GATES + gate]
    smooth[b] = Number.isNaN(c) ? NaN : Number.isNaN(a) || Number.isNaN(d) ? c : (a + 2 * c + d) / 4
  }
  // Start the circular walk where the velocity does not increase, so no run is cut at azimuth 0.
  let start = 0
  while (start < BEAMS && !Number.isNaN(smooth[start]) && smooth[(start + 1) % BEAMS] > smooth[start]) start++
  if (start === BEAMS) return out
  const maxBeams = Math.max(1, Math.floor(MAX_DIAMETER / arc))
  let run: number[] = [], start0 = 0
  const close = () => {
    // The strongest part of the run no longer than MAX_DIAMETER (the run increases monotonically).
    let best = { b0: 0, b1: 0, dv: 0 }
    for (let j = 1; j < run.length; j++) { const i = Math.max(0, j - maxBeams), dv = smooth[run[j]] - smooth[run[i]]; if (dv > best.dv) best = { b0: start0 + i, b1: start0 + j, dv } }
    const length = (best.b1 - best.b0) * arc
    if (best.dv >= MDA_MIN_DV && length > 0 && best.dv / length >= MIN_SHEAR) { const shift = best.b0 >= BEAMS ? BEAMS : 0; out.push({ b0: best.b0 - shift, b1: best.b1 - shift, dv: best.dv, length }) }
    run = []
  }
  for (let k = 1; k <= BEAMS; k++) {
    const b = (start + k) % BEAMS, prev = (start + k - 1) % BEAMS
    if (!Number.isNaN(smooth[b]) && !Number.isNaN(smooth[prev]) && smooth[b] > smooth[prev]) {
      if (!run.length) { run = [prev]; start0 = start + k - 1 }
      run.push(b)
    } else if (run.length) close()
  }
  if (run.length) close()
  return out
}

/** 2D features of one tilt: segments at neighbouring gates whose azimuth spans overlap. */
function features(ppi: PPI, tilt: number, velocity: Float32Array) {
  const segs: { gate: number; b0: number; b1: number; dv: number; length: number }[] = []
  for (let g = 0; g < GATES; g++) for (const s of segments(velocity, g, (g + 1) * STEP)) segs.push({ gate: g, ...s })
  const parent = segs.map((_, i) => i), root = (i: number): number => parent[i] === i ? i : (parent[i] = root(parent[i]))
  const overlap = (a: typeof segs[number], b: typeof segs[number]) => [-BEAMS, 0, BEAMS].some(s => a.b0 <= b.b1 + s && b.b0 + s <= a.b1)
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if (Math.abs(segs[i].gate - segs[j].gate) <= 2 && overlap(segs[i], segs[j])) parent[root(i)] = root(j)
  const groups = new Map<number, typeof segs>()
  segs.forEach((s, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), s]))
  const found: ShearFeature[] = []
  for (const group of groups.values()) {
    if (new Set(group.map(s => s.gate)).size < MIN_SEGMENTS) continue
    const best = group.reduce((a, b) => b.dv > a.dv ? b : a), range = (best.gate + 1) * STEP, azimuth = ((best.b0 + best.b1) / 2 * 360 / BEAMS) % 360, a = azimuth * Math.PI / 180
    found.push({ tilt, range, azimuth, x: ppi.site.x + range * Math.sin(a), y: ppi.site.y + range * Math.cos(a), height: beamHeight(range, tilt), vrot: best.dv / 2, diameter: best.length })
  }
  return found
}

/**
 * Mesocyclone detection on the radar's own data, after the NSSL Mesocyclone Detection Algorithm in outline: on every tilt,
 * shear segments (base velocity rising clockwise along a range gate by at least MDA_MIN_DV within 10 km), grouped across
 * neighbouring gates into 2D features, stacked across tilts into circulations at least MDA_MIN_DEPTH deep on MDA_MIN_TILTS
 * tilts. Detections are followed from scan to scan (`id`, `born`). It sees what a radar would: only where there is echo,
 * smoothed by the beam spacing and the ~1.2 km model grid, so rotational velocities come out lower than in nature.
 */
export class MesocycloneDetector {
  detections: Circulation[] = []
  private nextId = 1

  /** One volume scan; with the storm motion (u, v, m/s) hook echoes are checked against the inflow side. */
  scan(ppi: PPI, time: number, motion: readonly [number, number] | null = null) {
    ppi.prepare()
    const all: ShearFeature[] = []
    for (const tilt of RADAR_TILTS) all.push(...features(ppi, tilt, ppi.polar(tilt, STEP, GATES, BEAMS).velocity))
    // Stack from the lowest tilt up: each feature joins the nearest stack whose top is one or two tilts below.
    const stacks: ShearFeature[][] = []
    for (const f of all) {
      const level = RADAR_TILTS.indexOf(f.tilt as typeof RADAR_TILTS[number])
      let best: ShearFeature[] | null = null, bestD = STACK_DISTANCE
      for (const s of stacks) {
        const topF = s[s.length - 1], gap = level - RADAR_TILTS.indexOf(topF.tilt as typeof RADAR_TILTS[number]), d = Math.hypot(f.x - topF.x, f.y - topF.y)
        if (gap >= 1 && gap <= TILT_GAP && d < bestD) { bestD = d; best = s }
      }
      if (best) best.push(f); else stacks.push([f])
    }
    // The periodic world is seen more than once at long range (the same circulation one domain further), and a broad
    // mesocyclone gives several neighbouring stacks on a ~1 km grid. Strongest first, a stack within three quarters of the
    // mean diameter of a stronger one (at least STACK_DISTANCE) becomes part of it: its features extend that circulation,
    // and a lower base moves the circulation's position there (as in MDA, the position is that of the base). Merging repeats
    // until nothing moves, as a moved base can bring two circulations together. Positions are folded into the domain.
    const { width, depth } = ppi.model.grid, apart = (a: Circulation, b: Circulation) => Math.hypot(wrap(a.x - b.x, width), wrap(a.y - b.y, depth))
    const strongest = (s: ShearFeature[]) => s.reduce((a, b) => b.vrot > a.vrot ? b : a)
    let found: Circulation[] = stacks.filter(s => s.length >= MDA_MIN_TILTS && s[s.length - 1].height - s[0].height >= MDA_MIN_DEPTH).map(s => {
      const base = s[0], top = s[s.length - 1], peak = strongest(s)
      return {
        id: 0, born: time, x: mod(base.x, width), y: mod(base.y, depth), range: base.range, azimuth: base.azimuth, vrot: peak.vrot, diameter: peak.diameter,
        lowVrot: base.vrot, base: base.height, top: top.height, tilts: s.length, strength: mesoStrength(peak.vrot), features: [...s], hook: null,
      }
    }).sort((a, b) => b.vrot - a.vrot)
    for (let merged = true; merged;) {
      merged = false
      const kept: Circulation[] = []
      for (const c of found) {
        const host = kept.find(n => apart(n, c) < Math.max(STACK_DISTANCE, .75 * (n.diameter + c.diameter) / 2))
        if (!host) { kept.push(c); continue }
        merged = true
        host.features.push(...c.features); host.tilts = new Set(host.features.map(f => f.tilt)).size; host.top = Math.max(host.top, c.top)
        if (c.base < host.base) Object.assign(host, { base: c.base, lowVrot: c.lowVrot, x: c.x, y: c.y, range: c.range, azimuth: c.azimuth })
      }
      found = kept
    }
    // Numbers follow the circulations from scan to scan.
    const previous = this.detections
    for (const c of found) {
      const same = previous.find(p => Math.hypot(wrap(p.x - c.x, width), wrap(p.y - c.y, depth)) < TRACK_DISTANCE && !found.some(n => n.id === p.id))
      c.id = same?.id ?? this.nextId++; c.born = same?.born ?? time
      c.hook = hookEcho(ppi, c, motion)
    }
    this.detections = found
    return this.detections
  }
}

const mod = (a: number, n: number) => ((a % n) + n) % n
/** Shortest signed periodic difference. */
const wrap = (d: number, size: number) => d - size * Math.round(d / size)

/** Echo of a hook (dBZ) and of its inflow notch (below it): sectors around a circulation at the lowest tilt. */
export const HOOK_DBZ = 30, NOTCH_DBZ = 20
const HOOK_SECTORS = 24, HOOK_RADII = [1500, 2000, 2500, 3000, 3500]

/** A hook echo: precipitation wrapped around a circulation, as an arc of azimuths (degrees clockwise from north) from `from` over `span`. */
export interface HookEcho { x: number; y: number; radius: number; from: number; span: number }

/**
 * Hook echo at the lowest tilt around a low-level circulation (base ≤ 3 km): echo of at least HOOK_DBZ wraps around it
 * over 180-330°, and the gap left (the inflow notch, weaker than NOTCH_DBZ) faces the inflow, to the right of the storm
 * motion (within 75° of motion + 90°). In each 15° sector the mean echo (dBZ) 1.5-3.5 km from the centre counts (the
 * strongest would let the echo next to the centre fill the notch). With a
 * ~1.2 km model grid the appendage is a few grid columns wide: the check is of the geometry, not of fine structure.
 */
export function hookEcho(ppi: PPI, d: Pick<Circulation, 'x' | 'y' | 'base'>, motion: readonly [number, number] | null): HookEcho | null {
  if (d.base > 3000) return null
  const sectors = Array.from({ length: HOOK_SECTORS }, (_, s) => {
    const a = (s + .5) * 2 * Math.PI / HOOK_SECTORS
    return HOOK_RADII.reduce((sum, r) => sum + ppi.dbzAt(d.x + r * Math.sin(a), d.y + r * Math.cos(a), RADAR_TILTS[0]), 0) / HOOK_RADII.length
  })
  const echo = sectors.map(z => z >= HOOK_DBZ)
  if (echo.every(Boolean) || !echo.some(Boolean)) return null
  // The largest circular gap without echo.
  let gapStart = 0, gapLength = 0
  for (let s = 0; s < HOOK_SECTORS; s++) {
    if (echo[s] || !echo[(s + HOOK_SECTORS - 1) % HOOK_SECTORS]) continue
    let n = 0
    while (n < HOOK_SECTORS && !echo[(s + n) % HOOK_SECTORS]) n++
    if (n > gapLength) { gapLength = n; gapStart = s }
  }
  const step = 360 / HOOK_SECTORS, span = (HOOK_SECTORS - gapLength) * step
  if (span < 180 || span > 330) return null
  // A notch, not just weaker echo, and on the inflow side.
  const gap = Array.from({ length: gapLength }, (_, k) => sectors[(gapStart + k) % HOOK_SECTORS])
  if (Math.min(...gap) >= NOTCH_DBZ) return null
  if (motion && Math.hypot(...motion) > 2) {
    const inflow = Math.atan2(motion[0], motion[1]) * 180 / Math.PI + 90, centre = (gapStart + gapLength / 2) * step
    if (Math.abs(wrap(centre - inflow, 360)) > 75) return null
  }
  return { x: d.x, y: d.y, radius: 2500, from: ((gapStart + gapLength) * step) % 360, span }
}
