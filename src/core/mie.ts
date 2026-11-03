/**
 * Mie scattering of homogeneous spheres (Bohren & Huffman 1983, Absorption and Scattering of Light by Small Particles,
 * appendix A, BHMIE: downward recurrence of the logarithmic derivative D_n(mx), upward of the Riccati-Bessel functions;
 * terms up to x + 4 x^(1/3) + 2). Only what a radar needs: the backscattering efficiency Q_b = sigma_b / (pi r²) and the
 * extinction and scattering efficiencies, for a size parameter x = pi D / lambda and a complex refractive index m.
 */

/** A complex number [re, im]. */
export type Complex = readonly [number, number]

const mul = (a: Complex, b: Complex): Complex => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]
const div = (a: Complex, b: Complex): Complex => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d] }
const add = (a: Complex, b: Complex): Complex => [a[0] + b[0], a[1] + b[1]]
const sub = (a: Complex, b: Complex): Complex => [a[0] - b[0], a[1] - b[1]]
const scale = (a: Complex, s: number): Complex => [a[0] * s, a[1] * s]

export interface MieEfficiencies { /** Backscattering. */ back: number; /** Extinction. */ ext: number; /** Scattering. */ sca: number }

/** Mie efficiencies of a sphere of size parameter x and refractive index m (Bohren & Huffman's BHMIE). */
export function mie(x: number, m: Complex): MieEfficiencies {
  const mx = scale(m, x), terms = Math.ceil(x + 4 * Math.cbrt(x) + 2), start = Math.ceil(Math.max(terms, Math.hypot(mx[0], mx[1]))) + 15
  // Logarithmic derivative D_n(mx) by downward recurrence: D_{n-1} = n/mx - 1 / (D_n + n/mx).
  const d: Complex[] = new Array(start + 1); d[start] = [0, 0]
  for (let n = start; n > 0; n--) { const nmx = div([n, 0], mx); d[n - 1] = sub(nmx, div([1, 0], add(d[n], nmx))) }
  // Riccati-Bessel psi_n(x) = x j_n(x) and xi_n(x) = x h_n(x) upward from n = -1, 0.
  let psi0 = Math.cos(x), psi1 = Math.sin(x), chi0 = -Math.sin(x), chi1 = Math.cos(x)
  let ext = 0, sca = 0, back: Complex = [0, 0]
  for (let n = 1; n <= terms; n++) {
    const psi = (2 * n - 1) / x * psi1 - psi0, chi = (2 * n - 1) / x * chi1 - chi0
    const xi: Complex = [psi, -chi], xi1: Complex = [psi1, -chi1]
    const da = add(div(d[n], m), [n / x, 0]), db = add(mul(m, d[n]), [n / x, 0])
    const a = div(sub(scale(da, psi), [psi1, 0]), sub(mul(da, xi), xi1))
    const b = div(sub(scale(db, psi), [psi1, 0]), sub(mul(db, xi), xi1))
    ext += (2 * n + 1) * (a[0] + b[0]); sca += (2 * n + 1) * (a[0] * a[0] + a[1] * a[1] + b[0] * b[0] + b[1] * b[1])
    back = add(back, scale(sub(a, b), (2 * n + 1) * (n % 2 ? -1 : 1)))
    psi0 = psi1; psi1 = psi; chi0 = chi1; chi1 = chi
  }
  const k = 2 / (x * x)
  return { back: (back[0] * back[0] + back[1] * back[1]) / (x * x), ext: k * ext, sca: k * sca }
}

/** |K|² = |(m² - 1) / (m² + 2)|² of a refractive index (the Rayleigh limit: Q_b -> 4 x⁴ |K|²). */
export function dielectricFactor(m: Complex) {
  const m2 = mul(m, m), k = div(sub(m2, [1, 0]), add(m2, [2, 0]))
  return k[0] * k[0] + k[1] * k[1]
}

/**
 * Refractive index of ice of density rho (kg/m³) mixed with air by Maxwell Garnett, air the matrix and ice the
 * inclusions (pytmatrix mi(); Wolfensberger & Berne 2018, AMT 11, 3883, eq. 21-22): in the Rayleigh limit exactly
 * |K|² = (rho / 917)² |K_ice|², the rule of the Rayleigh reflectivity in radar.ts. mIce: solid ice of 917 kg/m³.
 */
export function porousIce(mIce: Complex, rho: number): Complex {
  const f = Math.min(1, rho / 917), eIce = mul(mIce, mIce)
  // beta = (eps_ice - 1) / (eps_ice + 2), eps = (1 + 2 f beta) / (1 - f beta).
  const beta = div(sub(eIce, [1, 0]), add(eIce, [2, 0]))
  const e = div(add([1, 0], scale(beta, 2 * f)), sub([1, 0], scale(beta, f)))
  // Square root of the complex permittivity, the branch with a positive real part.
  const r = Math.hypot(e[0], e[1]), re = Math.sqrt((r + e[0]) / 2), im = Math.sign(e[1]) * Math.sqrt((r - e[0]) / 2)
  return [re, im]
}

/** Diameters of the size integrals, m: 0.2 mm steps to 12 cm (larger hail than that the model does not make). */
const MIE_STEP = 2e-4, MIE_DMAX = .12
/** Slopes of the exponential distributions tabulated, m^-1 (log-spaced; the mean diameter 1 / slope from 10 mm to 0.05 mm). */
const SLOPE_MIN = 100, SLOPE_MAX = 2e4, SLOPES = 96

/**
 * Mie over Rayleigh reflectivity of an exponential distribution N0 exp(-slope D) of spheres of refractive index m at
 * a wavelength (cm), tabulated against the slope: sum sigma_b(D) N(D) / sum sigma_b,Rayleigh(D) N(D), both over the same
 * diameters (N0 cancels). Returns a function of the slope (m^-1), log-interpolated, held at the table's ends.
 */
export function mieRatioTable(m: Complex, wavelength: number) {
  const lambda = wavelength / 100, k2 = dielectricFactor(m), n = Math.round(MIE_DMAX / MIE_STEP)
  const sigma = new Float64Array(n), rayleigh = new Float64Array(n)
  for (let j = 0; j < n; j++) {
    const d = (j + .5) * MIE_STEP, x = Math.PI * d / lambda
    sigma[j] = mie(x, m).back * Math.PI * d * d / 4
    rayleigh[j] = Math.PI ** 5 / lambda ** 4 * k2 * d ** 6
  }
  const table = new Float64Array(SLOPES), logMin = Math.log(SLOPE_MIN), logStep = Math.log(SLOPE_MAX / SLOPE_MIN) / (SLOPES - 1)
  for (let s = 0; s < SLOPES; s++) {
    const slope = Math.exp(logMin + s * logStep)
    let num = 0, den = 0
    for (let j = 0; j < n; j++) { const w = Math.exp(-slope * (j + .5) * MIE_STEP); num += sigma[j] * w; den += rayleigh[j] * w }
    table[s] = den > 0 ? num / den : 1
  }
  return (slope: number) => {
    const f = Math.min(SLOPES - 1, Math.max(0, (Math.log(slope) - logMin) / logStep)), s = Math.min(SLOPES - 2, Math.floor(f)), t = f - s
    return table[s] * (1 - t) + table[s + 1] * t
  }
}
