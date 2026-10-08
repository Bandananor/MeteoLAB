import { type Memory, PRIVATE_MEMORY } from './threads'

/**
 * Complex FFT of one length, any n: mixed-radix Cooley-Tukey (recursive decimation in time, as in KISS FFT) over the
 * factors 4, 2, 3, 5 and then any remaining primes (a prime factor p is a direct p-point DFT, so a prime n costs n^2
 * like the plain DFT). Replaced the matrix DFT on 2026-10-07: that took ~20 % of a model step on the 40 x 32 grid.
 */
export class FFT {
  readonly n: number
  /** exp(-2 pi i k / n). */
  private readonly twRe: Float64Array; private readonly twIm: Float64Array
  /** [radix, remaining length] pairs. */
  private readonly factors: number[] = []
  private readonly outRe: Float64Array; private readonly outIm: Float64Array
  private readonly scrRe: Float64Array; private readonly scrIm: Float64Array

  constructor(n: number) {
    this.n = n
    this.twRe = Float64Array.from({ length: n }, (_, k) => Math.cos(2 * Math.PI * k / n)); this.twIm = Float64Array.from({ length: n }, (_, k) => -Math.sin(2 * Math.PI * k / n))
    let rest = n, p = 4, largest = 1
    while (rest > 1) {
      while (rest % p) { p = p === 4 ? 2 : p === 2 ? 3 : p + 2; if (p * p > rest) p = rest }
      rest /= p; this.factors.push(p, rest); largest = Math.max(largest, p)
    }
    this.outRe = new Float64Array(n); this.outIm = new Float64Array(n); this.scrRe = new Float64Array(largest); this.scrIm = new Float64Array(largest)
  }

  /** In place: forward (exp(-i theta), sign -1) or unnormalised inverse (exp(+i theta), sign +1) transform of re/im[0..n). */
  transform(re: Float64Array, im: Float64Array, sign: -1 | 1) {
    const n = this.n
    if (n === 1) return
    // The inverse is the conjugate of the forward transform of the conjugate.
    if (sign > 0) for (let k = 0; k < n; k++) im[k] = -im[k]
    this.work(0, re, im, 0, 1, 0)
    for (let k = 0; k < n; k++) { re[k] = this.outRe[k]; im[k] = sign > 0 ? -this.outIm[k] : this.outIm[k] }
  }

  private work(out: number, re: Float64Array, im: Float64Array, src: number, stride: number, f: number) {
    const p = this.factors[f], m = this.factors[f + 1], oRe = this.outRe, oIm = this.outIm
    if (m === 1) for (let k = 0; k < p; k++) { oRe[out + k] = re[src + k * stride]; oIm[out + k] = im[src + k * stride] }
    else for (let k = 0; k < p; k++) this.work(out + k * m, re, im, src + k * stride, stride * p, f + 2)
    const n = this.n, twRe = this.twRe, twIm = this.twIm, sRe = this.scrRe, sIm = this.scrIm
    if (p === 2) {
      for (let u = 0, t = 0; u < m; u++, t += stride) {
        const a = out + u, b = a + m, c = twRe[t], s = twIm[t], xr = oRe[b] * c - oIm[b] * s, xi = oRe[b] * s + oIm[b] * c
        oRe[b] = oRe[a] - xr; oIm[b] = oIm[a] - xi; oRe[a] += xr; oIm[a] += xi
      }
      return
    }
    if (p === 4) {
      for (let u = 0, t = 0; u < m; u++, t += stride) {
        const a = out + u, b = a + m, c = b + m, d = c + m, t2 = 2 * t, t3 = 3 * t
        const r0 = oRe[b] * twRe[t] - oIm[b] * twIm[t], i0 = oRe[b] * twIm[t] + oIm[b] * twRe[t]
        const r1 = oRe[c] * twRe[t2] - oIm[c] * twIm[t2], i1 = oRe[c] * twIm[t2] + oIm[c] * twRe[t2]
        const r2 = oRe[d] * twRe[t3] - oIm[d] * twIm[t3], i2 = oRe[d] * twIm[t3] + oIm[d] * twRe[t3]
        const r5 = oRe[a] - r1, i5 = oIm[a] - i1, ra = oRe[a] + r1, ia = oIm[a] + i1, r3 = r0 + r2, i3 = i0 + i2, r4 = r0 - r2, i4 = i0 - i2
        oRe[c] = ra - r3; oIm[c] = ia - i3; oRe[a] = ra + r3; oIm[a] = ia + i3
        oRe[b] = r5 + i4; oIm[b] = i5 - r4; oRe[d] = r5 - i4; oIm[d] = i5 + r4
      }
      return
    }
    // Generic radix-p butterflies over the p sub-transforms of length m (stride * k < n, so one subtraction wraps t).
    for (let u = 0; u < m; u++) {
      for (let q = 0; q < p; q++) { sRe[q] = oRe[out + u + q * m]; sIm[q] = oIm[out + u + q * m] }
      for (let q1 = 0, k = u; q1 < p; q1++, k += m) {
        let a = sRe[0], b = sIm[0], t = 0
        const step = stride * k
        for (let q = 1; q < p; q++) { t += step; if (t >= n) t -= n; const c = twRe[t], s = twIm[t]; a += sRe[q] * c - sIm[q] * s; b += sRe[q] * s + sIm[q] * c }
        oRe[out + k] = a; oIm[out + k] = b
      }
    }
  }
}

