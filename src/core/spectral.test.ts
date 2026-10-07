import { describe, expect, it } from 'vitest'
import { FFT, HorizontalDFT } from './spectral'

let seed = 12345
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - .5

describe('FFT', () => {
  // All small lengths (primes, powers of 2 and 4, mixed) and the model's grid sizes.
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 32, 40, 64, 80]) it(`matches the direct DFT for n = ${n}, both ways`, () => {
    const re = Float64Array.from({ length: n }, random), im = Float64Array.from({ length: n }, random), fRe = re.slice(), fIm = im.slice()
    new FFT(n).transform(fRe, fIm, -1)
    for (let k = 0; k < n; k++) {
      let a = 0, b = 0
      for (let j = 0; j < n; j++) { const t = -2 * Math.PI * j * k / n; a += re[j] * Math.cos(t) - im[j] * Math.sin(t); b += re[j] * Math.sin(t) + im[j] * Math.cos(t) }
      expect(fRe[k]).toBeCloseTo(a, 10); expect(fIm[k]).toBeCloseTo(b, 10)
    }
    new FFT(n).transform(fRe, fIm, 1)
    for (let k = 0; k < n; k++) { expect(fRe[k] / n).toBeCloseTo(re[k], 12); expect(fIm[k] / n).toBeCloseTo(im[k], 12) }
  })
})

describe('HorizontalDFT', () => {
  for (const [nx, ny] of [[1, 1], [4, 1], [5, 3], [8, 6], [40, 32]]) it(`keeps the Hermitian half spectrum and inverts exactly on ${nx}x${ny}`, () => {
    const layers = 2, src = Float64Array.from({ length: nx * ny * layers }, random), dft = new HorizontalDFT(nx, ny, layers), out = new Float64Array(src.length)
    dft.forward(src, layers)
    // One coefficient against the definition: (m, n) = (mh, 1) of the second layer.
    const m = dft.mh, n = Math.min(1, ny - 1), base = nx * ny
    let a = 0, b = 0
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const t = -2 * Math.PI * (m * x / nx + n * y / ny), v = src[base + x + nx * y]; a += v * Math.cos(t); b += v * Math.sin(t) }
    expect(dft.re[base + n * nx + m]).toBeCloseTo(a, 10); expect(dft.im[base + n * nx + m]).toBeCloseTo(b, 10)
    dft.inverse(out, layers)
    for (let i = 0; i < src.length; i++) expect(out[i]).toBeCloseTo(src[i], 12)
  })
})
