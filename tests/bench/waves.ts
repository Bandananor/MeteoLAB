// Mountain waves over a long ridge against linear theory (roadmap Д1 (ж)): a dry atmosphere of nearly constant N, a
// uniform 10 m/s westerly, no rotation, no surface fluxes or drag, periodic in x. The reference is the steady linear
// anelastic solution over the model's own ridge heights (after smoothing), by FFT in x: per wavenumber k,
// w = i k U h^ exp(z / 2H) exp(i m z), m = sgn(k) sqrt(N²/U² - k² - 1/4H²) (evanescent where negative), and the
// momentum flux integral over x = -rho0 U L sum |k| sqrt(N² - U²k² - U²/4H²) |h^|² (Smith 1979; Durran 2003).
// Usage: npx vite-node tests/bench/waves.ts agnesi|schar [hours] [h0 km] [norelax] [trop11] [sponge=<rate>]; every half
// hour it prints the flux at each level as a share of theory and the mean wind's drift; the averaged fields go to
// .bench/waves/<case>-<h0>….json, which tests/bench/waves-analyse.ts compares with theory over the smooth ridge, the
// staircase and two layers. The steady state takes long: the wide Agnesi components rise at U²k/N ~ 0.5 m/s, so 7 km
// settles only after ~9 h (the Schär ridge: ~3 h).
import { AtmosphereModel, createGrid, DT } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const kind = process.argv[2] ?? 'agnesi', hours = Number(process.argv[3] ?? (kind === 'agnesi' ? 3 : 2))
const schar = kind === 'schar', h0 = Number(process.argv[4] ?? (schar ? .25 : .1))
// Agnesi: a = 10 km on 2 km (hydrostatic, Na/U = 10); Schär: a = 5 km, λ = 4 km on 500 m.
const dx = schar ? 500 : 2000, nx = schar ? 240 : 200, ny = 4, U = 10
const grid = createGrid({ nx, ny, nz: 60, width: nx * dx, depth: ny * dx, height: 25_000, bottomSpacing: 100 })
const terrain = schar ? { kind: 'schar' as const, height: h0, width: 5, wavelength: 4 } : { kind: 'ridge' as const, height: h0, width: 10 }
// N = 0.01 up to the lid, dry, as in Schär et al. 2002: a sounding of theta0 exp(N² z / g) with hydrostatic pressure
// (Exner pi = 1 + g² / (cp theta0 N²) (exp(-N² z / g) - 1)). The slider profile (tropopause 11 km) doubles N above
// 11 km, a partial reflector (R ~ -0.36) whose reflection reaches the ground after 4-12 h and halves the steady drag
// (tests/bench/waves-analyse.ts two layers): that, and the startup's slow wide components, were the flux "fading aloft"
// (README 24.11.2026); trop11 keeps that profile.
const trop11 = process.argv.includes('trop11'), N0 = .01, TH0 = 288.15, CP = 1004.5, RD = 287.04, G = 9.81
const levels0 = Array.from({ length: 103 }, (_, k) => {
  const z = k * 250, th = TH0 * Math.exp(N0 * N0 * z / G), pi = 1 + G * G / (CP * TH0 * N0 * N0) * (Math.exp(-N0 * N0 * z / G) - 1)
  return { z, p: 1e5 * pi ** (CP / RD), t: th * pi - 273.15, td: null, u: U, v: 0, qv: 0 }
})
const config = {
  ...SUMMER_DAY, surfaceTemp: 15, lapseLow: 6.85, lapseMid: 7.15, lapseUpper: 7.55, tropopause: 11, stratoWarming: 0,
  rhSurface: 0, rhLow: 0, rhMid: 0, rhUpper: 0, wind0: U, wind05: U, wind1: U, wind3: U, wind6: U, wind10: U,
  windDir0: 270, windDir05: 270, windDir1: 270, windDir3: 270, windDir6: 270, windDir10: 270,
  solarMax: 0, bubble: 0, followStorm: false, microphysics: 'warm' as const, lightning: false, off: ['surface', 'coriolis'] as never, terrain,
  ...(trop11 ? {} : { sounding: { name: 'constant N', levels: levels0 } }),
}
const m = new AtmosphereModel(config as never, grid)
m.surfaceDrag = false
// norelax: no pull of the wind's departures to the environment (AtmosphereModel.windRelaxation, 1e-4 /s by default).
if (process.argv.includes('norelax')) m.windRelaxation = 0
// sponge=<rate>: the sponge's Rayleigh rate at the lid, s-1. Here .003 unless given: the model's .06 (AtmosphereModel.spongeRate)
// reflects part of the long mountain waves; .003 still takes all of them (attenuation e^-8 on the way up over the
// 11 km of the sponge at a vertical group velocity of 2 m/s) and rises over the wave's frequency only ~4 km in.
const sponge = process.argv.find(x => x.startsWith('sponge='))
m.spongeRate = sponge ? Number(sponge.slice(7)) : .003
const { nz, layer, zs } = grid, rho = m.env.rho, theta = m.env.theta
console.log(kind, 'h0', h0 * 1000, 'm, dx', dx, 'm, env u0', m.env.u[0].toFixed(2), 'v0', m.env.v[0].toFixed(2))
// N and the density scale height over the lowest 6 km.
const top6 = zs.findIndex(z => z >= 6000)
const N = Math.sqrt(9.81 * Math.log(theta[top6] / theta[0]) / zs[top6]), H = zs[top6] / Math.log(rho[0] / rho[top6])
console.log('N', N.toFixed(5), 'H', H.toFixed(0), 'Nh/U', (N * h0 * 1000 / U).toFixed(2))