/**
 * 2D discrete Fourier transform over x and y of a stack of horizontal layers (periodic nx * ny), as used by the exact
 * elliptic solvers. The input is real, so its spectrum is Hermitian: only x-wavenumbers 0..nx/2 are kept, the others are
 * their conjugates. Coefficients live in `re`/`im` at [layer * nx * ny + n * nx + m] for m <= nx/2.
 */
/** 2D DFT in x and y of every layer; layers are independent (helper threads each take some). */
export class HorizontalDFT {
  readonly re: Float64Array; readonly im: Float64Array
  /** Highest x-wavenumber kept. */
  readonly mh: number
  private readonly nx: number; private readonly ny: number
  private readonly fx: FFT; private readonly fy: FFT
  private readonly rowRe: Float64Array; private readonly rowIm: Float64Array

  /** `memory` and `name` place the spectra where helper threads see them (threads.ts). */
  constructor(nx: number, ny: number, layers: number, memory: Memory = PRIVATE_MEMORY, name = 'dft') {
    this.nx = nx; this.ny = ny; this.mh = Math.floor(nx / 2)
    this.fx = new FFT(nx); this.fy = new FFT(ny)
    this.re = memory.f64(`${name}Re`, nx * ny * layers); this.im = memory.f64(`${name}Im`, nx * ny * layers)
    this.rowRe = new Float64Array(Math.max(nx, ny)); this.rowIm = new Float64Array(Math.max(nx, ny))
  }

  /** Forward transform, exp(-i theta), of layers 0..layers-1 of `src` into re/im. */
  forward(src: ArrayLike<number>, layers: number) { this.forwardLayers(src, 0, layers) }

  /** Forward transform of layers k0..k1-1 only. */
  forwardLayers(src: ArrayLike<number>, k0: number, k1: number) {
    const { nx, ny, mh, re, im, rowRe, rowIm, fx, fy } = this, cl = nx * ny
    for (let k = k0; k < k1; k++) {
      const base = k * cl
      // Two real rows per complex transform, z = a + i b: A[m] = (Z[m] + conj Z[-m]) / 2, B[m] = (Z[m] - conj Z[-m]) / 2i.
      for (let j = 0; j < ny; j += 2) {
        const row = base + j * nx, pair = j + 1 < ny, row2 = row + nx
        for (let i = 0; i < nx; i++) { rowRe[i] = src[row + i]; rowIm[i] = pair ? src[row2 + i] : 0 }
        fx.transform(rowRe, rowIm, -1)
        for (let m = 0; m <= mh; m++) {
          const c = m ? nx - m : 0, zr = rowRe[m], zi = rowIm[m], cr = rowRe[c], ci = rowIm[c]
          re[row + m] = (zr + cr) / 2; im[row + m] = (zi - ci) / 2
          if (pair) { re[row2 + m] = (zi + ci) / 2; im[row2 + m] = (cr - zr) / 2 }
        }
      }
      for (let m = 0; m <= mh; m++) {
        for (let j = 0; j < ny; j++) { rowRe[j] = re[base + j * nx + m]; rowIm[j] = im[base + j * nx + m] }
        fy.transform(rowRe, rowIm, -1)
        for (let n = 0; n < ny; n++) { re[base + n * nx + m] = rowRe[n]; im[base + n * nx + m] = rowIm[n] }
      }
    }
  }

  /** Inverse transform, exp(+i theta), of re/im (consumed) into the real `dst`, normalised. */
  inverse(dst: { [i: number]: number }, layers: number) { this.inverseLayers(dst, 0, layers) }

  /** Inverse transform of layers k0..k1-1 only. */
  inverseLayers(dst: { [i: number]: number }, k0: number, k1: number) {
    const { nx, ny, mh, re, im, rowRe, rowIm, fx, fy } = this, cl = nx * ny
    for (let k = k0; k < k1; k++) {
      const base = k * cl
      for (let m = 0; m <= mh; m++) {
        for (let n = 0; n < ny; n++) { rowRe[n] = re[base + n * nx + m]; rowIm[n] = im[base + n * nx + m] }
        fy.transform(rowRe, rowIm, 1)
        for (let j = 0; j < ny; j++) { re[base + j * nx + m] = rowRe[j]; im[base + j * nx + m] = rowIm[j] }
      }
      // Two rows per complex transform again: Z = A + i B over the full Hermitian rows (wavenumbers above nx/2 are the
      // conjugates of those below); the real part is row j, the imaginary part row j + 1. The imaginary parts of
      // wavenumbers 0 and nx/2 drop out, as they must for a real field (else they would leak into the other row).
      for (let j = 0; j < ny; j += 2) {
        const row = base + j * nx, pair = j + 1 < ny, row2 = row + nx
        for (let m = 0; m < nx; m++) {
          const c = m <= mh ? m : nx - m, s = m <= mh ? 1 : -1, real = c === 0 || 2 * c === nx
          const ar = re[row + c], ai = real ? 0 : s * im[row + c], br = pair ? re[row2 + c] : 0, bi = pair && !real ? s * im[row2 + c] : 0
          rowRe[m] = ar - bi; rowIm[m] = ai + br
        }
        fx.transform(rowRe, rowIm, 1)
        for (let i = 0; i < nx; i++) { dst[row + i] = rowRe[i] / cl; if (pair) dst[row2 + i] = rowIm[i] / cl }
      }
    }
  }
}
