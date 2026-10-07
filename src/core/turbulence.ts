import { CP, G, LV } from './constants'
import type { Grid } from './grid'

/**
 * Smagorinsky constant at the default slider value; the turbulence slider scales it. Tried 0.21 and 0.25 (WRF's value
 * for kilometre grids) on 2026-09-29 against weak-shear updraughts at 80-90 % of parcel theory: they bring those to
 * 60-75 %, but the weak left mover of the Weisman-Klemp split no longer forms. 0.18 is kept; the overshoot is a
 * resolution limit (entrainment by unresolved eddies), listed among the known limitations.
 */
export const SMAGORINSKY = .18
/** Turbulent Prandtl number: heat and moisture mix 3x faster than momentum. */
const PRANDTL = 1 / 3

/**
 * Smagorinsky-Lilly subgrid turbulence: eddy viscosity K = (Cs Δ)^2 sqrt(max(0, |S|^2 - N^2 / Pr)) from the resolved
 * deformation |S| and the stratification N^2 (no mixing where the air is stable enough), Δ = (dx dy dz)^(1/3).
 * Mixes the departures from the base state (so the imposed environment stays steady) in all three directions with
 * rho0-weighted vertical fluxes; no turbulent flux through the ground and top (surface fluxes are applied separately).
 */
export class Turbulence {
  private readonly grid: Grid; private readonly rho: Float64Array
  /** Eddy viscosity for momentum at each node, m2/s. */
  readonly km: Float64Array
  private readonly tmp: Float32Array
  /** Control-volume height of each level (the ground and top nodes own half a layer). */
  private readonly h: Float64Array

  constructor(grid: Grid, rho: ArrayLike<number>) {
    this.grid = grid; this.rho = Float64Array.from(rho)
    this.km = new Float64Array(grid.n); this.tmp = new Float32Array(grid.n)
    this.h = grid.hz
  }

  /**
   * Computes K from the current wind and potential temperature (thetaEnv per level for N^2). With `moist` (vapour,
   * cloud condensate, Exner function per level), N^2 in cloudy air is the saturated one, g/theta_e dtheta_e/dz: a cloud
   * on a moist adiabat is near-neutral, while the dry N^2 there is strongly stable and switched the mixing off inside
   * updraughts (no entrainment, parcel-like updraughts).
   */
  viscosity(u: Float32Array, v: Float32Array, w: Float32Array, theta: Float32Array, thetaEnv: ArrayLike<number>, cs: number, dt: number,
    moist?: { q: Float32Array; condensate: Float32Array; exner: ArrayLike<number> }) {
    const { nx, ny, nz, dx, dy, zs, dzs, hz, layer, xp, xm, yp, ym } = this.grid, km = this.km
    for (let z = 0, i = 0; z < nz; z++) {
      // Filter width from the local vertical spacing (the spacing next to the ground and top nodes, which own half a layer).
      const local = z === 0 ? dzs[0] : z === nz - 1 ? dzs[nz - 2] : hz[z], len2 = (cs * Math.cbrt(dx * dy * local)) ** 2
      // Explicit-stability cap from the spacings around this level. It was one cap from the smallest spacing anywhere:
      // on the stretched grid (100 m at the ground) that held K <= 500 m2/s even at 2-8 km, in ~20 % of the updraught
      // nodes (2026-10-07) — the cores' edges, where entrainment happens — and updraughts neared parcel theory.
      const cap = .05 * Math.min(dx, dy, z > 0 ? dzs[z - 1] : Infinity, z < nz - 1 ? dzs[z] : Infinity) ** 2 / dt
      const up = z < nz - 1 ? layer : 0, down = z > 0 ? -layer : 0, span = zs[z + (up ? 1 : 0)] - zs[z - (down ? 1 : 0)]
      for (let y = 0; y < ny; y++) {
        const row = y * nx + z * layer
        for (let x = 0; x < nx; x++, i++) {
          const e = xp[x] + row, wst = xm[x] + row, n = x + yp[y] + z * layer, s = x + ym[y] + z * layer
          const dudx = (u[e] - u[wst]) / (2 * dx), dvdy = (v[n] - v[s]) / (2 * dy), dwdz = (w[i + up] - w[i + down]) / span
          const dudy = (u[n] - u[s]) / (2 * dy), dvdx = (v[e] - v[wst]) / (2 * dx)
          const dudz = (u[i + up] - u[i + down]) / span, dwdx = (w[e] - w[wst]) / (2 * dx)
          const dvdz = (v[i + up] - v[i + down]) / span, dwdy = (w[n] - w[s]) / (2 * dy)
          const s2 = 2 * (dudx * dudx + dvdy * dvdy + dwdz * dwdz) + (dudy + dvdx) ** 2 + (dudz + dwdx) ** 2 + (dvdz + dwdy) ** 2
          let n2 = G / thetaEnv[z] * (theta[i + up] - theta[i + down]) / span
          if (moist && moist.condensate[i] > 1e-5) {
            const te = (k: number, level: number) => theta[k] * Math.exp(LV * moist.q[k] / (CP * theta[k] * moist.exner[level]))
            n2 = G / te(i, z) * (te(i + up, z + (up ? 1 : 0)) - te(i + down, z - (down ? 1 : 0))) / span
          }
          // Capped for explicit stability: scalars mix 3x faster, three directions add up.
          km[i] = Math.min(cap, len2 * Math.sqrt(Math.max(0, s2 - n2 / PRANDTL)))
        }
      }
    }
  }

  /**
   * Diffuses the departure of `a` from its base-state profile `base` (per level; null for w) with K times `factor`
   * (1 for momentum, 1/Pr for scalars): da/dt = (1/rho0) div(rho0 K grad a').
   */
  mix(a: Float32Array, base: ArrayLike<number> | null, factor: number, dt: number) {
    const { nx, ny, nz, dx, dy, layer, xp, yp } = this.grid, km = this.km, t = this.tmp, rho = this.rho, h = this.h
    t.fill(0)
    const dev = (i: number, z: number) => a[i] - (base ? base[z] : 0)
    for (let z = 0, i = 0; z < nz; z++) {
      const rUp = z < nz - 1 ? (rho[z] + rho[z + 1]) / 2 : 0
      for (let y = 0; y < ny; y++) {
        const row = y * nx + z * layer
        for (let x = 0; x < nx; x++, i++) {
          const here = dev(i, z)
          // Flux towards +x, +y, +z through the face shared with the next node; each face is visited once.
          const e = xp[x] + row, n = x + yp[y] + z * layer
          const fx = factor * (km[i] + km[e]) / 2 * (dev(e, z) - here) / dx
          t[i] += fx / dx; t[e] -= fx / dx
          const fy = factor * (km[i] + km[n]) / 2 * (dev(n, z) - here) / dy
          t[i] += fy / dy; t[n] -= fy / dy
          if (z < nz - 1) {
            const fz = factor * rUp * (km[i] + km[i + layer]) / 2 * (dev(i + layer, z + 1) - here) / this.grid.dzs[z]
            t[i] += fz / (rho[z] * h[z]); t[i + layer] -= fz / (rho[z + 1] * h[z + 1])
          }
        }
      }
    }
    for (let i = 0; i < a.length; i++) a[i] += dt * t[i]
  }
}
