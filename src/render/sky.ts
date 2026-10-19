// The sky and the light of the day: the air's scattering for the sun where it is now, from noon through sunset and the
// twilight to the night. A spherical atmosphere (Bruneton & Neyret 2008, Hillaire 2020): Rayleigh scattering by the air,
// Mie scattering and absorption by the aerosol (the haze), absorption by the ozone (the blue of the twilight's zenith),
// single scattering along each ray of the sky plus multiple scattering from a small table (Hillaire 2020), the Earth's
// shadow (the high clouds keep the sun after it has set for the ground). Computed on the CPU into small tables when the
// sun or the haze changes; the shaders read them. Radiance is relative to the sun's irradiance above the air (1 in each
// of the three channels, 680 / 550 / 440 nm).

/** Radii of the Earth and of the top of the air, km. */
export const EARTH = 6360, TOP = 6460
/** Rayleigh scattering at sea level, 1/km (680 / 550 / 440 nm), and its scale height, km. */
export const RAYLEIGH = [5.802e-3, 13.558e-3, 33.1e-3] as const, RAYLEIGH_SCALE = 8
/** The aerosol's scale height, km (it fills the boundary layer), its single scattering albedo and phase asymmetry. */
export const HAZE_SCALE = 1.2, HAZE_ALBEDO = .9, HAZE_G = .7
/** Ozone absorption at its peak, 1/km, in a layer 30 km thick round 25 km (Hillaire 2020). */
const OZONE = [.65e-3, 1.881e-3, .085e-3] as const
/** The sun's angular radius, rad. */
export const SUN_RADIUS = .00465

/**
 * The aerosol's extinction at the ground, 1/km, from the relative humidity of the air there (0-1): a dry summer
 * continental aerosol (0.05/km: an optical depth ~0.1 over its 1.2 km layer, as AERONET's summer means) that swells as
 * it takes up water, (1 - RH)^-0.5 (Hänel 1976): visibility ~30 km at 70%, ~13 km in damp air at 95%. Not a haze in
 * the observer's sense (visibility 1-10 km, near-saturated air): the air's turbidity.
 */
export function hazeExtinction(rh: number) { return .05 * Math.pow(1 - Math.min(Math.max(rh, 0), .97), -.5) }

/** The meteorological optical range, km, for an extinction at the ground, 1/km (WMO: a 5% contrast, 3.0 / beta). */
export const visibility = (extinction: number) => 3.0 / (extinction + RAYLEIGH[1])

type V3 = [number, number, number]

/** Densities relative to sea level at height h, km: air (Rayleigh), aerosol, ozone. */
function densities(h: number): V3 { return [Math.exp(-h / RAYLEIGH_SCALE), Math.exp(-h / HAZE_SCALE), Math.max(0, 1 - Math.abs(h - 25) / 15)] }

/** Distance from radius r along a ray with cosine mu to the zenith to the sphere of radius R (outside; NaN if missed). */
function toSphere(r: number, mu: number, R: number) { const d = r * r * (mu * mu - 1) + R * R; return d < 0 ? NaN : -r * mu + Math.sqrt(d) }
/** Distance to the ground along the ray, or NaN if it does not reach it. */
function toGround(r: number, mu: number) { const d = r * r * (mu * mu - 1) + EARTH * EARTH; return mu > 0 || d < 0 ? NaN : -r * mu - Math.sqrt(d) }
/** Cosine of the zenith angle of the horizon seen from radius r. */
const horizonMu = (r: number) => -Math.sqrt(Math.max(0, 1 - (EARTH / r) ** 2))

// The column densities to the top of the air (air, aerosol, ozone; km of sea-level air), from height h (rows, h = 100 km
// times the square of the row's share) along the cosine to the zenith from the horizon's to 1 (columns, square root
// spacing, finer near the horizon where the path changes fastest). They do not depend on the haze.
const T_ROWS = 48, T_COLS = 96, columns = new Float32Array(T_ROWS * T_COLS * 3)
const rowHeight = (i: number) => (TOP - EARTH) * (i / (T_ROWS - 1)) ** 2
for (let i = 0; i < T_ROWS; i++) {
  const r = EARTH + rowHeight(i), mh = horizonMu(r)
  for (let j = 0; j < T_COLS; j++) {
    const mu = mh + (1 - mh) * (j / (T_COLS - 1)) ** 2, len = toSphere(r, mu, TOP), n = 64, sum = [0, 0, 0]
    for (let k = 0; k < n; k++) {
      // Steps finer at the start, where the air is densest.
      const a = ((k / n) ** 2) * len, b = (((k + 1) / n) ** 2) * len, t = (a + b) / 2, h = Math.sqrt(r * r + t * t + 2 * r * t * mu) - EARTH, d = densities(h)
      for (let c = 0; c < 3; c++) sum[c] += d[c] * (b - a)
    }
    columns.set(sum, (i * T_COLS + j) * 3)
  }
}

