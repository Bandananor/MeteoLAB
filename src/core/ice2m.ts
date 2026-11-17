// Two-moment graupel and hail after the NSSL scheme (Mansell, Ziegler & Bruning 2010, JAS 67, 171), Э1 step 2
// (17.11.2026): mass q, number N and particle volume V (all per kg of air) of graupel and of hail, ported from CM1's
// src/module_mp_nssl_2mom.F (MIT; .claude/literature/nssl-2m-graupel-hail.md). The particle density is V's: rho q / V
// bounded to 170-900 kg/m3 for graupel, 500-900 for hail; rime grows it at the density of Heymsfield & Pflaum (1985),
// wet growth and soaking at 900. Gamma size distributions in diameter (alpha 0 graupel, 1 hail), the mass-weighted
// diameter bounded to 20 and 40 mm; fall speeds a(rho) D^b(rho) from the table of Milbrandt & Morrison (2013);
// collection with the Seifert & Beheng (2006) coefficients; wet growth and shedding; melting into drops of the melted
// particles' size; graupel turning into hail where its largest particles pass the diameter of the onset of wet growth
// (Farley & Orville 1986); rain freezing (Bigg) into graupel; deposition and sublimation. Cloud ice and snow stay our
// one-moment ones (exponential snow of intercept N0S); the cloud droplets' number is rain2m.ts's fixed one.
// Deliberate departures from the code as read: the shed-drop volume uses π/6 (the code reads 6/π), the rain-rime density
// takes the bounds of the cloud-rime one (as the code does, likely by accident: kept), the fall-speed table index is
// bounded at its last row (850 kg/m3). After the numerics review (17.11.2026): the rain freezing is Bigg's rate (the
// freezing probability of a drop proportional to its volume, as Lin's P_gfr and NSSL's ibiggopt 1) at all T < 0 instead
// of the whole tail past a Bigg diameter each step (that went as 1/dt and made no graupel above -17.5 °C); graupel turns
// into hail at the tail's share per HAIL_TIME (NSSL takes it per step: 1/dt); the latent heats of the theta changes are
// the model's constants LF, LS (the temperature-dependent ones stay in the rates), so freezing and melting close.
import { CP } from './constants'
import { LF, LS, N0S, qsatIce, RHO_S, T0 } from './ice'
import { boundedNumber as boundedDrops, CLOUD_DROPLETS, fallSpeeds as rainSpeeds, meanVolume as rainVolume, RAIN_MIN, RHO_00, RHO_W, XV_MAX as RAIN_XV_MAX } from './rain2m'

