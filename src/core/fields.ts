import type { AtmosphereModel } from './model'

export type ScalarField = 'updraft' | 'theta' | 'moisture' | 'vorticity' | 'helicity' | 'coldpool'

/**
 * Fills `out` (one value per grid node) with a diagnostic field in physical units:
 * updraft m/s, theta = temperature departure from the environment K, moisture = RH %,
 * vorticity 1e-3 s-1, helicity = column UH m2/s2 drawn only in its 2-5 km layer, coldpool K.
 */
export function computeScalarField(model: AtmosphereModel, field: ScalarField, out: Float32Array) {
  const { nx, ny, nz, dz } = model.grid, env = model.env, [uh0, uh1] = model.uhLevels
  for (let z = 0, i = 0; z < nz; z++) {
    const alt = z * dz, exner = env.exner[z], thEnv = env.theta[z]
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      switch (field) {
        case 'updraft': out[i] = model.w[i]; break
        case 'theta': out[i] = (model.theta[i] - thEnv) * exner; break
        case 'moisture': out[i] = 100 * model.q[i] / Math.max(1e-5, env.qsat(model.theta[i] * exner - 273.15, alt)); break
        case 'vorticity': out[i] = 1000 * model.zeta(x, y, z); break
        case 'helicity': out[i] = z >= uh0 && z <= uh1 ? model.uhColumn[x + nx * y] : 0; break
        case 'coldpool': out[i] = model.cold[i]; break
      }
    }
  }
}
