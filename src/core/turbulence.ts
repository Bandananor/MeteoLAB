import { CP, G, LV } from './constants'
import type { Grid } from './grid'
import { type Memory, PRIVATE_MEMORY } from './threads'

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
  /** Eddy viscosity for momentum at each node, m2/s (vertical mixing; also horizontal unless `anisotropic`). */
  readonly km: Float64Array
  /** Horizontal eddy viscosity, m2/s: km itself, or with the horizontal filter width when `anisotropic`. */
  readonly kh: Float64Array
  /**
   * Horizontal mixing with the horizontal filter width sqrt(dx dy) instead of (dx dy dz)^(1/3) (experiment 2026-10-07; the
   * model's default since 2026-10-09, AtmosphereModel.turbulenceWidth).
   * On the stretched grid the cube-root width shrank with dz (~0.8x at 5 km, K ~0.65x), so the lateral entrainment into
   * updraughts, which the 1.2 km horizontal spacing governs, weakened, and updraughts gained 7-8 m/s.
   */
  anisotropic = false
  /**
   * Filter width of the vertical mixing (experiment 30.10.2026, AtmosphereModel.verticalLength): 'cube' (dx dy dz)^(1/3),
   * the model's, or 'dz' the local vertical spacing alone when dx is much larger than dz, as WRF's km_opt = 3 with
   * mix_isotropic = 0 (one deformation for both; CM1's tconfig = 2 also splits the deformation). Only with `anisotropic`,
   * where km mixes the vertical alone. With the cube root the vertical K grows with dx while the explicit cap is set by dz: in cloud
   * below 1 km the cap holds 69-79 % of the nodes on 1.2 km and 97-98 % on 2 km (tests/bench/kcap.ts).
   */
  verticalLength: 'cube' | 'dz' = 'cube'
  /**
   * Vertical diffusion implicit in each column (backward Euler, a tridiagonal solve per field), so the vertical K needs
   * no explicit-stability cap (experiment 30.10.2026, AtmosphereModel.verticalMixing; CM1's doimpl does it Crank-
   * Nicolson). Only with `anisotropic`, where km mixes the vertical alone; the horizontal stays explicit with its cap.
   */
  implicitVertical = false
  private readonly tmp: Float32Array
  /** Scratch of the implicit vertical solve: the coefficients and the right-hand side of one column. */
  private readonly lower: Float64Array; private readonly upper: Float64Array; private readonly diag: Float64Array; private readonly rhs: Float64Array
  /** Control-volume height of each level (the ground and top nodes own half a layer). */
  private readonly h: Float64Array

  /** `memory` holds the eddy viscosities, which helper threads read (see threads.ts). */
  constructor(grid: Grid, rho: ArrayLike<number>, memory: Memory = PRIVATE_MEMORY) {
    this.grid = grid; this.rho = Float64Array.from(rho)
    this.km = memory.f64('km', grid.n); this.kh = memory.f64('kh', grid.n); this.tmp = new Float32Array(grid.n)
    this.lower = new Float64Array(grid.nz); this.upper = new Float64Array(grid.nz); this.diag = new Float64Array(grid.nz); this.rhs = new Float64Array(grid.nz)
    this.h = grid.hz
  }

  /**
   * Computes K from the current wind and potential temperature (thetaEnv per level for N^2). With `moist` (vapour,
   * cloud condensate, Exner function per level), N^2 in cloudy air is the saturated one, g/theta_e dtheta_e/dz: a cloud
   * on a moist adiabat is near-neutral, while the dry N^2 there is strongly stable and switched the mixing off inside
   * updraughts (no entrainment, parcel-like updraughts).
   */
  viscosity(u: Float32Array, v: Float32Array, w: Float32Array, theta: Float32Array, thetaEnv: ArrayLike<number>, cs: number, dt: number,
    moist?: { q: Float32Array; condensate: Float32Array; exner: ArrayLike<number> }, z0 = 0, z1 = this.grid.nz) {
    const { nx, ny, nz, dx, dy, zs, dzs, hz, layer, xp, xm, yp, ym } = this.grid, km = this.km, kh = this.kh
    // Horizontal filter width and stability cap of the anisotropic option (horizontal fluxes only see dx and dy).
    const lenH2 = (cs * Math.sqrt(dx * dy)) ** 2, capH = .05 * Math.min(dx, dy) ** 2 / dt, implicit = this.implicitVertical && this.anisotropic
    for (let z = z0, i = z0 * layer; z < z1; z++) {
      // Filter width from the local vertical spacing (the spacing next to the ground and top nodes, which own half a layer).
      const local = z === 0 ? dzs[0] : z === nz - 1 ? dzs[nz - 2] : hz[z], len2 = (cs * (this.anisotropic && this.verticalLength === 'dz' ? local : Math.cbrt(dx * dy * local))) ** 2
      // Explicit-stability cap from the spacings around this level. It was one cap from the smallest spacing anywhere:
      // on the stretched grid (100 m at the ground) that held K <= 500 m2/s even at 2-8 km, in ~20 % of the updraught
      // nodes (2026-10-07) — the cores' edges, where entrainment happens — and updraughts neared parcel theory.
      const cap = implicit ? Infinity : .05 * Math.min(dx, dy, z > 0 ? dzs[z - 1] : Infinity, z < nz - 1 ? dzs[z] : Infinity) ** 2 / dt
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
          const rate = Math.sqrt(Math.max(0, s2 - n2 / PRANDTL))
          km[i] = Math.min(cap, len2 * rate); kh[i] = this.anisotropic ? Math.min(capH, lenH2 * rate) : km[i]
        }
      }
    }
  }

  /**
   * Diffuses the departure of `a` from its base-state profile `base` (per level; null for w) with K times `factor`
   * (1 for momentum, 1/Pr for scalars): da/dt = (1/rho0) div(rho0 K grad a').
   */
  mix(a: Float32Array, base: ArrayLike<number> | null, factor: number, dt: number) {
    const { nx, ny, nz, dx, dy, layer, xp, yp } = this.grid, km = this.km, kh = this.kh, t = this.tmp, rho = this.rho, h = this.h
    t.fill(0)
    const dev = (i: number, z: number) => a[i] - (base ? base[z] : 0), implicit = this.implicitVertical && this.anisotropic
    for (let z = 0, i = 0; z < nz; z++) {
      const rUp = z < nz - 1 ? (rho[z] + rho[z + 1]) / 2 : 0
      for (let y = 0; y < ny; y++) {
        const row = y * nx + z * layer
        for (let x = 0; x < nx; x++, i++) {
          const here = dev(i, z)
          // Flux towards +x, +y, +z through the face shared with the next node; each face is visited once.
          const e = xp[x] + row, n = x + yp[y] + z * layer
          const fx = factor * (kh[i] + kh[e]) / 2 * (dev(e, z) - here) / dx
          t[i] += fx / dx; t[e] -= fx / dx
          const fy = factor * (kh[i] + kh[n]) / 2 * (dev(n, z) - here) / dy
          t[i] += fy / dy; t[n] -= fy / dy
          if (z < nz - 1 && !implicit) {
            const fz = factor * rUp * (km[i] + km[i + layer]) / 2 * (dev(i + layer, z + 1) - here) / this.grid.dzs[z]
            t[i] += fz / (rho[z] * h[z]); t[i + layer] -= fz / (rho[z + 1] * h[z + 1])
          }
        }
      }
    }
    for (let i = 0; i < a.length; i++) a[i] += dt * t[i]
    if (implicit) this.mixVertical(a, base, factor, dt)
  }

  /**
   * The vertical part of `mix`, implicit: per column (I - dt L) a' = a' with L a' = (1/(rho0 h)) d/dz(rho0 K da'/dz), the
   * same fluxes as the explicit form, solved by the Thomas algorithm; no flux through the ground and top.
   */
  private mixVertical(a: Float32Array, base: ArrayLike<number> | null, factor: number, dt: number) {
    const { nz, layer, dzs } = this.grid, km = this.km, rho = this.rho, h = this.h, lo = this.lower, up = this.upper, dg = this.diag, r = this.rhs
    for (let c = 0; c < layer; c++) {
      for (let z = 0; z < nz; z++) { lo[z] = 0; up[z] = 0; r[z] = a[c + z * layer] - (base ? base[z] : 0) }
      for (let z = 0; z < nz - 1; z++) {
        // The face between z and z + 1: its coefficient, divided by each side's mass.
        const i = c + z * layer, face = dt * factor * (rho[z] + rho[z + 1]) / 2 * (km[i] + km[i + layer]) / 2 / dzs[z]
        up[z] = face / (rho[z] * h[z]); lo[z + 1] = face / (rho[z + 1] * h[z + 1])
      }
      for (let z = 0; z < nz; z++) dg[z] = 1 + lo[z] + up[z]
      // Forward elimination, then back substitution (diagonally dominant: no pivoting).
      for (let z = 1; z < nz; z++) { const f = lo[z] / dg[z - 1]; dg[z] -= f * up[z - 1]; r[z] += f * r[z - 1] }
      r[nz - 1] /= dg[nz - 1]
      for (let z = nz - 2; z >= 0; z--) r[z] = (r[z] + up[z] * r[z + 1]) / dg[z]
      for (let z = 0; z < nz; z++) a[c + z * layer] = r[z] + (base ? base[z] : 0)
    }
  }
}