/** Lanczos approximation of the gamma function (g 7, 9 terms; relative error ~1e-15 for x > 0). */
export function gammaFn(x: number): number {
  if (x < .5) return Math.PI / (Math.sin(Math.PI * x) * gammaFn(1 - x))
  const c = [.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  x -= 1
  let a = c[0]; const t = x + 7.5
  for (let k = 1; k < 9; k++) a += c[k] / (x + k)
  return Math.sqrt(2 * Math.PI) * t ** (x + .5) * Math.exp(-t) * a
}

/** The regularized upper incomplete gamma Q(n, x) for whole n: e^-x Σ_{k<n} x^k / k! (the share of a gamma tail). */
export function upperGamma(n: number, x: number) {
  if (x <= 0) return 1
  let term = 1, sum = 1
  for (let k = 1; k < n; k++) { term *= x / k; sum += term }
  return Math.exp(-x) * sum
}

/** A two-moment ice class: shape, density bounds, the density without a volume, the bounds of the mean-volume diameter. */
export interface IceClass { alpha: number; rhoMin: number; rhoMax: number; rhoNone: number; dMin: number; dMax: number }
export const GRAUPEL_2M: IceClass = { alpha: 0, rhoMin: 170, rhoMax: 900, rhoNone: 500, dMin: .3e-3, dMax: 20e-3 }
export const HAIL_2M: IceClass = { alpha: 1, rhoMin: 500, rhoMax: 900, rhoNone: 800, dMin: .3e-3, dMax: 40e-3 }
/** Bigg (1953) freezing constants as Lin (1983): B' m^-3 s^-1, A' 1/K. */
const BIGG_B = 100, BIGG_A = .66
/** Time scale of graupel turning into hail: the tail past the wet-growth onset diameter per this many seconds (NSSL: per step of ~3 s). */
export const HAIL_TIME = 3
/** Lin's (1983) snow-to-graupel conversion: rate 1e-3 exp(0.09 Tc) above this much snow, kg/kg; new graupel at this density. */
const SNOW_GRAUPEL = 6e-4, SNOW_GRAUPEL_DENSITY = 250
/** Below this much of a class (kg/kg) a node has none. */
export const ICE2M_MIN = 1e-12

/** Γ ratios of a class's shape: (3+α)(2+α)(1+α) and the reflectivity factor (α+6)(α+5)(α+4) / that. */
const shape3 = (a: number) => (3 + a) * (2 + a) * (1 + a)
export const reflectivityFactor = (a: number) => (6 + a) * (5 + a) * (4 + a) / shape3(a)

/** The particle density of a class, kg/m3: q / V bounded (V per kg of air, m3). */
export function densityOf(c: IceClass, q: number, vol: number) { return vol > 0 && q > 0 ? Math.min(c.rhoMax, Math.max(c.rhoMin, q / vol)) : c.rhoNone }

/** The bounded mean particle volume, m3: 0.3 mm up to the mass-weighted diameter of dMax (NSSL imaxdiaopt 3). */
export function meanVolumeOf(c: IceClass, q: number, n: number, rhoX: number) {
  const lo = Math.PI / 6 * c.dMin ** 3, hi = Math.PI / 6 * c.dMax ** 3 / ((4 + c.alpha) ** 3 / shape3(c.alpha))
  return Math.min(hi, Math.max(lo, q / (rhoX * Math.max(n, 1e-30))))
}

/** The bounded number per kg; without a number, particles of 1 mm (the mass kept). */
export function boundedIceNumber(c: IceClass, q: number, n: number, vol: number) {
  if (!(q > ICE2M_MIN)) return 0
  const rhoX = densityOf(c, q, vol)
  if (!(n > 0)) n = q / (rhoX * Math.PI / 6 * 1e-9)
  return q / (rhoX * meanVolumeOf(c, q, n, rhoX))
}

/** Dn (m), the distribution's characteristic diameter, from the mean volume. */
export const characteristic = (c: IceClass, xv: number) => Math.cbrt(6 * xv / Math.PI) / Math.cbrt(shape3(c.alpha))

/** Fall-speed law V = a D^b of rimed ice by density (Milbrandt & Morrison 2013, the NSSL table mmgraupvt), D in m. */
const MM_RHO = [50, 150, 250, 350, 450, 550, 650, 750, 850]
const MM_A = [62.923, 94.122, 114.74, 131.21, 145.26, 157.71, 168.98, 179.36, 189.02]
const MM_B = [.67819, .63789, .62197, .61240, .60572, .60066, .59663, .59330, .59048]
export function fallLaw(rhoX: number): [number, number] {
  const k = Math.min(MM_RHO.length - 2, Math.max(0, Math.floor((rhoX - 50) / 100))), f = Math.max(0, (rhoX - MM_RHO[k]) / 100)
  return [MM_A[k] + f * (MM_A[k + 1] - MM_A[k]), MM_B[k] + f * (MM_B[k + 1] - MM_B[k])]
}

/** The k-th-moment-weighted fall speed (k 3 mass, 0 number, 6 reflectivity), m/s: rhovt a Dn^b Γ(k+1+α+b) / Γ(k+1+α). */
export function momentSpeed(c: IceClass, q: number, n: number, vol: number, rho: number, k: number) {
  if (!(q > ICE2M_MIN) || !(n > 0)) return 0
  const rhoX = densityOf(c, q, vol), dn = characteristic(c, meanVolumeOf(c, q, n, rhoX)), [a, b] = fallLaw(rhoX)
  return Math.min(70, Math.sqrt(RHO_00 / Math.max(.05, rho)) * a * dn ** b * gammaFn(k + 1 + c.alpha + b) / gammaFn(k + 1 + c.alpha))
}

/**
 * The largest particles (m): the diameter beyond which thresh 5e-4 per m3 remain (NSSL hailmaxd): Q(1+α, D/Dn) = thresh / N.
 */
export function largestDiameter(c: IceClass, q: number, n: number, vol: number, rho: number) {
  const thresh = 5e-4, nm3 = rho * n
  if (!(q > 1e-9) || !(nm3 > thresh)) return 0
  const rhoX = densityOf(c, q, vol), dn = characteristic(c, meanVolumeOf(c, q, n, rhoX)), target = thresh / nm3
  let lo = 0, hi = 200
  for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (upperGamma(1 + c.alpha, mid) > target) lo = mid; else hi = mid }
  return (lo + hi) / 2 * dn
}

