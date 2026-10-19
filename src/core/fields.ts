import { L } from '../i18n'
import type { AtmosphereModel } from './model'
import { OUTFLOW_WARM } from './rkw'

export type ScalarField = 'updraft' | 'theta' | 'moisture' | 'vorticity' | 'helicity' | 'coldpool'

/** Layer of the updraft helicity map: the model's own 2-5 km, the low levels, or the whole updraught (wherever w > 0). */
export type UhLayer = '2-5' | '0-1' | '0-3' | 'deep'
/** Heights (m), a label and the colour scale (m²/s²) of each UH layer. */
export const UH_LAYERS: Record<UhLayer, { label: string; from: number; to: number; scale: number }> = {
  '2-5': { label: L('2–5 км: средний мезоциклон', '2–5 km: mid-level mesocyclone'), from: 2000, to: 5000, scale: 300 },
  '0-1': { label: L('0–1 км: вращение у земли, признак смерчевой опасности', '0–1 km: rotation at the ground, a sign of tornado danger'), from: 0, to: 1000, scale: 75 },
  '0-3': { label: L('0–3 км: нижний мезоциклон', '0–3 km: low-level mesocyclone'), from: 0, to: 3000, scale: 200 },
  deep: { label: L('весь восходящий поток, где w > 0', 'the whole updraught, where w > 0'), from: 0, to: Infinity, scale: 600 },
}

/**
 * Fills `out` (one value per grid node) with a diagnostic field in physical units:
 * updraft m/s, theta = temperature departure from the environment K, moisture = RH %,
 * vorticity 1e-3 s-1, helicity = column UH m2/s2 of `uhLayer` drawn only in that layer, coldpool K: the θv deficit
 * below COLD_POOL_TOP against the warm air of the level (its OUTFLOW_WARM percentile), as rkw.ts outflowDeficit at the
 * ground (2.8: was the cold-pool indicator, the cooling gathered, which can be half or twice the real difference).
 */
export function computeScalarField(model: AtmosphereModel, field: ScalarField, out: Float32Array, uhLayer: UhLayer = '2-5') {
  const { nx, ny, nz } = model.grid, env = model.env, [uh0, uh1] = model.uhLevels
  if (field === 'helicity' && uhLayer !== '2-5') { columnHelicity(model, uhLayer, out); return }
  if (field === 'coldpool') { coldPool(model, out); return }
  for (let z = 0, i = 0; z < nz; z++) {
    const alt = model.grid.zs[z], exner = env.exner[z], thEnv = model.envNow(z)[0]
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      switch (field) {
        case 'updraft': out[i] = model.w[i]; break
        case 'theta': out[i] = (model.theta[i] - thEnv) * exner; break
        case 'moisture': out[i] = 100 * model.q[i] / Math.max(1e-5, env.qsat(model.theta[i] * exner - 273.15, alt)); break
        case 'vorticity': out[i] = 1000 * model.zeta(x, y, z); break
        case 'helicity': out[i] = z >= uh0 && z <= uh1 ? model.uhColumn[x + nx * y] : 0; break
      }
    }
  }
}

/** The cold pool is looked for up to this height, m (outflows are 1-3 km deep; above, the anvil's cool air is not one). */
export const COLD_POOL_TOP = 3000

function coldPool(model: AtmosphereModel, out: Float32Array) {
  const { nz, layer, zs } = model.grid, thv = new Float32Array(layer)
  out.fill(0)
  for (let z = 0; z < nz && zs[z] <= COLD_POOL_TOP; z++) {
    const at = z * layer
    for (let c = 0; c < layer; c++) thv[c] = model.theta[at + c] * (1 + .61 * model.q[at + c])
    const warm = Float32Array.from(thv).sort()[Math.floor((layer - 1) * OUTFLOW_WARM)]
    for (let c = 0; c < layer; c++) out[at + c] = Math.max(0, warm - thv[c])
  }
}

/**
 * UH of the low layers or of the whole updraught, Σ w ζ hz per column, drawn at the nodes of its layer (for the whole
 * updraught: where w > 0). The 2-5 km one is the model's own (uhColumn); these are computed from the current fields.
 */
function columnHelicity(model: AtmosphereModel, uhLayer: UhLayer, out: Float32Array) {
  const { nx, ny, nz, layer, zs, hz } = model.grid, { from, to } = UH_LAYERS[uhLayer], deep = uhLayer === 'deep', col = new Float64Array(layer)
  const inLayer = (z: number, i: number) => deep ? model.w[i] > 0 : zs[z] >= from && zs[z] <= to
  for (let z = 1, i = layer; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) if (inLayer(z, i)) col[x + nx * y] += model.w[i] * model.zeta(x, y, z) * hz[z]
  for (let z = 0, i = 0; z < nz; z++) for (let c = 0; c < layer; c++, i++) out[i] = z > 0 && inLayer(z, i) ? col[c] : 0
}
