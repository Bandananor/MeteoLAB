/**
 * 2D discrete Fourier transform over x and y of a stack of horizontal layers (periodic nx * ny), as used by the exact
 * elliptic solvers. The input is real, so its spectrum is Hermitian: only x-wavenumbers 0..nx/2 are kept, the others are
 * their conjugates. Coefficients live in `re`/`im` at [layer * nx * ny + n * nx + m] for m <= nx/2.
 */
export class HorizontalDFT {
  readonly re: Float64Array; readonly im: Float64Array
  /** Highest x-wavenumber kept. */
  readonly mh: number
  private readonly nx: number; private readonly ny: number
  private readonly cosX: Float64Array; private readonly sinX: Float64Array
  private readonly cosY: Float64Array; private readonly sinY: Float64Array
  private readonly rowRe: Float64Array; private readonly rowIm: Float64Array

  constructor(nx: number, ny: number, layers: number) {
    this.nx = nx; this.ny = ny; this.mh = Math.floor(nx / 2)
    const table = (n: number, f: (a: number) => number) => { const t = new Float64Array(n * n); for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) t[a * n + b] = f(2 * Math.PI * ((a * b) % n) / n); return t }
    this.cosX = table(nx, Math.cos); this.sinX = table(nx, Math.sin); this.cosY = table(ny, Math.cos); this.sinY = table(ny, Math.sin)
    this.re = new Float64Array(nx * ny * layers); this.im = new Float64Array(nx * ny * layers)
    this.rowRe = new Float64Array(Math.max(nx, ny)); this.rowIm = new Float64Array(Math.max(nx, ny))
  }

  /** Forward transform, exp(-i theta), of layers 0..layers-1 of `src` into re/im. */
  forward(src: ArrayLike<number>, layers: number) {
    const { nx, ny, mh, re, im, rowRe, rowIm, cosX, sinX, cosY, sinY } = this, cl = nx * ny
    for (let k = 0; k < layers; k++) {
      const base = k * cl
      for (let j = 0; j < ny; j++) {
        const row = base + j * nx
        for (let m = 0; m <= mh; m++) { let a = 0, b = 0; for (let i = 0; i < nx; i++) { const x = src[row + i], t = m * nx + i; a += x * cosX[t]; b -= x * sinX[t] } rowRe[m] = a; rowIm[m] = b }
        for (let m = 0; m <= mh; m++) { re[row + m] = rowRe[m]; im[row + m] = rowIm[m] }
      }
      for (let m = 0; m <= mh; m++) {
        for (let n = 0; n < ny; n++) { let a = 0, b = 0; for (let j = 0; j < ny; j++) { const x = re[base + j * nx + m], y = im[base + j * nx + m], t = n * ny + j, c = cosY[t], s = sinY[t]; a += x * c + y * s; b += y * c - x * s } rowRe[n] = a; rowIm[n] = b }
        for (let n = 0; n < ny; n++) { re[base + n * nx + m] = rowRe[n]; im[base + n * nx + m] = rowIm[n] }
      }
    }
  }

  /** Inverse transform, exp(+i theta), of re/im (consumed) into the real `dst`, normalised. */
  inverse(dst: { [i: number]: number }, layers: number) {
    const { nx, ny, mh, re, im, rowRe, rowIm, cosX, sinX, cosY, sinY } = this, cl = nx * ny
    for (let k = 0; k < layers; k++) {
      const base = k * cl
      for (let m = 0; m <= mh; m++) {
        for (let j = 0; j < ny; j++) { let a = 0, b = 0; for (let n = 0; n < ny; n++) { const x = re[base + n * nx + m], y = im[base + n * nx + m], t = j * ny + n, c = cosY[t], s = sinY[t]; a += x * c - y * s; b += y * c + x * s } rowRe[j] = a; rowIm[j] = b }
        for (let j = 0; j < ny; j++) { re[base + j * nx + m] = rowRe[j]; im[base + j * nx + m] = rowIm[j] }
      }
      for (let j = 0; j < ny; j++) {
        const row = base + j * nx
        // Wavenumbers strictly between 0 and nx/2 stand for themselves and their conjugate partner (weight 2).
        for (let i = 0; i < nx; i++) {
          let a = 0
          for (let m = 0; m <= mh; m++) { const t = i * nx + m, weight = m === 0 || 2 * m === nx ? 1 : 2; a += weight * (re[row + m] * cosX[t] - im[row + m] * sinX[t]) }
          dst[row + i] = a / cl
        }
      }
    }
  }
}