/** Column densities (air, aerosol, ozone) from radius r toward cosine mu; null where the ground is in the way. */
function columnTo(r: number, mu: number): V3 | null {
  const mh = horizonMu(r)
  if (mu < mh) return null
  const fi = Math.sqrt(Math.min(Math.max(r - EARTH, 0), TOP - EARTH - 1e-6) / (TOP - EARTH)) * (T_ROWS - 1), fj = Math.sqrt(Math.min(1, (mu - mh) / (1 - mh))) * (T_COLS - 1)
  const i = Math.min(Math.floor(fi), T_ROWS - 2), j = Math.min(Math.floor(fj), T_COLS - 2), a = fi - i, b = fj - j, out: V3 = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const at = (ii: number, jj: number) => columns[(ii * T_COLS + jj) * 3 + c]
    out[c] = (at(i, j) * (1 - b) + at(i, j + 1) * b) * (1 - a) + (at(i + 1, j) * (1 - b) + at(i + 1, j + 1) * b) * a
  }
  return out
}

/** The extinction coefficients (per km of sea-level density) of the air, the aerosol and the ozone in channel c. */
function extinctions(haze: number, c: number): V3 { return [RAYLEIGH[c], haze / HAZE_ALBEDO, OZONE[c]] }
/** Transmittance of a column (air, aerosol, ozone) in channel c. */
function transmitColumn(col: V3, haze: number, c: number) { const e = extinctions(haze, c); return Math.exp(-(e[0] * col[0] + e[1] * col[1] + e[2] * col[2])) }

/**
 * Transmittance of sunlight to height h, km, for the sun at cosine mu to the zenith (RGB): 0 where the Earth is in the
 * way, with a soft edge as wide as the sun's disc (the sun sets over a couple of minutes, not at once).
 */
export function sunTransmittance(h: number, mu: number, haze: number): V3 {
  const r = EARTH + h, mh = horizonMu(r), edge = Math.sin(SUN_RADIUS), seen = smooth((mu - mh + edge) / (2 * edge))
  const col = columnTo(r, Math.max(mu, mh))!
  return [0, 1, 2].map(c => transmitColumn(col, haze, c) * seen) as V3
}

const smooth = (x: number) => { const t = Math.min(Math.max(x, 0), 1); return t * t * (3 - 2 * t) }
const rayleighPhase = (c: number) => 3 / (16 * Math.PI) * (1 + c * c)
/** Cornette-Shanks phase (a Henyey-Greenstein with a Rayleigh-like backscatter), normalised over the sphere. */
function miePhase(c: number) { const g = HAZE_G, k = 3 / (8 * Math.PI) * (1 - g * g) / (2 + g * g); return k * (1 + c * c) / Math.pow(1 + g * g - 2 * g * c, 1.5) }

// Multiple scattering (Hillaire 2020, section 5.5): for a point at height h lit by the sun at cosine mu_s, the light
// scattered twice and more, as a factor of the scattering coefficient there. A table over (h, mu_s), recomputed when the
// haze or the ground's albedo changes.
// Its columns run over the sun's cosine with a square spacing round 0 (t |t|, t from -1 to 1): fine round the horizon,
// where the twilight's light falls off by orders of magnitude (with 24 even columns the light at -6° came out ~3x too
// bright, at -12° ~5x).
const MS_ROWS = 16, MS_COLS = 64, MS_TOP = 30, MS_DIRS = 32, MS_STEPS = 12
const msMu = (j: number) => { const x = -1 + 2 * j / (MS_COLS - 1); return x * Math.abs(x) }
const msCol = (mu: number) => { const m = Math.min(Math.max(mu, -1), 1); return (Math.sign(m) * Math.sqrt(Math.abs(m)) + 1) / 2 * (MS_COLS - 1) }
function multipleTable(haze: number, albedo: number) {
  const out = new Float32Array(MS_ROWS * MS_COLS * 3), dirs: V3[] = []
  // Directions spread evenly over the sphere (a Fibonacci lattice).
  for (let k = 0; k < MS_DIRS; k++) { const y = 1 - 2 * (k + .5) / MS_DIRS, s = Math.sqrt(1 - y * y), a = k * 2.39996323; dirs.push([s * Math.cos(a), y, s * Math.sin(a)]) }
  const e = [0, 1, 2].map(c => extinctions(haze, c)), L2 = [0, 0, 0], F = [0, 0, 0], T = [0, 0, 0], w = 1 / MS_DIRS
  for (let i = 0; i < MS_ROWS; i++) {
    const h = MS_TOP * (i / (MS_ROWS - 1)) ** 2 + .01, r0 = EARTH + h
    for (let j = 0; j < MS_COLS; j++) {
      const mus = msMu(j), sx = Math.sqrt(1 - mus * mus)
      L2.fill(0); F.fill(0)
      for (const d of dirs) {
        const ground = toGround(r0, d[1]), len = Number.isNaN(ground) ? toSphere(r0, d[1], TOP) : ground, ds = len / MS_STEPS
        T.fill(1)
        for (let k = 0; k < MS_STEPS; k++) {
          const t = (k + .5) * ds, px = d[0] * t, py = r0 + d[1] * t, pz = d[2] * t, r = Math.hypot(px, py, pz), rho = densities(r - EARTH), st = columnTo(r, (sx * px + mus * py) / r)
          for (let c = 0; c < 3; c++) {
            // An isotropic phase (1/4pi) for the second order, as in the paper.
            const scatter = RAYLEIGH[c] * rho[0] + haze * rho[1], ext = Math.max(e[c][0] * rho[0] + e[c][1] * rho[1] + e[c][2] * rho[2], 1e-9), step = Math.exp(-ext * ds)
            const share = T[c] * (1 - step) / ext * w, sunT = st ? transmitColumn(st, haze, c) : 0
            L2[c] += share * scatter * sunT / (4 * Math.PI); F[c] += share * scatter; T[c] *= step
          }
        }
        if (!Number.isNaN(ground)) {
          // The ground: Lambertian, lit by the sun.
          const gx = d[0] * len, gy = r0 + d[1] * len, gz = d[2] * len, gr = Math.hypot(gx, gy, gz), gmu = (sx * gx + mus * gy) / gr, st = columnTo(gr, gmu)
          if (st && gmu > 0) for (let c = 0; c < 3; c++) L2[c] += T[c] * albedo / Math.PI * gmu * transmitColumn(st, haze, c) * w
        }
      }
      for (let c = 0; c < 3; c++) out[(i * MS_COLS + j) * 3 + c] = L2[c] / (1 - Math.min(F[c], .99))
    }
  }
  return out
}

