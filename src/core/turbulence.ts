import { CP, EPS, G, LV, RD } from './constants'
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
  /**
   * The stability of cloudy air (experiment 10.11.2026, AtmosphereModel.moistStability). 'thetae': g / theta_e
   * d theta_e / dz, the model's. 'durran-klemp': the saturated Brunt-Väisälä frequency of Durran & Klemp (1982, eq. 36),
   * N² = g { (1 + L q_s / (R_d T)) / (1 + eps L² q_s / (c_p R_d T²)) (d ln theta / dz + L / (c_p T) d q_s / dz) - d q_w / dz },
   * q_w the vapour and the cloud condensate — CM1's. The theta_e form is its bracket without the factor in front (0.4-0.5
   * in a warm cloud base, towards 1 aloft) and without the total-water term: stability and instability alike come out
   * about twice as strong low in a cloud. Used where the node and both its neighbours above and below are cloudy.
   */
  moistStability: 'thetae' | 'durran-klemp' = 'thetae'
  /**
   * Terrain's solid nodes (terrain.ts solidMask), or null: no turbulent flux through a face next to a solid node, as
   * through the flat ground (the surface fluxes enter at the first fluid node instead).
   */
  solid: Uint8Array | null = null
  /** With terrain: each node's control-volume height (terrain.ts nodeHeights; a ground node owns its volume above the ground). */
  private heights: Float64Array | null = null

  /** Sets the terrain: the solid nodes and every node's control-volume height. */
  setTerrain(solid: Uint8Array, heights: Float64Array) { this.solid = solid; this.heights = heights }
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
    const lenH2 = (cs * Math.sqrt(dx * dy)) ** 2, capH = .05 * Math.min(dx, dy) ** 2 / dt, implicit = this.implicitVertical && this.anisotropic, saturated = this.moistStability === 'durran-klemp'
    for (let z = z0, i = z0 * layer; z < z1; z++) {
      // Filter width from the local vertical spacing (the spacing next to the ground and top nodes, which own half a layer).
      const local = z === 0 ? dzs[0] : z === nz - 1 ? dzs[nz - 2] : hz[z], len2 = (cs * (this.anisotropic && this.verticalLength === 'dz' ? local : Math.cbrt(dx * dy * local))) ** 2
      // Explicit-stability cap from the spacings around this level. It was one cap from the smallest spacing anywhere:
      // on the stretched grid (100 m at the ground) that held K <= 500 m2/s even at 2-8 km, in ~20 % of the updraught
      // nodes (2026-10-07) — the cores' edges, where entrainment happens — and updraughts neared parcel theory.
      const cap = implicit ? Infinity : .05 * Math.min(dx, dy, z > 0 ? dzs[z - 1] : Infinity, z < nz - 1 ? dzs[z] : Infinity) ** 2 / dt
      const up = z < nz - 1 ? layer : 0, below = z > 0 ? -layer : 0, levelSpan = zs[z + (up ? 1 : 0)] - zs[z - (below ? 1 : 0)], solid = this.solid
      for (let y = 0; y < ny; y++) {
        const row = y * nx + z * layer
        for (let x = 0; x < nx; x++, i++) {
          let e = xp[x] + row, wst = xm[x] + row, n = x + yp[y] + z * layer, s = x + ym[y] + z * layer, hx = 2 * dx, hy = 2 * dy, down = below, span = levelSpan
          if (solid) {
            // Terrain: a solid node mixes nothing (all its faces are closed, see mix); a solid neighbour is a wall, so the
            // differences are one-sided towards the fluid, as the flat ground's z = 0 (the numerics review 24.11.2026: the
            // central difference through the frozen node made N² 6x too large over a sunlit plateau and damped the mixing).
            if (solid[i]) { km[i] = 0; kh[i] = 0; continue }
            if (solid[e] || solid[wst]) { const open = +!solid[e] + +!solid[wst]; if (solid[e]) e = i; if (solid[wst]) wst = i; hx = open * dx || dx }
            if (solid[n] || solid[s]) { const open = +!solid[n] + +!solid[s]; if (solid[n]) n = i; if (solid[s]) s = i; hy = open * dy || dy }
            if (down && solid[i + down]) { down = 0; span = zs[z + (up ? 1 : 0)] - zs[z] }
          }
          const dudx = (u[e] - u[wst]) / hx, dvdy = (v[n] - v[s]) / hy, dwdz = (w[i + up] - w[i + down]) / span
          const dudy = (u[n] - u[s]) / hy, dvdx = (v[e] - v[wst]) / hx
          const dudz = (u[i + up] - u[i + down]) / span, dwdx = (w[e] - w[wst]) / hx
          const dvdz = (v[i + up] - v[i + down]) / span, dwdy = (w[n] - w[s]) / hy
          const s2 = 2 * (dudx * dudx + dvdy * dvdy + dwdz * dwdz) + (dudy + dvdx) ** 2 + (dudz + dwdx) ** 2 + (dvdz + dwdy) ** 2
          let n2 = G / thetaEnv[z] * (theta[i + up] - theta[i + down]) / span
          if (moist && moist.condensate[i] > 1e-5 && saturated && moist.condensate[i + up] > 1e-5 && moist.condensate[i + down] > 1e-5) {
            // Inside the cloud only, both neighbours cloudy: there the vapour is the saturation value (the adjustment keeps
            // it there), which the formula is derived for. At the cloud's edge a neighbour's vapour is not q_s and the jump
            // of q_w is of first order (the numerics review 10.11.2026: at a cloud top the sign of N² turned on it), so the
            // edge keeps the theta_e form below. Ice counts as cloud with L_v (a few per cent in N² in an anvil).
            const a = i + up, b = i + down, t = theta[i] * moist.exner[z], qs = moist.q[i]
            const factor = (1 + LV * qs / (RD * t)) / (1 + EPS * LV * LV * qs / (CP * RD * t * t))
            n2 = G * (factor * ((theta[a] - theta[b]) / theta[i] + LV / (CP * t) * (moist.q[a] - moist.q[b])) - (moist.q[a] + moist.condensate[a] - moist.q[b] - moist.condensate[b])) / span
          } else if (moist && moist.condensate[i] > 1e-5) {
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
    const dev = (i: number, z: number) => a[i] - (base ? base[z] : 0), implicit = this.implicitVertical && this.anisotropic, solid = this.solid, hn = this.heights
    for (let z = 0, i = 0; z < nz; z++) {
      const rUp = z < nz - 1 ? (rho[z] + rho[z + 1]) / 2 : 0
      for (let y = 0; y < ny; y++) {
        const row = y * nx + z * layer
        for (let x = 0; x < nx; x++, i++) {
          const here = dev(i, z)
          // Flux towards +x, +y, +z through the face shared with the next node; each face is visited once.
          const e = xp[x] + row, n = x + yp[y] + z * layer
          // With terrain a solid node shares no face with anything (its value never changes, nor its neighbours' by it).
          if (solid && solid[i]) continue
          if (hn) {
            // Terrain: each face's flux over its open height, each node's over its own. The mixing keeps the overlap of the
            // two volumes (min hn): the transport's shaved faces (terrain.ts faceApertures) reach up to 3.5x a thin cut
            // cell's height, which took the explicit diffusion number there past 1 at the K caps (numerics review 26.11.2026).
            const hi = hn[i]
            if (!solid![e]) { const fx = factor * (kh[i] + kh[e]) / 2 * (dev(e, z) - here) / dx, open = Math.min(hi, hn[e]); t[i] += fx * open / (hi * dx); t[e] -= fx * open / (hn[e] * dx) }
            if (!solid![n]) { const fy = factor * (kh[i] + kh[n]) / 2 * (dev(n, z) - here) / dy, open = Math.min(hi, hn[n]); t[i] += fy * open / (hi * dy); t[n] -= fy * open / (hn[n] * dy) }
            if (z < nz - 1 && !implicit && !solid![i + layer]) {
              // A thin cut cell (down to LEAST_SHARE of its layer) takes the vertical flux over its own height: the face's
              // K is kept to a diffusion number of 0.3 over the thinner node, level 0's on flat ground at the cap (the cap
              // sees the spacing, not the cell: 1.5 at a 10 m cell; numerics review 26.11.2026).
              const thin = Math.min(hi, hn[i + layer]), k = Math.min(factor * (km[i] + km[i + layer]) / 2, .3 * this.grid.dzs[z] * thin / dt)
              const fz = k * rUp * (dev(i + layer, z + 1) - here) / this.grid.dzs[z]
              t[i] += fz / (rho[z] * hi); t[i + layer] -= fz / (rho[z + 1] * hn[i + layer])
            }
            continue
          }
          if (!solid || !solid[e]) { const fx = factor * (kh[i] + kh[e]) / 2 * (dev(e, z) - here) / dx; t[i] += fx / dx; t[e] -= fx / dx }
          if (!solid || !solid[n]) { const fy = factor * (kh[i] + kh[n]) / 2 * (dev(n, z) - here) / dy; t[i] += fy / dy; t[n] -= fy / dy }
          if (z < nz - 1 && !implicit && (!solid || !solid[i + layer])) {
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
    const { nz, layer, dzs } = this.grid, km = this.km, rho = this.rho, h = this.h, lo = this.lower, up = this.upper, dg = this.diag, r = this.rhs, solid = this.solid, hn = this.heights
    for (let c = 0; c < layer; c++) {
      for (let z = 0; z < nz; z++) { lo[z] = 0; up[z] = 0; r[z] = a[c + z * layer] - (base ? base[z] : 0) }
      for (let z = 0; z < nz - 1; z++) {
        // The face between z and z + 1: its coefficient, divided by each side's mass.
        const i = c + z * layer, face = solid && (solid[i] || solid[i + layer]) ? 0 : dt * factor * (rho[z] + rho[z + 1]) / 2 * (km[i] + km[i + layer]) / 2 / dzs[z]
        // With terrain each node's own height (a solid node's face is closed: 0, kept off its zero height).
        up[z] = face / (rho[z] * (hn ? hn[i] || 1 : h[z])); lo[z + 1] = face / (rho[z + 1] * (hn ? hn[i + layer] || 1 : h[z + 1]))
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
