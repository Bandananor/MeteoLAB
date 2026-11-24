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
const smooth = theory(d.terrain), stairs = theory(d.ground.map(g => d.zs[g]))
console.log(file, `flux theory smooth ${smooth.flux.toFixed(0)}, staircase ${stairs.flux.toFixed(0)}`)
d.levels.forEach((z, l) => {
  const model = d.w[l], line = [`z ${(d.zs[z] / 1000).toFixed(2)} km: model rms ${Math.sqrt(model.reduce((s, x) => s + x * x, 0) / nx).toFixed(4)}, flux ${d.flux[l].toFixed(0)}`]
  for (const [name, t] of [['smooth', smooth], ['stairs', stairs]] as const) {
    const ref = t.w(d.zs[z])
    let rr = 0, mr = 0, mm = 0
    for (let i = 0; i < nx; i++) { rr += ref[i] ** 2; mr += model[i] * ref[i]; mm += model[i] ** 2 }
    line.push(`${name}: rms ${Math.sqrt(rr / nx).toFixed(4)} corr ${(mr / Math.sqrt(mm * rr)).toFixed(3)} flux ratio ${(d.flux[l] / t.flux).toFixed(2)}`)
  }
  console.log(line.join(' | '))
})