/** The sky's table: radiance over the view's elevation (rows, 0 to 90 degrees, square spacing) and azimuth from the sun (columns, 0-180). */
export const SKY_ROWS = 32, SKY_COLS = 32
/** Height of the observer of the sky's table, km (the domain's ground). */
const VIEWER = .05

export interface SkyState {
  /** Radiance of the sky (RGB per texel of the table, relative to the sun above the air). */
  sky: Float32Array
  /** Sunlight at heights 0..SUN_TOP km (SUN_LEVELS of them, RGB). */
  sunByHeight: Float32Array
  /** Irradiance of the sky on the horizontal ground (RGB) and of the sun on it. */
  skyIrradiance: V3; sunIrradiance: V3
  /** The aerosol's extinction at the ground, 1/km. */
  haze: number
}
export const SUN_LEVELS = 16, SUN_TOP = 20

/** Elevation, rad, of row v (0-1) of the sky's table: square spacing, fine near the horizon. */
export const rowElevation = (v: number) => v * v * Math.PI / 2

let msCache: { haze: number; albedo: number; table: Float32Array } | null = null
function multiple(haze: number, albedo: number) {
  if (!msCache || msCache.haze !== haze || msCache.albedo !== albedo) msCache = { haze, albedo, table: multipleTable(haze, albedo) }
  return msCache.table
}
/** The multiple scattering at height h for the sun at cosine mus, into out (RGB). */
function multipleAt(table: Float32Array, h: number, mus: number, out: number[]) {
  const fi = Math.sqrt(Math.min(Math.max(h - .01, 0), MS_TOP) / MS_TOP) * (MS_ROWS - 1), fj = msCol(mus)
  const i = Math.min(Math.floor(fi), MS_ROWS - 2), j = Math.min(Math.floor(fj), MS_COLS - 2), a = fi - i, b = fj - j
  const i00 = (i * MS_COLS + j) * 3, i01 = i00 + 3, i10 = i00 + MS_COLS * 3, i11 = i10 + 3
  for (let c = 0; c < 3; c++) out[c] = (table[i00 + c] * (1 - b) + table[i01 + c] * b) * (1 - a) + (table[i10 + c] * (1 - b) + table[i11 + c] * b) * a
}

/**
 * The sky for the sun at elevation `sunElevation`, rad (negative below the horizon), with the aerosol extinction at the
 * ground `haze` (1/km, hazeExtinction) over ground of albedo `albedo`.
 */
