// npx vite-node tests/bench/waves-analyse.ts .bench/waves/<case>.json: reads the output of waves.ts and compares the model's time-mean w with linear theory over the smooth
// ridge and over the staircase the model sees (each column's wall node height): rms, correlation, momentum flux.
import { readFileSync } from 'node:fs'

const file = process.argv[2], d = JSON.parse(readFileSync(file, 'utf8')) as { zs: number[]; levels: number[]; ground: number[]; terrain: number[]; w: number[][]; flux: number[]; N: number; H: number; rho0: number }
const nx = d.terrain.length, dx = file.includes('schar') ? 500 : 2000, L = nx * dx, U = 10, { N, H } = d
const spectrum = (h: number[]) => {
  const re = new Float64Array(nx), im = new Float64Array(nx)
  for (let k = 0; k < nx; k++) for (let i = 0; i < nx; i++) { const ph = -2 * Math.PI * k * i / nx; re[k] += h[i] * Math.cos(ph) / nx; im[k] += h[i] * Math.sin(ph) / nx }
  return { re, im }
}
const kOf = (k: number) => 2 * Math.PI * (k <= nx / 2 ? k : k - nx) / L
const theory = (h: number[]) => {
  const { re, im } = spectrum(h)
  let flux = 0
  for (let k = 1; k < nx; k++) { const kk = kOf(k), s = N * N - U * U * kk * kk - U * U / (4 * H * H); if (s > 0) flux += Math.abs(kk) * Math.sqrt(s) * (re[k] ** 2 + im[k] ** 2) }
  const w = (z: number) => {
    const out = new Float64Array(nx)
    for (let k = 1; k < nx; k++) {
      const kk = kOf(k), m2 = N * N / (U * U) - kk * kk - 1 / (4 * H * H)
      let fr: number, fi: number
      if (m2 > 0) { const mm = Math.sign(kk) * Math.sqrt(m2); fr = Math.cos(mm * z); fi = Math.sin(mm * z) } else { fr = Math.exp(-Math.sqrt(-m2) * z); fi = 0 }
      const a = Math.exp(z / (2 * H)), wr = -kk * U * im[k], wi = kk * U * re[k], cr = (wr * fr - wi * fi) * a, ci = (wr * fi + wi * fr) * a
      for (let i = 0; i < nx; i++) { const ph = 2 * Math.PI * k * i / nx; out[i] += cr * Math.cos(ph) - ci * Math.sin(ph) }
    }
    return out
  }
  return { flux: -d.rho0 * U * L * flux, w }
}
// The bench's profile has its tropopause at 11 km: N doubles there (0.0101 -> 0.0214, density scale height 9.8 ->
// 6.1 km), a partial reflector (hydrostatic R = (N1 - N2) / (N1 + N2) ~ -0.36) whose reflection reaches the ground after
// a few hours. Two layers, smooth heights: below D w~ = A e^(q1 z) + B e^(-q1 z), above C e^(q2 (z - D)) radiating
// (q = i sgn(k) m, or -mu where evanescent), w~ and w~' continuous at D (w~ = w e^(-z/2H)); w~(0) = i k U h^. The flux
// is the transmitted one, -rho0 L sum m2 |C|² / |k| (the single layer's formula with |w~(0)|² = k² U² |h^|²).
const arg = (name: string, fallback: number) => Number(process.argv.find(a => a.startsWith(name + '='))?.slice(name.length + 1) ?? fallback)
const N2 = arg('n2', .0214), H2 = arg('h2', 6121), D = arg('d', 11_000)
const twoLayer = (h: number[]) => {
  const { re, im } = spectrum(h)
  type C = [number, number]
  const mul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]], div = (a: C, b: C): C => { const s = b[0] ** 2 + b[1] ** 2; return [(a[0] * b[0] + a[1] * b[1]) / s, (a[1] * b[0] - a[0] * b[1]) / s] }
  const add = (a: C, b: C): C => [a[0] + b[0], a[1] + b[1]], ex = (a: C): C => { const r = Math.exp(a[0]); return [r * Math.cos(a[1]), r * Math.sin(a[1])] }, neg = (a: C): C => [-a[0], -a[1]]
  const q = (kk: number, n: number, hh: number): C => { const m2 = n * n / (U * U) - kk * kk - 1 / (4 * hh * hh); return m2 > 0 ? [0, Math.sign(kk) * Math.sqrt(m2)] : [-Math.sqrt(-m2), 0] }
  const A: C[] = [], B: C[] = []
  let flux = 0
  for (let k = 1; k < nx; k++) {
    const kk = kOf(k), q1 = q(kk, N, H), q2 = q(kk, N2, H2), r = div(q2, q1), W0: C = [-kk * U * im[k], kk * U * re[k]]
    const plus: C = [(1 + r[0]) / 2, r[1] / 2], minus: C = [(1 - r[0]) / 2, -r[1] / 2], eD = ex([q1[0] * D, q1[1] * D]), eDm = ex(neg([q1[0] * D, q1[1] * D]))
    const Cc = div(W0, add(mul(plus, eDm), mul(minus, eD)))
    A[k] = mul(mul(Cc, plus), eDm); B[k] = mul(mul(Cc, minus), eD)
    if (q2[0] === 0) flux += Math.abs(q2[1]) * (Cc[0] ** 2 + Cc[1] ** 2) / Math.abs(kk)
    A[k + nx] = q1
  }
  const w = (z: number) => {
    const out = new Float64Array(nx), a = Math.exp(z / (2 * H))
    for (let k = 1; k < nx; k++) {
      const q1 = A[k + nx], c = add(mul(A[k], ex([q1[0] * z, q1[1] * z])), mul(B[k], ex(neg([q1[0] * z, q1[1] * z]))))
      for (let i = 0; i < nx; i++) { const ph = 2 * Math.PI * k * i / nx; out[i] += a * (c[0] * Math.cos(ph) - c[1] * Math.sin(ph)) }
    }
    return out
  }
  return { flux: -d.rho0 * L * flux, w }
}
const smooth = theory(d.terrain), stairs = theory(d.ground.map(g => d.zs[g])), layers = twoLayer(d.terrain)
console.log(file, `flux theory smooth ${smooth.flux.toFixed(0)}, staircase ${stairs.flux.toFixed(0)}, two layers (N2 ${N2}, H2 ${H2}, D ${D}) ${layers.flux.toFixed(0)}`)
d.levels.forEach((z, l) => {
  const model = d.w[l], line = [`z ${(d.zs[z] / 1000).toFixed(2)} km: model rms ${Math.sqrt(model.reduce((s, x) => s + x * x, 0) / nx).toFixed(4)}, flux ${d.flux[l].toFixed(0)}`]
  for (const [name, t] of [['smooth', smooth], ['stairs', stairs], ['2 layers', layers]] as const) {
    const ref = t.w(d.zs[z])
    let rr = 0, mr = 0, mm = 0
    for (let i = 0; i < nx; i++) { rr += ref[i] ** 2; mr += model[i] * ref[i]; mm += model[i] ** 2 }
    line.push(`${name}: rms ${Math.sqrt(rr / nx).toFixed(4)} corr ${(mr / Math.sqrt(mm * rr)).toFixed(3)} flux ratio ${(d.flux[l] / t.flux).toFixed(2)}`)
  }
  console.log(line.join(' | '))
})