// Seifert & Beheng (2006) collection coefficients for classes in mass space: nu = (α - 2) / 3, mu = 1/3 for a gamma
// in diameter; cloud droplets nu = 0, mu = 1 (gamma in volume); bb = 1/3 (D ∝ x^1/3).
interface MassShape { nu: number; mu: number }
const DIAMETER = (alpha: number): MassShape => ({ nu: (alpha - 2) / 3, mu: 1 / 3 }), DROPLETS: MassShape = { nu: 0, mu: 1 }, EXPONENTIAL = DIAMETER(0)
/** The two classes with their fields, for the final bounding. */
const BOUNDED = (f: Ice2mFields) => [[GRAUPEL_2M, f.graupel, f.graupelNumber, f.graupelVolume], [HAIL_2M, f.hail, f.hailNumber, f.hailVolume]] as const
const BB = 1 / 3
function delbk(s: MassShape, k: number) {
  const x1 = gammaFn((1 + s.nu) / s.mu), x2 = gammaFn((2 + s.nu) / s.mu), x3 = gammaFn((1 + 2 * BB + k + s.nu) / s.mu)
  return (x1 / x2) ** (2 * BB + k) * x3 / x1
}
function delabk(a: MassShape, b: MassShape, k: number) {
  const g1a = gammaFn((1 + a.nu) / a.mu), g2a = gammaFn((2 + a.nu) / a.mu), g1b = gammaFn((1 + b.nu) / b.mu), g2b = gammaFn((2 + b.nu) / b.mu)
  return 2 * (g1a / g2a) ** BB * gammaFn((1 + BB + a.nu) / a.mu) * (g1b / g2b) ** (BB + k) * gammaFn((1 + BB + k + b.nu) / b.mu) / (g1a * g1b)
}
/** The collection factor of collector x (diameter dx) and collected y (dy): da0_x dx² + dab_k dx dy + da_k,y dy² (k 1 mass, 0 number). */
const coefficients = new Map<string, number>()
function sweepFactor(x: MassShape, y: MassShape, dx: number, dy: number, k: number) {
  const key = `${x.nu},${x.mu},${y.nu},${y.mu},${k}`
  let c = coefficients.get(key)
  if (c === undefined) { coefficients.set(key + 'a', delbk(x, 0)); coefficients.set(key + 'b', delabk(x, y, k)); coefficients.set(key + 'c', delbk(y, k)); c = 1; coefficients.set(key, c) }
  return coefficients.get(key + 'a')! * dx * dx + coefficients.get(key + 'b')! * dx * dy + coefficients.get(key + 'c')! * dy * dy
}

/** Thermodynamic properties at T (K), p (Pa), rho (kg/m3), as NSSL takes them. */
function air(tk: number, p: number, rho: number) {
  const tc = tk - T0, lv = 2500837.367 * (T0 / tk) ** (.167 + 3.67e-4 * tk), dv = 2.11e-5 * (tk / T0) ** 1.94 * (101325 / p)
  const mu = 1.832e-5 * (416.16 / (tk + 120)) * (tk / 296) ** 1.5, ka = 2.43e-2 * mu / 1.718e-5, nuKin = mu / rho
  const lf = 333690.6098 + 2030.61425 * tc - 10.46708312 * tc * tc
  const cw = tc < 0 ? 4203.1548 + 1.30572e-2 * (tc - 35) ** 2 : 4187, ci = (2.118636 + .007371 * tc) * 1e3
  return { tc, lv, lf, ls: lv + lf, dv, ka, nuKin, fvent: Math.cbrt(nuKin / dv) / Math.sqrt(nuKin), cw, ci, qss0: 380 / p }
}