export function computeSky(sunElevation: number, haze: number, albedo: number): SkyState {
  const ms = multiple(haze, albedo), mus = Math.sin(sunElevation), sun: V3 = [Math.cos(sunElevation), mus, 0]
  const sky = new Float32Array(SKY_ROWS * SKY_COLS * 3)
  const r0 = EARTH + VIEWER, n = 24, e = [0, 1, 2].map(c => extinctions(haze, c)), edge = Math.sin(SUN_RADIUS), M = [0, 0, 0]
  for (let row = 0; row < SKY_ROWS; row++) {
    const el = rowElevation(row / (SKY_ROWS - 1)), ce = Math.cos(el), se = Math.sin(el)
    const len = toSphere(r0, se, TOP)
    for (let col = 0; col < SKY_COLS; col++) {
      const az = col / (SKY_COLS - 1) * Math.PI, d: V3 = [ce * Math.cos(az), se, ce * Math.sin(az)], cosT = d[0] * sun[0] + d[1] * sun[1]
      const pr = rayleighPhase(cosT), pm = miePhase(cosT), L = [0, 0, 0], T = [1, 1, 1]
      for (let k = 0; k < n; k++) {
        // Steps finer near the viewer (the dense low air; the long grazing paths of a low view).
        const a = ((k / n) ** 2) * len, b = (((k + 1) / n) ** 2) * len, t = (a + b) / 2, ds = b - a
        const px = d[0] * t, py = r0 + d[1] * t, pz = d[2] * t, r = Math.hypot(px, py, pz), h = r - EARTH, rho = densities(h)
        // The sun at the sample (as sunTransmittance, inline: this loop runs ~25 000 times).
        const smu = (sun[0] * px + sun[1] * py) / r, mh = horizonMu(r), seen = smooth((smu - mh + edge) / (2 * edge)), st = seen > 0 ? columnTo(r, Math.max(smu, mh)) : null
        multipleAt(ms, h, smu, M)
        for (let c = 0; c < 3; c++) {
          const ext = Math.max(e[c][0] * rho[0] + e[c][1] * rho[1] + e[c][2] * rho[2], 1e-9), sr = RAYLEIGH[c] * rho[0], sm = haze * rho[1], sunT = st ? transmitColumn(st, haze, c) * seen : 0
          const S = sunT * (sr * pr + sm * pm) + M[c] * (sr + sm), step = Math.exp(-ext * ds)
          L[c] += T[c] * S * (1 - step) / ext; T[c] *= step
        }
      }
      sky.set(L, (row * SKY_COLS + col) * 3)
    }
  }
  // Irradiance of the sky on the horizontal: the table integrated over the upper hemisphere (both halves of the azimuth).
  const skyIrradiance: V3 = [0, 0, 0]
  for (let row = 0; row < SKY_ROWS - 1; row++) {
    const e0 = rowElevation(row / (SKY_ROWS - 1)), e1 = rowElevation((row + 1) / (SKY_ROWS - 1)), em = (e0 + e1) / 2
    // Solid angle of the band times the cosine to the zenith, shared out over its columns (x2 for the mirrored half).
    const band = 2 * Math.PI * (Math.sin(e1) - Math.sin(e0)) * Math.sin(em) / SKY_COLS
    for (let col = 0; col < SKY_COLS; col++) for (let c = 0; c < 3; c++) skyIrradiance[c] += band * (sky[(row * SKY_COLS + col) * 3 + c] + sky[((row + 1) * SKY_COLS + col) * 3 + c]) / 2
  }
  const sunByHeight = new Float32Array(SUN_LEVELS * 3)
  for (let i = 0; i < SUN_LEVELS; i++) sunByHeight.set(sunTransmittance(i / (SUN_LEVELS - 1) * SUN_TOP, mus, haze), i * 3)
  const ground = sunTransmittance(VIEWER, mus, haze), sunIrradiance = ground.map(t => t * Math.max(mus, 0)) as V3
  return { sky, sunByHeight, skyIrradiance, sunIrradiance, haze }
}

/** Luminance (Rec. 709 weights) of an RGB triple. */
export const luminance = (c: ArrayLike<number>) => .2126 * c[0] + .7152 * c[1] + .0722 * c[2]

/**
 * The eye's adaptation: how much brighter than the noon's the view is drawn for a ground irradiance `light` (sun and sky,
 * relative to the sun above the air). Partial (the cube root of the ratio: at sunset the view is darker, in the deep
 * twilight dark), up to ADAPT_MAX; below that the night floor (view.ts) takes over. In the full day the view is drawn
 * NOON_DIM as bright, as a camera stops down in the sun (the testers and the user 19.10.2026: the noon sky glared
 * and the clouds were lost in it), back to full from DIM_UNTIL (the sun ~10° high), so the evening is as it was.
 */
export const NOON_LIGHT = .8, ADAPT_MAX = 25, NOON_DIM = .75, DIM_UNTIL = 2
export function adaptation(light: number) {
  const a = Math.min(ADAPT_MAX, Math.max(1, Math.cbrt(NOON_LIGHT / Math.max(light, 1e-9))))
  return a * (NOON_DIM + (1 - NOON_DIM) * Math.min(1, (a - 1) / (DIM_UNTIL - 1)))
}
