export interface GridOptions {
  nx: number; ny: number; nz: number
  /** Domain size, m. Horizontal boundaries are periodic; vertical levels span 0..height inclusive. */
  width: number; depth: number; height: number
}

export interface Grid extends GridOptions {
  n: number; layer: number
  dx: number; dy: number; dz: number
  /** Periodic neighbours: xp/xm hold x indices, yp/ym hold row offsets (y*nx). */
  xp: Int32Array; xm: Int32Array; yp: Int32Array; ym: Int32Array
}

export const DEFAULT_GRID: GridOptions = { nx: 40, ny: 32, nz: 24, width: 48_000, depth: 36_000, height: 15_000 }

export function createGrid(options: GridOptions = DEFAULT_GRID): Grid {
  const { nx, ny, nz, width, depth, height } = options
  return {
    ...options,
    n: nx * ny * nz, layer: nx * ny,
    dx: width / nx, dy: depth / ny, dz: height / (nz - 1),
    xp: Int32Array.from({ length: nx }, (_, x) => (x + 1) % nx),
    xm: Int32Array.from({ length: nx }, (_, x) => (x + nx - 1) % nx),
    yp: Int32Array.from({ length: ny }, (_, y) => (y + 1) % ny * nx),
    ym: Int32Array.from({ length: ny }, (_, y) => (y + ny - 1) % ny * nx),
  }
}
