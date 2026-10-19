// The weather satellite's view of the domain (2.8), from the model's own fields, column by column from the top:
// the visible channel (sunlight reflected by the clouds) and the infrared window channel (10.8 µm: the temperature of
// what the satellite sees — the cloud top, or the ground through clear air), with the overshooting tops forecasters look
// for in it. No water vapour absorption (a window channel), no cloud shadows or slant view (the satellite looks straight
// down), no scattering between columns: each column is a plane-parallel layer.
import type { AtmosphereModel } from './model'

type Species = 'cloud' | 'ice' | 'snow' | 'rain' | 'graupel' | 'hail'
/**
 * Visible extinction per mass, 3 / (2 ρ_particle r_e), m²/kg: cloud droplets r_e 10 µm, cloud ice 30 µm, snow 300 µm, rain
 * 1 mm, graupel 1.5 mm, hail 5 mm — the small particles make the cloud's brightness, the big ones hardly count.
 */
export const VIS_EXTINCTION: Record<Species, number> = { cloud: 150, ice: 55, snow: 5, rain: 1.5, graupel: 1, hail: .3 }
/** Infrared (10.8 µm) absorption per mass, m²/kg: liquid water 158 (Stephens 1978: ε = 1 − exp(−0.158 LWP g/m²)), ice about a fifth of its visible extinction's share. */
export const IR_ABSORPTION: Record<Species, number> = { cloud: 158, ice: 30, snow: 3, rain: 1, graupel: .5, hail: .2 }
/** Reflectance of a cloud of optical depth τ (two-stream, asymmetry 0.85): τ / (τ + 13.3). */
export const cloudReflectance = (tau: number) => tau / (tau + 13.3)
/** The ground's visible albedo (grass and fields). */
export const GROUND_ALBEDO = .15
/** An overshooting top (Bedka et al. 2010): at most this cold, °C, and colder than the anvil 5-10 km around by at least OT_CONTRAST K. */
export const OT_COLDEST = -50, OT_CONTRAST = 6.5

export interface SatelliteImage {
  /** Visible reflectance seen from above, 0-1, times the sunlight (the sine of the sun's elevation; 0 at night). */ visible: Float32Array
  /** Brightness temperature of the infrared window channel, °C. */ infrared: Float32Array
  /** Optical depth of the column (visible). */ tau: Float32Array
}

type SatelliteSource = Pick<AtmosphereModel, 'grid' | 'env' | 'theta' | Species>

/** The satellite image of the model's domain now; `sun` the sine of the sun's elevation (clamped to 0-1). */
export function satelliteImage(m: SatelliteSource, sun: number): SatelliteImage {
  const { layer, nz, hz } = m.grid, light = Math.max(0, Math.min(1, sun))
  const visible = new Float32Array(layer), infrared = new Float32Array(layer), tau = new Float32Array(layer)
  const species = Object.keys(VIS_EXTINCTION) as Species[]
  for (let c = 0; c < layer; c++) {
    let t = 0, through = 1, bright = 0
    for (let k = nz - 1; k >= 0; k--) {
      const i = c + k * layer, rho = m.env.rho[k]
      let vis = 0, ir = 0
      for (const s of species) { const q = m[s][i]; if (q > 0) { vis += VIS_EXTINCTION[s] * q; ir += IR_ABSORPTION[s] * q } }
      t += vis * rho * hz[k]
      // Emission of the layer seen through the layers above (linear in temperature: a few K off the radiance's average).
      const e = 1 - Math.exp(-ir * rho * hz[k]), temp = m.theta[i] * m.env.exner[k] - 273.15
      bright += through * e * temp; through *= 1 - e
    }
    // The ground through what is left: the lowest node's air (no skin temperature in the model).
    infrared[c] = bright + through * (m.theta[c] * m.env.exner[0] - 273.15)
    const r = cloudReflectance(t)
    visible[c] = light * (r + (1 - r) ** 2 * GROUND_ALBEDO / (1 - r * GROUND_ALBEDO)); tau[c] = t
  }
  return { visible, infrared, tau }
}

export interface OvershootingTop { column: number; temperature: number; contrast: number }

/**
 * Overshooting tops in the infrared (Bedka et al. 2010, in outline): a local minimum of the brightness temperature at
 * most OT_COLDEST, colder by OT_CONTRAST or more than the mean of the cold anvil (below -40 °C) 5-10 km around — the
 * updraught's dome pushed above the anvil into the stratosphere. On the ~1 km grid a dome is one or two columns.
 */
export function overshootingTops(m: Pick<AtmosphereModel, 'grid'>, infrared: Float32Array): OvershootingTop[] {
  const { nx, ny, dx, dy } = m.grid, out: OvershootingTop[] = [], rx = Math.ceil(10_000 / dx), ry = Math.ceil(10_000 / dy)
  const at = (x: number, y: number) => infrared[((x % nx) + nx) % nx + nx * (((y % ny) + ny) % ny)]
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const t = at(x, y)
    if (t > OT_COLDEST) continue
    let minimum = true
    for (let j = -1; j <= 1 && minimum; j++) for (let i = -1; i <= 1; i++) if ((i || j) && at(x + i, y + j) < t) { minimum = false; break }
    if (!minimum) continue
    let sum = 0, n = 0
    for (let j = -ry; j <= ry; j++) for (let i = -rx; i <= rx; i++) {
      const r = Math.hypot(i * dx, j * dy), v = at(x + i, y + j)
      if (r >= 5000 && r <= 10_000 && v <= -40) { sum += v; n++ }
    }
    if (n && sum / n - t >= OT_CONTRAST) out.push({ column: x + nx * y, temperature: t, contrast: sum / n - t })
  }
  return out
}
