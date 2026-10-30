// How deep the updraught rotates: the profile of w ζ by height in the most rotating core, and the correlation of w and ζ
// over the domain at 2-6 km. In a supercell the updraught and the cyclonic vorticity coincide (Clark 1979, Droegemeier
// et al. 1993: correlations of 0.4 and more on finer grids); an ordinary storm has updraughts and vortices side by side (near 0).
import { L } from '../i18n'
import { MESO_PERSISTENCE, UH_MESOCYCLONE, UH_ROTATING, uhThreshold, type AtmosphereModel, type RotationState } from './model'

/** Layer of the w-ζ correlation, m. */
export const SPIN_FROM = 2000, SPIN_TO = 6000
/**
 * The correlation above which the rotation and the updraught coincide as in a supercell, on the ~1 km grid: calibration
 * 2026-10-11 (tests/bench/spin.ts), Weisman-Klemp 0.15-0.24 at 20-40 min, «Летний день» at most 0.08. Counting only the
 * updraught nodes gave no better contrast (0.16-0.38 against 0.06-0.11).
 */
export const SPIN_SUPERCELL = .15

export interface SpinProfile {
  /** Heights of the model levels, km, and the mean w ζ there (10⁻³ m/s²) over the 3 x 3 columns around the strongest UH. */
  z: Float64Array; wz: Float64Array
  /** Where the core rotates (w ζ above a tenth of its peak, w > 0): bottom and top, km (null without rotation). */
  bottom: number | null; top: number | null
  /** Correlation of w and ζ over the domain at SPIN_FROM-SPIN_TO (null in calm air). */
  correlation: number | null
}

export function spinProfile(m: Pick<AtmosphereModel, 'grid' | 'w' | 'zeta' | 'rotation'>): SpinProfile {
  const { nx, ny, nz, layer, zs } = m.grid, cx = m.rotation.x, cy = m.rotation.y, z = Float64Array.from(zs, h => h / 1000), wz = new Float64Array(nz)
  for (let k = 1; k < nz; k++) {
    let s = 0
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const x = (cx + ox + nx) % nx, y = (cy + oy + ny) % ny, w = m.w[x + nx * y + k * layer]
      if (w > 0) s += w * m.zeta(x, y, k)
    }
    wz[k] = s / 9 * 1000
  }
  let peak = 0
  for (const v of wz) peak = Math.max(peak, v)
  let bottom: number | null = null, top: number | null = null
  if (peak > 0) for (let k = 1; k < nz; k++) if (wz[k] > peak / 10) { bottom ??= z[k]; top = z[k] }
  // Pearson correlation of w and ζ over every node of the layer.
  let n = 0, sw = 0, sz = 0, sww = 0, szz = 0, swz = 0
  for (let k = 0; k < nz; k++) {
    if (zs[k] < SPIN_FROM || zs[k] > SPIN_TO) continue
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const w = m.w[x + nx * y + k * layer], zeta = m.zeta(x, y, k)
      n++; sw += w; sz += zeta; sww += w * w; szz += zeta * zeta; swz += w * zeta
    }
  }
  const vw = sww / n - (sw / n) ** 2, vz = szz / n - (sz / n) ** 2
  const correlation = vw > 1e-6 && vz > 1e-14 ? (swz / n - sw / n * sz / n) / Math.sqrt(vw * vz) : null
  return { z, wz, bottom, top, correlation }
}

/**
 * Low-level rotation that counts, UH m²/s² (calibration 2026-10-12, tests/bench/scout.ts, 45 min): over 0-3 km the
 * supercells reach 160-500 (HSLC, Weisman-Klemp, the plains supercell), ordinary storms at most ~50; over 0-1 km (one or
 * two levels of the grid) HSLC 25-40, the plains supercell 16-43, Weisman-Klemp 5-36 (growing late), ordinary storms <10.
 */
export const UH03_ROTATING = 100, UH01_LOW_MESO = 20

/** At what height the updraught rotates, in words: the mid-level mesocyclone (2-5 km), rotation reaching down, the low one. */
export function rotationSummary(r: Pick<RotationState, 'uh' | 'uh01' | 'uh03' | 'persisted' | 'uhScale'>, p: Pick<SpinProfile, 'bottom' | 'top'>) {
  const parts: string[] = []
  if (r.persisted >= MESO_PERSISTENCE) parts.push(L(`средний мезоциклон 2–5 км держится ${Math.floor(r.persisted / 60)} мин (UH ${r.uh.toFixed(0)})`, `a mid-level mesocyclone at 2–5 km has held for ${Math.floor(r.persisted / 60)} min (UH ${r.uh.toFixed(0)})`))
  else if (r.uh >= uhThreshold(UH_MESOCYCLONE, r)) parts.push(L(`сильное вращение на 2–5 км (UH ${r.uh.toFixed(0)}), мезоциклоном ещё не стало`, `strong rotation at 2–5 km (UH ${r.uh.toFixed(0)}), not a mesocyclone yet`))
  else if (r.uh >= uhThreshold(UH_ROTATING, r)) parts.push(L(`вращение на 2–5 км (UH ${r.uh.toFixed(0)})`, `rotation at 2–5 km (UH ${r.uh.toFixed(0)})`))
  if (r.uh01 >= uhThreshold(UH01_LOW_MESO, r)) parts.push(L(`низкий мезоциклон: поток вращается у самой земли (UH 0–1 км ${r.uh01.toFixed(0)}) — признак опасной по смерчам ячейки; сам смерч сетка ~1 км не разрешает`, `a low-level mesocyclone: the updraught rotates right at the ground (UH 0–1 km ${r.uh01.toFixed(0)}) — the sign of a cell that may produce tornadoes; the ~1 km grid does not resolve the tornado itself`))
  else if (r.uh03 >= uhThreshold(UH03_ROTATING, r)) parts.push(L(`вращение опускается ниже 3 км (UH 0–3 км ${r.uh03.toFixed(0)}), у земли пока слабое`, `the rotation reaches below 3 km (UH 0–3 km ${r.uh03.toFixed(0)}), still weak at the ground`))
  if (!parts.length) return L('поток не вращается', 'the updraught does not rotate')
  const text = parts.join('; ')
  return (p.bottom !== null ? `${text}; ${L('ядро вращается', 'the core rotates at')} ${p.bottom.toFixed(1)}–${p.top!.toFixed(1)} ${L('км', 'km')}` : text).replace(/^./, c => c.toUpperCase())
}
