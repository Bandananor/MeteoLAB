export interface GridOptions {
  nx: number; ny: number; nz: number
  /** Domain size, m. Horizontal boundaries are periodic; vertical levels span 0..height inclusive. */
  width: number; depth: number; height: number
  /**
   * Optional stretched vertical grid: the spacing at the ground, m. The spacing then grows geometrically with height
   * so that nz levels span 0..height exactly. Absent: uniform levels.
   */
  bottomSpacing?: number
}

export interface Grid extends GridOptions {
  n: number; layer: number
  /** Horizontal spacing, m; dz is the mean vertical spacing (the spacing itself on a uniform grid). */
  dx: number; dy: number; dz: number
  /** True when every vertical spacing equals dz. */
  uniform: boolean
  /** Height of each node level, m (zs[0] = 0, zs[nz-1] = height). */
  zs: Float64Array
  /** Spacing between level k and k+1, m (length nz - 1). */
  dzs: Float64Array
  /** Height of the control volume each level owns, m: half the spacings on both sides (half a layer at ground and top). */
  hz: Float64Array
  /** Periodic neighbours: xp/xm hold x indices, yp/ym hold row offsets (y*nx). */
  xp: Int32Array; xm: Int32Array; yp: Int32Array; ym: Int32Array
}

// The top is at 18.9 km (dz 652 m as before) so strong storms overshoot the tropopause below the sponge, not into it.
export const DEFAULT_GRID: GridOptions = { nx: 40, ny: 32, nz: 30, width: 48_000, depth: 36_000, height: 18_900 }

/** Geometric stretching ratio r with bottom * (r^m - 1) / (r - 1) = height for m = nz - 1 intervals (bisection). */
function stretchRatio(bottom: number, height: number, intervals: number) {
  if (bottom * intervals >= height) return 1
  let lo = 1, hi = 2
  while (bottom * (hi ** intervals - 1) / (hi - 1) < height) hi *= 2
  for (let k = 0; k < 100; k++) { const mid = (lo + hi) / 2; if (bottom * (mid ** intervals - 1) / (mid - 1) < height) lo = mid; else hi = mid }
  return (lo + hi) / 2
}

export function createGrid(options: GridOptions = DEFAULT_GRID): Grid {
  const { nx, ny, nz, width, depth, height, bottomSpacing } = options
  const dz = height / (nz - 1), zs = new Float64Array(nz)
  if (bottomSpacing === undefined) for (let z = 0; z < nz; z++) zs[z] = z * dz
  else {
    const r = stretchRatio(bottomSpacing, height, nz - 1)
    for (let z = 1; z < nz; z++) zs[z] = zs[z - 1] + bottomSpacing * r ** (z - 1)
    // Round-off: the top lands exactly on `height`.
    for (let z = 1; z < nz; z++) zs[z] *= height / zs[nz - 1]
  }
  // On a uniform grid every spacing is exactly dz (differences of z * dz would differ from it in the last bit).
  const dzs = Float64Array.from({ length: nz - 1 }, (_, k) => bottomSpacing === undefined ? dz : zs[k + 1] - zs[k])
  const hz = Float64Array.from({ length: nz }, (_, k) => ((k > 0 ? dzs[k - 1] : 0) + (k < nz - 1 ? dzs[k] : 0)) / 2)
  return {
    ...options,
    n: nx * ny * nz, layer: nx * ny,
    dx: width / nx, dy: depth / ny, dz, uniform: bottomSpacing === undefined, zs, dzs, hz,
    xp: Int32Array.from({ length: nx }, (_, x) => (x + 1) % nx),
    xm: Int32Array.from({ length: nx }, (_, x) => (x + nx - 1) % nx),
    yp: Int32Array.from({ length: ny }, (_, y) => (y + 1) % ny * nx),
    ym: Int32Array.from({ length: ny }, (_, y) => (y + ny - 1) % ny * nx),
  }
}

/**
 * Fractional level index of the height zs[k] + shift (m), clamped to the column: a local search from level k, for
 * semi-Lagrangian departure points (a few levels at most per step).
 */
export function shiftedLevel(grid: Grid, k: number, shift: number) {
  const { zs, nz, dz, uniform } = grid
  if (uniform) return Math.min(Math.max(k + shift / dz, 0), nz - 1)
  const target = zs[k] + shift
  if (target <= 0) return 0
  if (target >= zs[nz - 1]) return nz - 1
  let j = k
  while (j > 0 && zs[j] > target) j--
  while (j < nz - 2 && zs[j + 1] < target) j++
  return j + (target - zs[j]) / (zs[j + 1] - zs[j])
}

/** Height, m, of a fractional level index (clamped to the column): zs interpolated linearly. */
export function heightAt(grid: Grid, level: number) {
  const { zs, nz } = grid
  if (level <= 0) return 0
  if (level >= nz - 1) return zs[nz - 1]
  const k = Math.floor(level)
  return zs[k] + (level - k) * (zs[k + 1] - zs[k])
}

/** Fractional level index of a height, m (clamped to the column): the inverse of zs. */
export function levelAt(grid: Grid, height: number) {
  const { zs, nz } = grid
  if (height <= 0) return 0
  if (height >= zs[nz - 1]) return nz - 1
  let k = 0
  while (zs[k + 1] < height) k++
  return k + (height - zs[k]) / (zs[k + 1] - zs[k])
}
