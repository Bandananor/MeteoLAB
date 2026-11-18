// Two-moment rain after the NSSL scheme (Mansell, Ziegler & Bruning 2010, JAS 67, 171; Ziegler 1985, JAS 42, 1487),
// Э1 step 1 (16.11.2026): rain mass q_r and drop number N_r per kg of air, ported from CM1's src/module_mp_nssl_2mom.F
// (MIT licence; the formulas as there, the subroutine names in the comments; .claude/literature/nssl-2m-rain.md).
// The size distribution is exponential (alphar = 0) in diameter; the mean diameter is bounded so that the mass-weighted
// diameter stays below 6 mm (imaxdiaopt = 3) and above 80 µm, the number adjusted, the mass kept. Our cloud water has
// no droplet number yet (saturation adjustment): the droplets are NSSL's one-moment CCN number, 0.6e9 m^-3 at sea-level
// density scaled with the density ("low continental"), our substitute, not a setting of the scheme.
import { CP, LV } from './constants'
import { qsatP } from './microphysics'

/** Water density, kg/m3; air density NSSL scales its fall speeds and droplet number to, kg/m3. */
export const RHO_W = 1000, RHO_00 = 1.225
/** Drop volume bounds, m3: 80 µm, and the mass-weighted diameter 6 mm with alpha 0 (xvbarmax = xvmx / ((4+α)³ / ((3+α)(2+α)(1+α)))). */
export const XV_MIN = Math.PI / 6 * 80e-6 ** 3, XV_MAX = Math.PI / 6 * 6e-3 ** 3 / (64 / 6)
/** Cloud droplets at sea-level density, m^-3 (NSSL's ccn default). */
export const CLOUD_DROPLETS = .6e9
/** Long's (1974) collection kernel: K = aa1 (v1² + v2²) for small drops, aa2 (v1 + v2) once the larger one passes 50 µm. */
const AA1 = 9.44e15, AA2 = 5.78e3
/** Reflectivity factor of an exponential distribution: (α+6)(α+5)(α+4) / ((α+3)(α+2)(α+1)) at α = 0. */
export const G1 = 120 / 6
/** Rain fall speed V(D) = 10 (1 - exp(-516.575 D)) m/s (NSSL's), its moments for the distribution below. */
const VT_A = 10, VT_B = 516.575
/**
 * Collisional breakup of rain (Э1, 18.11.2026; .claude/literature/rain-breakup.md). NSSL's 2M default has none beyond the
 * self-collection efficiency falling off above 0.6 mm, and our drops at the ground came out too large (Dn 0.6-0.78 mm,
 * D_m 2.4-3.1 mm), evaporating little: weak cold pools. 'nssl': NSSL's irainbreak = 2 (WRF; for its 3-moment rain):
 * a number source rainbreakfac (1 - ec0) (rho q)^2, rainbreakfac 1e6 m3 kg^-2 s^-1, full above a 2 mm mean-volume
 * diameter. 'morrison': Morrison et al. (2009), NSSL's irainbreak = 100: self-collection and breakup together,
 * dN/dt = -5.78 Ec N q rho with Ec = 1 below Dn 300 µm, 2 - exp(2300 (Dn - 300 µm)) above (equilibrium at Dn ≈ 0.6 mm).
 */
export type RainBreakup = 'none' | 'nssl' | 'morrison'
export const RAIN_BREAK_FACTOR = 1e6

/** Below this much rain (kg/kg) a node has none (NSSL's qxmin); fewer drops per kg than this count as none. */
export const RAIN_MIN = 1e-12, NUMBER_MIN = 1e-8

/** The mean drop volume (m3) of rain q (kg/kg) and number n (per kg), bounded. */
export function meanVolume(q: number, n: number) { return Math.min(XV_MAX, Math.max(XV_MIN, q / (RHO_W * n))) }

/** The distribution's characteristic diameter Dn (m) from the mean volume: (6 xv / (π (α+3)(α+2)(α+1)))^(1/3), α = 0. */
export function dnOf(xv: number) { return Math.cbrt(xv / Math.PI) }

/**
 * The drop number for rain q with number n, the mean volume put inside its bounds (NSSL setvtz, ioldlimiter 0): the mass
 * is kept, only the number moves. Rain with no number gets Marshall-Palmer's (N0 8e6 m^-4), as a one-moment run had it.
 */
export function boundedNumber(q: number, n: number, rho: number) {
  if (!(q > RAIN_MIN)) return 0
  if (!(n > NUMBER_MIN)) { const lambda = (Math.PI * RHO_W * 8e6 / (rho * q)) ** .25; n = 8e6 / lambda / rho }
  return q / (RHO_W * meanVolume(q, n))
}