/** The fields of the two-moment ice at the nodes (per kg of air) with the rest of the hydrometeors. */
export interface Ice2mFields {
  theta: Float32Array; q: Float32Array; cloud: Float32Array; ice: Float32Array; iceNumber: Float32Array; snow: Float32Array
  rain: Float32Array; rainNumber: Float32Array
  graupel: Float32Array; graupelNumber: Float32Array; graupelVolume: Float32Array
  hail: Float32Array; hailNumber: Float32Array; hailVolume: Float32Array
}

/** A class's state at a node and its derived sizes and speeds. */
interface Rimer { c: IceClass; q: number; n: number; v: number; rhoX: number; xv: number; dv: number; dn: number; vm: number; a: number; b: number; shape: MassShape }
function rimerAt(c: IceClass, q: number, n: number, v: number, rho: number): Rimer | null {
  if (!(q > ICE2M_MIN)) return null
  const rhoX = densityOf(c, q, v), nb = boundedIceNumber(c, q, n, v), xv = meanVolumeOf(c, q, nb, rhoX), [a, b] = fallLaw(rhoX), dn = characteristic(c, xv)
  return { c, q, n: nb, v: v > 0 ? v : q / rhoX, rhoX, xv, dv: Math.cbrt(6 * xv / Math.PI), dn, vm: momentSpeed(c, q, nb, v, rho, 3), a, b, shape: DIAMETER(c.alpha) }
}

/** Ventilation factor of a class (NSSL hwvent). */
function ventilation(r: Rimer, fvent: number, rho: number) {
  const al = r.c.alpha
  return .78 * (1 + al) + .308 * fvent * r.dn ** (.5 + .5 * r.b) * Math.sqrt(r.a * Math.sqrt(RHO_00 / Math.max(.05, rho))) * gammaFn(2.5 + al + .5 * r.b) / gammaFn(1 + al)
}

/**
 * The diameter at which a single particle of this class starts wet growth (Farley & Orville 1986, NSSL dg0), m: where
 * the liquid it collects can no longer all freeze. 0 when it never does here. Fixed-point iteration from 5 mm.
 */
function wetOnsetDiameter(r: Rimer, t: ReturnType<typeof air>, rho: number, qv: number, ql: number, iceSwept: number) {
  const h1 = -t.ka * t.tc - t.lv * t.dv * rho * (qv - t.qss0)
  if (!(h1 > 0) || !(ql > 0)) return 0
  let d = 5e-3
  for (let k = 0; k < 10; k++) {
    const vth = Math.sqrt(RHO_00 / rho) * r.a * d ** r.b, x2 = Math.cbrt(t.nuKin / t.dv) * Math.sqrt(vth * d / t.nuKin)
    const ah = x2 > 1.4 ? .78 + .308 * x2 : 1 + .108 * x2 * x2
    const den = vth * rho * ((t.lf + t.cw * t.tc) * ql + t.ci * t.tc * iceSwept)
    if (!(den > 0)) return 0
    d = Math.max(5e-3, 8 * ah * h1 / den)
  }
  return d
}

/** Drop volume (m3) the shed or melted water of a particle class falls as (NSSL vshdgs / imltshddmr). */
function shedVolume(r: Rimer, melt: boolean) {
  const big = (3 + r.c.alpha) * r.dn, three = Math.PI / 6 * 3e-3 ** 3
  if (melt) {
    // Melting: drops of the melted mean particle (at most 6 mm), turning into 3 mm drops between 8 and 20 mm.
    const own = Math.min(RHO_W * RAIN_XV_MAX * 64 / 6, r.rhoX * r.xv) / RHO_W, w = Math.min(1, Math.max(0, (r.dv - 8e-3) / 12e-3))
    return 1 / ((1 - w) / own + w / three)
  }
  const fac = 4.5 // (3+α_s)³ / ((3+α_s)(2+α_s)(1+α_s)), α_s 0
  return big > 20e-3 ? Math.PI / 6 * 1.5e-3 ** 3 / fac : big > 8e-3 ? three / fac : Math.min(RAIN_XV_MAX * 64 / 6, Math.PI / 6 * r.rhoX / RHO_W * big ** 3) / fac
}

/**
 * The two-moment graupel and hail processes at node i over dt. Returns the cooling of theta (K: melting and sublimation,
 * for the cold-pool indicator) and whether graupel and hail are in wet growth (for the charging).
 */
