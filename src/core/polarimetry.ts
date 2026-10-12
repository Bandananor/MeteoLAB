import { N0R, RHO_W } from './graupel'
import { speciesZ } from './radar'

// Dual polarisation (S band, 10.7 cm) from the model's precipitation: differential reflectivity ZDR, the co-polar
// correlation coefficient rho_hv and the specific differential phase KDP. The microphysics is single-moment, so a
// species' sizes follow from its mass alone (the exponential distribution of its fixed intercept); these are estimates
// from mean sizes, not a polarimetric simulator. Rain is done from first principles: drops flatten with size (axis ratio
// of Brandes et al. 2002) and a spheroid's horizontal-to-vertical reflectivity ratio is about r^(-7/3) (Rayleigh, Jameson
// 1983), integrated over the drop sizes. The ice species get the typical intrinsic values of the literature (Kumjian
// 2013, a review): they tumble or are near-spherical, so ZDR ~0, and a water coat while they melt raises ZDR and lowers
// rho_hv (the melting layer's bright band, wet hail). Mixtures lower rho_hv by themselves: rain and hail of different
// ZDR in one volume no longer echo alike.

/** Axis ratio (vertical / horizontal) of a raindrop of equivolume diameter d, mm (Brandes et al. 2002), at most 1. */
export function dropAxisRatio(d: number) {
  return Math.min(1, .9951 + .0251 * d - .03644 * d * d + .005303 * d ** 3 - .0002492 * d ** 4)
}

/** Largest drop of the size integrals, mm: bigger ones break up. */
const MAX_DROP = 8
/** The rain table: ln(slope) from ln(300) to ln(30000) per m (mean diameters ~3.3 mm to 0.03 mm). */
const LN_MIN = Math.log(300), LN_MAX = Math.log(30000), STEPS = 256

/** Rain's linear ZDR and mass-weighted axis ratio against the slope of its exponential size distribution (precomputed). */
const RAIN = (() => {
  const zdr = new Float64Array(STEPS), axis = new Float64Array(STEPS)
  for (let k = 0; k < STEPS; k++) {
    const lambda = Math.exp(LN_MIN + (LN_MAX - LN_MIN) * k / (STEPS - 1)) / 1000 // per mm
    let zh = 0, zv = 0, mass = 0, massAxis = 0
    for (let d = .025; d < MAX_DROP; d += .05) {
      const n = Math.exp(-lambda * d), r = dropAxisRatio(d), d3 = d ** 3, d6 = d3 * d3
      zh += d6 * n; zv += d6 * r ** (7 / 3) * n; mass += d3 * n; massAxis += d3 * r * n
    }
    zdr[k] = zh / zv; axis[k] = massAxis / mass
  }
  return { zdr, axis }
})()

function rainTable(table: Float64Array, rhoQ: number) {
  const lambda = (Math.PI * RHO_W * N0R / rhoQ) ** .25, x = (Math.log(lambda) - LN_MIN) / (LN_MAX - LN_MIN) * (STEPS - 1)
  if (x <= 0) return table[0]
  if (x >= STEPS - 1) return table[STEPS - 1]
  const k = Math.floor(x)
  return table[k] + (table[k + 1] - table[k]) * (x - k)
}

/** Intrinsic linear ZDR and rho_hv of the ice species, dry (below 0 °C) and melting (above). */
const ICE = {
  snow: { dry: [10 ** .04, .99], wet: [10 ** .15, .88] },
  graupel: { dry: [10 ** .02, .985], wet: [10 ** .1, .9] },
  hail: { dry: [1, .95], wet: [10 ** .03, .86] },
} as const
/** Rain's intrinsic rho_hv (drops of one size echo alike; the spread of shapes lowers it a little). */
const RAIN_RHO = .997
/** KDP of rain: (180 / lambda) 1e-3 C W (1 - r_m), deg/km, with lambda = 0.107 m, C = 3.75, W in g/m3 (Bringi and Chandrasekar 2001). */
const KDP_FACTOR = 180 / .107 * 1e-3 * 3.75

export interface DualPol { /** dB */ zdr: number; /** 0-1 */ rho: number; /** deg/km */ kdp: number }

/**
 * ZDR (dB), rho_hv and KDP (deg/km) of rain, snow, graupel and hail mixing ratios (kg/kg) in air of density rho at
 * temperature tc, °C; NaN everywhere without precipitation. Each species adds its horizontal and vertical reflectivity;
 * rho_hv = |sum rho_i sqrt(Zh_i Zv_i)| / sqrt(sum Zh sum Zv); KDP comes from rain alone (ice adds little).
 */
export function dualPol(rho: number, rain: number, snow: number, graupel: number, tc: number, hail = 0): DualPol {
  const z = speciesZ(rho, rain, snow, graupel, tc, hail), wet = tc > 0 ? 'wet' : 'dry'
  let zh = 0, zv = 0, cross = 0
  const add = (h: number, zdr: number, rhoHv: number) => { if (!(h > 0)) return; const v = h / zdr; zh += h; zv += v; cross += rhoHv * Math.sqrt(h * v) }
  if (rain > 0) add(z.rain, rainTable(RAIN.zdr, rho * rain), RAIN_RHO)
  add(z.snow, ICE.snow[wet][0], ICE.snow[wet][1]); add(z.graupel, ICE.graupel[wet][0], ICE.graupel[wet][1]); add(z.hail, ICE.hail[wet][0], ICE.hail[wet][1])
  if (!(zh > 0)) return { zdr: NaN, rho: NaN, kdp: NaN }
  const kdp = rain > 0 ? KDP_FACTOR * rho * rain * 1000 * (1 - rainTable(RAIN.axis, rho * rain)) : 0
  return { zdr: 10 * Math.log10(zh / zv), rho: cross / Math.sqrt(zh * zv), kdp }
}