// Ridge heights along x (row 0): the smooth form, or (STAIRS) the staircase the model sees, each column's wall node.
const stairs = process.argv.includes('stairs')
const h = Array.from({ length: nx }, (_, i) => stairs ? zs[m.groundLevel![i]] : m.terrainHeight![i])
console.log(stairs ? 'theory over the staircase (wall node heights)' : 'theory over the smooth heights')
const re = new Float64Array(nx), im = new Float64Array(nx)
for (let k = 0; k < nx; k++) for (let i = 0; i < nx; i++) { const ph = -2 * Math.PI * k * i / nx; re[k] += h[i] * Math.cos(ph) / nx; im[k] += h[i] * Math.sin(ph) / nx }
const kOf = (k: number) => 2 * Math.PI * (k <= nx / 2 ? k : k - nx) / grid.width
const reference = (z: number) => {
  const w = new Float64Array(nx)
  for (let k = 1; k < nx; k++) {
    const kk = kOf(k), m2 = N * N / (U * U) - kk * kk - 1 / (4 * H * H)
    // w^ = i k U h^ times the vertical structure: exp(i m z) propagating, exp(-mu z) evanescent.
    let fr: number, fi: number
    if (m2 > 0) { const mm = Math.sign(kk) * Math.sqrt(m2); fr = Math.cos(mm * z); fi = Math.sin(mm * z) } else { fr = Math.exp(-Math.sqrt(-m2) * z); fi = 0 }
    const a = Math.exp(z / (2 * H)), wr = -kk * U * im[k], wi = kk * U * re[k], cr = (wr * fr - wi * fi) * a, ci = (wr * fi + wi * fr) * a
    for (let i = 0; i < nx; i++) { const ph = 2 * Math.PI * k * i / nx; w[i] += cr * Math.cos(ph) - ci * Math.sin(ph) }
  }
  return w
}
let flux = 0
for (let k = 1; k < nx; k++) { const kk = kOf(k), s = N * N - U * U * kk * kk - U * U / (4 * H * H); if (s > 0) flux += Math.abs(kk) * Math.sqrt(s) * (re[k] ** 2 + im[k] ** 2) }
const theoryFlux = -rho[0] * U * grid.width * flux
const agnesiFlux = -Math.PI / 4 * rho[0] * N * U * (h0 * 1000) ** 2