export function ice2mProcesses(f: Ice2mFields, i: number, exner: number, p: number, rho: number, dt: number) {
  const tk = f.theta[i] * exner, t = air(tk, p, rho), heat = 1 / (CP * exner)
  let cooling = 0, wetG = false, wetH = false
  if (t.tc < 0) {
    // Rain freezing (Bigg): each drop at a rate B' v (exp(-A' Tc) - 1), so the mass at the mass-weighted mean volume
    // (20 times the mean of an exponential distribution) - into graupel of 900 kg/m3.
    if (f.rain[i] > RAIN_MIN && f.rainNumber[i] > 0) {
      const nr = f.rainNumber[i], xv = rainVolume(f.rain[i], nr), k = BIGG_B * (Math.exp(-BIGG_A * t.tc) - 1)
      const qf = Math.min(f.rain[i], f.rain[i] * k * 20 * xv * dt), nf = Math.min(nr, nr * k * xv * dt)
      if (qf > 0) {
        f.rain[i] -= qf; f.rainNumber[i] -= nf
        f.graupel[i] += qf; f.graupelNumber[i] += nf; f.graupelVolume[i] += qf / 900
        f.theta[i] += LF * heat * qf
      }
    }
    // Rimed snow into graupel (Lin 1983 P_gaut), as many particles as the snow had, at SNOW_GRAUPEL_DENSITY.
    if (f.snow[i] > SNOW_GRAUPEL) {
      const m = Math.min(f.snow[i], 1e-3 * Math.exp(.09 * t.tc) * (f.snow[i] - SNOW_GRAUPEL) * dt)
      if (m > 0) {
        const lambda = (Math.PI * RHO_S * N0S / (rho * f.snow[i])) ** .25, mean = rho * f.snow[i] * lambda / N0S
        f.snow[i] -= m; f.graupel[i] += m; f.graupelNumber[i] += m / mean; f.graupelVolume[i] += m / SNOW_GRAUPEL_DENSITY
      }
    }
  }
  const nc = CLOUD_DROPLETS * rho / RHO_00, dc = f.cloud[i] > 1e-9 ? Math.cbrt(6 * rho * f.cloud[i] / (Math.PI * RHO_W * nc)) : 0
  const rc = dc / 2, ehw = dc < 2.4e-6 ? 0 : Math.min(.9, Math.max(0, -.27544 + rc * (.26249e6 + rc * (-1.8896e10 + rc * 4.4626e14))))
  // Graupel turning into hail is applied after the hail's own pass (all rates from the state at the start, as NSSL).
  let toHail = 0, toHailN = 0, toHailV = 0, meltLeft = t.tc > 0 ? CP * t.tc / LF : 0
  for (const kind of ['graupel', 'hail'] as const) {
    const graupel = kind === 'graupel', c = graupel ? GRAUPEL_2M : HAIL_2M
    const qa = graupel ? f.graupel : f.hail, na = graupel ? f.graupelNumber : f.hailNumber, va = graupel ? f.graupelVolume : f.hailVolume
    const r = rimerAt(c, qa[i], na[i], va[i], rho)
    if (!r) { qa[i] = Math.max(0, qa[i]); na[i] = 0; va[i] = 0; continue }
    const nm3 = rho * r.n, vent = ventilation(r, t.fvent, rho)
    // Collection of cloud water (ehw), rain (ehr; hail 1), cloud ice and snow; NSSL's per-step limits.
    let qacw = 0, qacr = 0, cacr = 0, qaci = 0, qacs = 0
    if (f.cloud[i] > 1e-9 && ehw > 0) qacw = Math.min(.5 * f.cloud[i] / dt, .25 * Math.PI * ehw * nm3 * f.cloud[i] * r.vm * sweepFactor(r.shape, DROPLETS, r.dv, dc, 1))
    const nr = f.rainNumber[i]
    if (f.rain[i] > RAIN_MIN && nr > 0) {
      const xvr = rainVolume(f.rain[i], nr), dr = Math.cbrt(6 * xvr / Math.PI), vr = rainSpeeds(f.rain[i], nr, rho)[0]
      const vt = Math.sqrt((r.vm - vr) ** 2 + .04 * r.vm * vr), er = graupel ? Math.min(1, Math.exp(-40e-6 / dr) * Math.exp(-40e-6 / r.dv)) : 1
      qacr = Math.min(.1 * f.rain[i] / dt, .25 * Math.PI * er * nm3 * f.rain[i] * vt * sweepFactor(r.shape, EXPONENTIAL, r.dv, dr, 1))
      // Drops per kg per second (nr per kg, nm3 per m3).
      cacr = Math.min(.1 * nr / dt, .25 * Math.PI * er * nm3 * nr * vt * sweepFactor(r.shape, EXPONENTIAL, r.dv, dr, 0))
    }
    if (t.tc < 0) {
      if (f.ice[i] > 1e-12 && f.iceNumber[i] > 0) {
        const di = Math.cbrt(6 * f.ice[i] / (Math.PI * 900 * f.iceNumber[i])), e = graupel ? Math.min(1, .1 * Math.exp(.1 * t.tc)) : .2
        qaci = Math.min(.1 * f.ice[i] / dt, e * .25 * Math.PI * nm3 * f.ice[i] * r.vm * sweepFactor(r.shape, DROPLETS, r.dv, di, 1))
      }
      if (f.snow[i] > 1e-12) {
        const lambda = (Math.PI * RHO_S * N0S / (rho * f.snow[i])) ** .25, ns = N0S / lambda, ds = Math.cbrt(6 * rho * f.snow[i] / (Math.PI * RHO_S * ns))
        const e = .5 * Math.exp(.09 * t.tc) * (graupel ? Math.min(1, Math.max(0, r.rhoX - 300) / 300) : 1)
        qacs = Math.min(.1 * f.snow[i] / dt, e * .25 * Math.PI * nm3 * f.snow[i] * r.vm * sweepFactor(r.shape, EXPONENTIAL, r.dv, ds, 1))
      }
    }
    let dq = 0, dn = 0, dvol = 0, toRain = 0, toRainN = 0
    if (t.tc < 0) {
      // Rime density (Heymsfield & Pflaum 1985): denser for bigger droplets, faster impact and warmer air.
      const rime = (d: number, v: number) => Math.min(900, Math.max(graupel ? 170 : 500, 300 * (-(.5e6 * d) * (.6 * v) / t.tc) ** .44))
      const dry = qacw + qacr + qaci + qacs
      // Wet growth (243-273 K): the most the surface can freeze; the rest is shed as drops, the particle soaks to 900.
      let wet = dry
      if (tk > 243.15) {
        const fwet1 = 2 * Math.PI * (t.lv * t.dv * rho * (t.qss0 - f.q[i]) - t.ka * t.tc) / (rho * (t.lf + t.cw * t.tc)), fwet2 = 1 - t.ci * t.tc / (t.lf + t.cw * t.tc)
        wet = Math.max(0, r.dn * vent * nm3 * fwet1 + fwet2 * (qaci + qacs))
      }
      const shed = Math.min(0, wet - dry), isWet = shed < 0
      if (graupel) wetG = isWet; else wetH = isWet
      dq += (dry + shed) * dt
      toRainN -= cacr * dt
      if (isWet) {
        // The mass that stays (wet) at 900 kg/m3, less what the soaking fills of the particle's air.
        dvol += wet / 900 * dt - Math.min((1 - r.rhoX / 900) * r.v, wet / 900 * dt)
        toRain += -shed * dt; toRainN += -shed * dt / (RHO_W * shedVolume(r, false))
      } else {
        const rhoCloud = rime(dc, r.vm), rhoRain = rime(f.rain[i] > RAIN_MIN && nr > 0 ? Math.cbrt(6 * rainVolume(f.rain[i], nr) / Math.PI) : 1e-3, r.vm)
        dvol += (qacw / rhoCloud + qacr / rhoRain + (qaci + qacs) / Math.max(rhoCloud, 170)) * dt
      }
      f.cloud[i] -= qacw * dt; f.rain[i] -= qacr * dt; f.ice[i] -= qaci * dt; f.snow[i] -= qacs * dt
      // The liquid that froze gives its latent heat.
      f.theta[i] += LF * heat * Math.max(0, (qacw + qacr) * dt + shed * dt)
      // Graupel whose largest particles pass the onset of wet growth turns into hail (NSSL ihlcnh 3): the tail's share
      // per HAIL_TIME, at most a tenth a step.
      if (graupel && tk > 242 && tk <= 271.15 && r.q > 1e-4 && qacw * dt > 1e-12) {
        const d0 = wetOnsetDiameter(r, t, rho, f.q[i], ehw * f.cloud[i] + f.rain[i], Math.min(1, .1 * Math.exp(.1 * t.tc)) * f.ice[i])
        if (d0 > 0 && d0 < .15) {
          const ratio = Math.min(100, d0 / r.dn), share = Math.min(.1, upperGamma(4, ratio) * dt / HAIL_TIME), shareN = upperGamma(4, ratio) > 0 ? share * upperGamma(1, ratio) / upperGamma(4, ratio) : 0
          const m = share * r.q, nn = Math.min(r.n, shareN * r.n)
          if (m > 0) { dq -= m; dn -= nn; dvol -= m / r.rhoX; toHail += m; toHailN += nn; toHailV += m / r.rhoX }
        }
      }
      // Deposition and sublimation over ice.
      const qsi = qsatIce(t.tc, p), fai = t.ls * t.ls / (t.ka * 461.5 * tk * tk), fbi = 1 / (rho * t.dv * qsi)
      const rate = 4 * Math.PI / rho * (f.q[i] / qsi - 1) / (fai + fbi) * nm3 * vent * .5 * r.dn
      if (rate > 0) {
        const m = Math.min(rate * dt, Math.max(0, (f.q[i] - qsi) / (1 + LS * LS * qsi / (CP * 461.5 * tk * tk))))
        dq += m; dvol += m / r.rhoX; f.q[i] -= m; f.theta[i] += LS * heat * m
      } else if (rate < 0) {
        const m = Math.min(-rate * dt, .1 * r.q, (qsi - f.q[i]) / (1 + LS * LS * qsi / (CP * 461.5 * tk * tk)))
        if (m > 0) { dq -= m; dn -= r.n * m / r.q; dvol -= m / r.rhoX; f.q[i] += m; f.theta[i] -= LS * heat * m; cooling += LS * heat * m }
      }
    } else {
      // Above 0 °C: the cloud water collected is shed at once; the rain collected only brings its heat.
      f.cloud[i] -= qacw * dt; toRain += qacw * dt; toRainN += qacw * dt / (RHO_W * shedVolume(r, false))
      const fmlt1 = 2 * Math.PI * (t.lv * t.dv * (t.qss0 - f.q[i]) - t.ka * t.tc / rho) / t.lf, fmlt2 = -t.cw * t.tc / t.lf
      const rate = Math.min(0, fmlt1 * nm3 * vent * r.dn + fmlt2 * (qacr + qacw))
      // Never past what cools the air to 0 °C (shared by both classes).
      const m = Math.min(r.q, -rate * dt, meltLeft)
      if (m > 0) {
        meltLeft -= m
        dq -= m; dn -= Math.min(.95 * r.n, r.n * m / r.q); dvol -= m / r.rhoX + (r.rhoX < 900 ? Math.min((1 - r.rhoX / 900) * r.v, m / 900) : 0)
        toRain += m; toRainN += m / (RHO_W * shedVolume(r, true))
        f.theta[i] -= LF * heat * m; cooling += LF * heat * m
      }
    }
    qa[i] = Math.max(0, r.q + dq); na[i] = Math.max(0, r.n + dn); va[i] = Math.max(0, r.v + dvol)
    f.rain[i] += toRain; f.rainNumber[i] = Math.max(0, f.rainNumber[i] + toRainN)
  }
  if (toHail > 0) { f.hail[i] += toHail; f.hailNumber[i] += toHailN; f.hailVolume[i] += toHailV }
  for (const [c, qa, na, va] of BOUNDED(f)) {
    if (!(qa[i] > ICE2M_MIN)) { qa[i] = Math.max(0, qa[i]); na[i] = 0; va[i] = 0; continue }
    const rhoX = densityOf(c, qa[i], va[i]); va[i] = qa[i] / rhoX; na[i] = boundedIceNumber(c, qa[i], na[i], va[i])
  }
  if (f.ice[i] < 0) f.ice[i] = 0; if (f.snow[i] < 0) f.snow[i] = 0; if (f.cloud[i] < 0) f.cloud[i] = 0
  f.rainNumber[i] = boundedDrops(f.rain[i], f.rainNumber[i], rho)
  return { cooling, wetG, wetH }
}