/**
 * Mass- and number-weighted fall speeds (m/s) of rain q with number n at density rho: rhovt 10 (1 - (1 + 516.575 Dn)^-(α+k)),
 * k = 4 and 1 (sediment1d's vtxbar; k = 7 for the reflectivity: fallSpeedZ). rhovt = sqrt(rho00 / rho).
 */
export function fallSpeeds(q: number, n: number, rho: number): [number, number] {
  if (!(q > RAIN_MIN) || !(n > NUMBER_MIN)) return [0, 0]
  const dn = dnOf(meanVolume(q, n)), r = Math.sqrt(RHO_00 / Math.max(.05, rho)), x = 1 + VT_B * dn
  return [r * VT_A * (1 - x ** -4), r * VT_A * (1 - x ** -1)]
}

/** The reflectivity-weighted fall speed (m/s), for the size-sorting limiter of the sedimentation. */
export function fallSpeedZ(q: number, n: number, rho: number) {
  if (!(q > RAIN_MIN) || !(n > NUMBER_MIN)) return 0
  return Math.sqrt(RHO_00 / Math.max(.05, rho)) * VT_A * (1 - (1 + VT_B * dnOf(meanVolume(q, n))) ** -7)
}

/**
 * Warm-rain processes of two-moment rain at node i over dt (NSSL nssl_2mom_gs): autoconversion of cloud water (Ziegler
 * 1985 after Berry & Reinhardt), accretion and self-collection (Long's kernel; collisional breakup only through the
 * self-collection efficiency falling off above 0.6 mm and none above 2 mm), evaporation in subsaturated air with
 * ventilation (the mean drop mass kept: icrcev 1), then the number bounded. Returns the evaporated rain (kg/kg); the
 * caller applies the latent cooling.
 */