// Run; average w and the flux rho0 u'w' over the last third.
const steps = Math.round(hours * 3600 / DT), from = Math.round(steps * 2 / 3)
const levels = [1000, 2000, 3000, 4000, 5000, 7000].map(z => zs.findIndex(s => s >= z))
const wMean = levels.map(() => new Float64Array(nx)), fluxMean = levels.map(() => 0)
let samples = 0, windowSamples = 0
// The flux of each half hour as a share of theory, level by level: is it still growing at the end (a transient)?
const window = levels.map(() => 0)
const t0 = performance.now()
for (let s = 0; s < steps; s++) {
  m.step(DT); m.time += DT
  if (s % 10 === 0) {
    const late = s >= from
    if (late) samples++
    windowSamples++
    levels.forEach((z, l) => {
      let f = 0
      for (let i = 0; i < nx; i++) { let w = 0, uw = 0; for (let j = 0; j < ny; j++) { const c = i + nx * j + z * layer; w += m.w[c]; uw += (m.u[c] - U) * m.w[c] } if (late) wMean[l][i] += w / ny; f += uw / ny }
      if (late) fluxMean[l] += rho[z] * f * dx
      window[l] += rho[z] * f * dx
    })
  }
  if ((s + 1) % 600 === 0) {
    console.log('t', ((s + 1) * DT / 60).toFixed(0), 'min, max w', Math.max(...m.w.subarray(levels[1] * layer, (levels[1] + 1) * layer)).toFixed(3), `${((performance.now() - t0) / (s + 1)).toFixed(0)} ms/step`,
      '| flux/theory', window.map(f => (f / windowSamples / theoryFlux).toFixed(2)).join(' '),
      // The domain-mean wind's departure from U at 0.1, 1, 3, 7, 12, 16 km (fluid nodes only): does the flow slow down?
      '| mean u - U', [100, 1000, 3000, 7000, 12_000, 16_000].map(zz => { const z = zs.findIndex(q => q >= zz); let su = 0, n = 0; for (let c = 0; c < layer; c++) if (!m.solid?.[c + z * layer]) { su += m.u[c + z * layer]; n++ } return (su / n - U).toFixed(3) }).join(' '))
    window.fill(0); windowSamples = 0
  }
}
import('node:fs').then(fs => fs.mkdirSync('.bench/waves', { recursive: true }) ?? fs.writeFileSync(`.bench/waves/${kind}-${h0}${process.argv.includes('norelax') ? '-norelax' : ''}${trop11 ? '-trop11' : ''}${sponge ? '-' + sponge : ''}.json`, JSON.stringify({ zs: Array.from(zs), levels, ground: Array.from(m.groundLevel!.subarray(0, nx)), terrain: Array.from(m.terrainHeight!.subarray(0, nx)), w: wMean.map(a => Array.from(a, x => x / samples)), flux: fluxMean.map(x => x / samples), N, H, rho0: rho[0] })))
console.log(`momentum flux integral, kg/s2: linear theory over the model's h ${theoryFlux.toFixed(0)}${schar ? '' : `, Agnesi formula ${agnesiFlux.toFixed(0)}`}`)
levels.forEach((z, l) => {
  const model = wMean[l].map(x => x / samples), ref = reference(zs[z])
  // The model's w with the shortest waves (shorter than 4 dx) taken out: is the misfit grid-scale noise?
  const smooth = model.map((_, i) => (model[(i + nx - 1) % nx] + 2 * model[i] + model[(i + 1) % nx]) / 4)
  let noise = 0
  for (let i = 0; i < nx; i++) noise += (model[i] - smooth[i]) ** 2
  let mm = 0, rr = 0, mr = 0, err = 0, sm = 0, smr = 0
  for (let i = 0; i < nx; i++) { mm += model[i] ** 2; rr += ref[i] ** 2; mr += model[i] * ref[i]; err += (model[i] - ref[i]) ** 2; sm += smooth[i] ** 2; smr += smooth[i] * ref[i] }
  console.log(`   grid-scale part rms ${Math.sqrt(noise / nx).toFixed(4)}; smoothed: rms ${Math.sqrt(sm / nx).toFixed(4)} correlation ${(smr / Math.sqrt(sm * rr)).toFixed(3)}`)
  console.log(`z ${(zs[z] / 1000).toFixed(2)} km: rms w model ${Math.sqrt(mm / nx).toFixed(4)} theory ${Math.sqrt(rr / nx).toFixed(4)}, correlation ${(mr / Math.sqrt(mm * rr)).toFixed(3)}, rel. error ${Math.sqrt(err / rr).toFixed(2)}; flux ${(fluxMean[l] / samples).toFixed(0)} (${(fluxMean[l] / samples / theoryFlux).toFixed(2)} of theory)`)
})