export function rain2mProcesses(q: Float32Array, cloud: Float32Array, rain: Float32Array, number: Float32Array, i: number, tk: number, p: number, rho: number, dt: number, breakup: RainBreakup = 'none') {
  const qc = cloud[i], qr = rain[i]
  let nr = qr > RAIN_MIN ? boundedNumber(qr, number[i], rho) * rho : 0 // per m3
  // Autoconversion (cloud droplets: number fixed, radius bounded to 2-60 µm; nu = 0).
  let auto = 0, autoN = 0, accretion = 0
  const nc = CLOUD_DROPLETS * rho / RHO_00
  const xvc = qc > 1e-9 ? Math.min(Math.PI / 6 * 120e-6 ** 3, Math.max(Math.PI / 6 * 4e-6 ** 3, rho * qc / (RHO_W * nc))) : 0
  const dc = Math.cbrt(6 * xvc / Math.PI), rb = .5 * dc
  if (qc > 1e-9 && tk > 237.15) {
    const xl2p = Math.max(0, 2.7e-2 * rho * qc * (.5e20 * rb ** 3 * dc - .4))
    if (rb > 7.51e-6 && xl2p > 0) {
      const t2s = 3.72 / (1e6 * (rb - 7.5e-6) * rho * qc)
      auto = xl2p / (t2s * rho)
      const cautn = Math.min(.1 * nc / dt, 2 * AA1 * nc * nc * xvc * xvc)
      autoN = Math.max(0, Math.min(3.5e9 * xl2p / t2s, .5 * cautn))
      // Onto existing rain the new drops keep its mean mass (Cohard & Pinty 2002; dmrauto 0).
      if (rho * qr > 1.2 * xl2p && nr > NUMBER_MIN) autoN = nr / (rho * qr) * auto * rho
    }
  }
  // Accretion of cloud water by rain (collection efficiency 1), once the drops pass the "hump" radius.
  const xvr = nr > 0 ? rho * qr / (RHO_W * nr) : 0, dv = Math.cbrt(6 * xvr / Math.PI), rwrad = dv / 2
  if (qc > 1e-9 && nr > 0) {
    const rh = rb > 3.5e-6 ? Math.max(41e-6, 6.3e-4 / (1e6 * (rb - 3.5e-6))) : 41e-6
    if (rwrad > rh) {
      accretion = rwrad > 50e-6 ? AA2 * nr * nc * RHO_W * xvc * (2 * xvc + xvr) / rho : AA1 * nr * qc * (6 * xvc * xvc + G1 * xvr * xvr)
      accretion = Math.min(accretion, .1 * qc / dt)
    }
  }
  // Both take cloud water: at most what there is.
  const take = (auto + accretion) * dt
  if (take > qc) { const s = qc / take; auto *= s; autoN *= s; accretion *= s }
  // Self-collection: none above 2 mm (icracrthresh), the efficiency falling off above 0.6 mm (ec0).
  let selfN = 0
  if (breakup === 'morrison') {
    // Morrison: one rate for both, negative (breakup) beyond the equilibrium.
    if (nr > 0) { const dn = dnOf(xvr), ec = dn < 300e-6 ? 1 : 2 - Math.exp(2300 * (dn - 300e-6)); selfN = 5.78 * ec * nr * qr * rho }
  } else {
    const big = !(dv - 1e-4 <= 1.9e-3), ec0 = big ? 0 : dv < 6.1e-4 ? 1 : Math.exp(-2500 * (dv - 6e-4))
    if (nr > 0 && !big) selfN = rwrad >= 50e-6 ? ec0 * AA2 * nr * nr * xvr : ec0 * AA1 * (nr * xvr) ** 2 * G1
    // NSSL irainbreak = 2: breakup where self-collection fails (none at all above ~2 mm).
    if (breakup === 'nssl' && nr > 0) selfN -= RAIN_BREAK_FACTOR * (1 - ec0) * (rho * qr) ** 2
  }
  cloud[i] = qc - (auto + accretion) * dt
  let qrNew = qr + (auto + accretion) * dt
  nr = nr + (autoN - selfN) * dt
  if (nr < 0) nr = 0
  // Evaporation in subsaturated air (rcond 2: only the loss), at most a tenth of the rain a step and never past saturation.
  let evaporation = 0
  const qs = qsatP(tk - 273.15, p)
  if (qrNew > RAIN_MIN && nr > 0 && q[i] < qs) {
    const l = 2500837.367 * (273.15 / tk) ** (.167 + 3.67e-4 * tk), dvap = 2.11e-5 * (tk / 273.15) ** 1.94 * (101325 / p)
    const mu = 1.832e-5 * (416.16 / (tk + 120)) * (tk / 296) ** 1.5, ka = 2.43e-2 * mu / 1.718e-5, nuKin = mu / rho
    const fvent = Math.cbrt(nuKin / dvap) / Math.sqrt(nuKin)
    const fav = l * l / (ka * 461.5 * tk * tk), fbv = 1 / (rho * dvap * qs)
    const fvce = 4 * Math.PI / rho * (q[i] / qs - 1) / (fav + fbv)
    const dn = dnOf(meanVolume(qrNew, nr / rho)), rhovt = Math.sqrt(RHO_00 / Math.max(.05, rho))
    // 0.78 (1 + α) + 0.308 Γ(α + 2.5 + br/2) / Γ(α + 1) fvent sqrt(ar rhovt) Dn^((1 + br) / 2), α 0, ar 841.99666, br 0.8.
    const vent = .78 + .308 * 1.8273551 * fvent * Math.sqrt(841.99666 * rhovt) * dn ** .9
    const rate = -fvce * nr * vent * .5 * dn
    evaporation = Math.min(rate * dt, .1 * qrNew, (qs - q[i]) / (1 + LV * LV * qs / (CP * 461.5 * tk * tk)))
    if (evaporation > 0) { nr -= nr * evaporation / qrNew; qrNew -= evaporation; q[i] += evaporation } else evaporation = 0
  }
  rain[i] = qrNew
  number[i] = qrNew > RAIN_MIN ? boundedNumber(qrNew, nr / rho, rho) : 0
  if (!(qrNew > RAIN_MIN)) rain[i] = Math.max(0, qrNew)
  return evaporation
}

/**
 * Drops of rain that left or came in by the other processes (ice: freezing, collection, melting): a loss keeps the mean
 * drop mass; a gain of `added` kg/kg arrives as drops of `meanMass` kg (melting particles), joining the drops there.
 */
export function rainNumberChange(rain: Float32Array, number: Float32Array, i: number, before: number, rho: number, meanMass: number) {
  const after = rain[i]
  if (!(after > RAIN_MIN)) { number[i] = 0; return }
  const n = number[i]
  if (after < before) number[i] = before > 0 ? n * after / before : n
  else if (after > before) number[i] = n + (after - before) / Math.max(meanMass, RHO_W * XV_MIN)
  number[i] = boundedNumber(after, number[i], rho)
}

/**
 * The mean particle mass (kg) of an exponential distribution of intercept n0 (m^-4) and particle density rhoX holding
 * q (kg/kg) at air density rho: the melt of such particles arrives as drops of this mass.
 */
export function exponentialMeanMass(q: number, n0: number, rhoX: number, rho: number) {
  if (!(q > 0)) return 0
  const lambda = (Math.PI * rhoX * n0 / (rho * q)) ** .25
  return rho * q * lambda / n0
}
