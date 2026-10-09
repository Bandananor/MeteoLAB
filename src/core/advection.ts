import type { Grid } from './grid'
import { HorizontalDFT } from './spectral'
import { type Memory, PRIVATE_MEMORY } from './threads'

/**
 * Flux-form transport with fifth-order WENO reconstruction (Jiang & Shu 1996) and the three-stage Runge-Kutta scheme
 * of Wicker & Skamarock (2002), as in research cloud models.
 *
 * Each node owns a control volume (the ground and top nodes half a layer); the mass flux through a face between two
 * nodes starts as rho0 times the mean of their velocities. The pressure projection makes the node velocities free of
 * the dual-cell divergence, which is not the same as the divergence of these face fluxes, so the face fluxes get their
 * own exact projection (the MAC projection of Bell, Colella & Glaz 1989): a Poisson problem on the node control volumes,
 * solved spectrally like the pressure. With divergence-free face fluxes the flux form both conserves mass exactly and
 * keeps a uniform field uniform; the tendency keeps the -q div(rho0 u) term, which is now round-off.
 * Periodic in x and y; no flux through the ground and top (stencils there are clamped to the domain).
 */
export class FluxTransport {
  private readonly grid: Grid; private readonly rho: Float64Array
  private readonly mx: Float64Array; private readonly my: Float64Array; private readonly mz: Float64Array; private readonly div: Float64Array
  private readonly fx: Float64Array; private readonly fy: Float64Array; private readonly fz: Float64Array
  private readonly start: Float32Array; private readonly tend: Float64Array
  /** Periodic neighbour x indices and y row offsets at offsets -2..3 (index o + 2). */
  private readonly xo: Int32Array[]; private readonly yo: Int32Array[]
  /** Control-volume height of each level. */
  private readonly h: Float64Array
  // Face projection: spectral transform of the node divergence, potential, Thomas work arrays, horizontal eigenvalues.
  private readonly dft: HorizontalDFT; private readonly phi: Float64Array
  private readonly cp: Float64Array; private readonly dRe: Float64Array; private readonly dIm: Float64Array
  private readonly lambda: Float64Array
  /** Per grid row (z * ny + y): the field has a non-zero value in the row; a non-zero value within the stencil reach. */
  private readonly rowNonzero: Uint8Array; private readonly rowActive: Uint8Array

  /** `memory` holds the face fluxes (and their divergence), which helper threads read (see threads.ts). */
  constructor(grid: Grid, rho: ArrayLike<number>, memory: Memory = PRIVATE_MEMORY) {
    const { n, nx, ny, nz } = grid
    this.grid = grid; this.rho = Float64Array.from(rho)
    const f = () => new Float64Array(n)
    this.mx = memory.f64('mx', n); this.my = memory.f64('my', n); this.mz = memory.f64('mz', n); this.div = memory.f64('div', n)
    this.fx = f(); this.fy = f(); this.fz = f(); this.tend = f()
    this.start = new Float32Array(n)
    this.xo = [-2, -1, 0, 1, 2, 3].map(o => Int32Array.from({ length: nx }, (_, x) => (x + o + 2 * nx) % nx))
    this.yo = [-2, -1, 0, 1, 2, 3].map(o => Int32Array.from({ length: ny }, (_, y) => ((y + o + 2 * ny) % ny) * nx))
    this.h = grid.hz
    this.dft = new HorizontalDFT(nx, ny, nz, memory, 'faces'); this.phi = memory.f64('phi', n)
    this.cp = new Float64Array(nz); this.dRe = new Float64Array(nz); this.dIm = new Float64Array(nz)
    // -lambda is the symbol of the periodic second difference in x plus y (exactly 0 for the uniform mode).
    this.rowNonzero = new Uint8Array(nz * ny); this.rowActive = new Uint8Array(nz * ny)
    this.lambda = Float64Array.from({ length: nx * ny }, (_, mode) => {
      const m = mode % nx, n = Math.floor(mode / nx)
      return m === 0 && n === 0 ? 0 : 4 * Math.sin(Math.PI * m / nx) ** 2 / (grid.dx * grid.dx) + 4 * Math.sin(Math.PI * n / ny) ** 2 / (grid.dy * grid.dy)
    })
  }

  /** Face mass fluxes of the (frozen) transport velocity, projected to zero divergence (div keeps the round-off). */
  setVelocity(u: Float32Array, v: Float32Array, w: Float32Array) {
    const { nz, ny } = this.grid
    this.faces(u, v, w, 0, nz); this.divergence(0, nz)
    this.forward(0, nz); this.modes(0, ny); this.inverse(0, nz); this.correctFaces(0, nz)
    this.divergence(0, nz)
  }

  // setVelocity in parts, for helper threads (levels z0..z1-1, or modes with y-wavenumbers n0..n1-1): the face fluxes,
  // their divergence, its forward transform, the tridiagonal solves, the inverse transform into phi, the correction.

  /** Face mass fluxes of levels z0..z1-1 from the node velocities (before the projection). */
  faces(u: Float32Array, v: Float32Array, w: Float32Array, z0: number, z1: number) {
    const { nx, ny, nz, layer } = this.grid, rho = this.rho, { mx, my, mz, xo, yo } = this
    for (let z = z0, i = z0 * layer; z < z1; z++) {
      const l = z * layer, r = rho[z], rUp = z < nz - 1 ? (rho[z] + rho[z + 1]) / 2 : 0
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
        mx[i] = r * (u[i] + u[xo[3][x] + y * nx + l]) / 2
        my[i] = r * (v[i] + v[x + yo[3][y] + l]) / 2
        mz[i] = z < nz - 1 ? rUp * (w[i] + w[i + layer]) / 2 : 0
      }
    }
  }

  /** Divergence of the face fluxes at the nodes of levels z0..z1-1. */
  divergence(z0: number, z1: number) {
    const { nx, ny, dx, dy, layer } = this.grid, { mx, my, mz, div, xo, yo, h } = this
    for (let z = z0, i = z0 * layer; z < z1; z++) {
      const l = z * layer
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
        div[i] = (mx[i] - mx[xo[1][x] + y * nx + l]) / dx + (my[i] - my[x + yo[1][y] + l]) / dy + (mz[i] - (z > 0 ? mz[i - layer] : 0)) / h[z]
      }
    }
  }

  /**
   * Solves L phi = div on the node control volumes and subtracts rho0 grad(phi) from the face fluxes (none through the
   * ground and top). Per horizontal mode, multiplied by h_k: -rho_k h_k lambda phi_k + [rho_(k+1/2) (phi_(k+1) - phi_k)
   * - rho_(k-1/2) (phi_k - phi_(k-1))] / dz_(k-1/2)] = h_k div_k (spacings between the levels, stretched or not), a
   * tridiagonal system; the uniform mode is pinned at the ground.
   */
  forward(z0: number, z1: number) { this.dft.forwardLayers(this.div, z0, z1) }
  inverse(z0: number, z1: number) { this.dft.inverseLayers(this.phi, z0, z1) }

  modes(n0: number, n1: number) {
    const { nx, nz, layer } = this.grid, { h, rho, dft, cp, dRe, dIm, lambda } = this, { dzs } = this.grid
    const re = dft.re, im = dft.im, face = (k: number) => k < 0 || k >= nz - 1 ? 0 : (rho[k] + rho[k + 1]) / 2
    for (let n = n0; n < n1; n++) for (let m = 0; m <= dft.mh; m++) {
      const mode = m + nx * n, lam = lambda[mode], pinned = lam === 0
      for (let k = 0; k < nz; k++) {
        let lo = k > 0 ? face(k - 1) / dzs[k - 1] : 0, up = k < nz - 1 ? face(k) / dzs[k] : 0, di = -rho[k] * h[k] * lam - lo - up, rr = h[k] * re[mode + k * layer], ri = h[k] * im[mode + k * layer]
        if (pinned && k === 0) { lo = 0; di = 1; up = 0; rr = 0; ri = 0 }
        if (pinned && k === 1) lo = 0
        const piv = k === 0 ? di : di - lo * cp[k - 1]
        cp[k] = up / piv
        dRe[k] = (rr - (k === 0 ? 0 : lo * dRe[k - 1])) / piv
        dIm[k] = (ri - (k === 0 ? 0 : lo * dIm[k - 1])) / piv
      }
      for (let k = nz - 1; k >= 0; k--) {
        if (k < nz - 1) { dRe[k] -= cp[k] * dRe[k + 1]; dIm[k] -= cp[k] * dIm[k + 1] }
        re[mode + k * layer] = dRe[k]; im[mode + k * layer] = dIm[k]
      }
    }
  }

  /** Subtracts rho0 grad(phi) from the face fluxes of levels z0..z1-1. */
  correctFaces(z0: number, z1: number) {
    const { nx, ny, nz, dx, dy, dzs, layer } = this.grid, { mx, my, mz, xo, yo, rho, phi } = this
    const face = (k: number) => k < 0 || k >= nz - 1 ? 0 : (rho[k] + rho[k + 1]) / 2
    for (let z = z0, i = z0 * layer; z < z1; z++) {
      const l = z * layer, r = rho[z], rUp = face(z)
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
        mx[i] -= r * (phi[xo[3][x] + y * nx + l] - phi[i]) / dx
        my[i] -= r * (phi[x + yo[3][y] + l] - phi[i]) / dy
        if (z < nz - 1) mz[i] -= rUp * (phi[i + layer] - phi[i]) / dzs[z]
      }
    }
  }

  /**
   * Advances `a` by dt with RK3 using the velocity given to setVelocity. `monotone` selects WENO5 (for fields that must
   * not overshoot, such as water); otherwise the linear fifth-order upwind flux, ~3x cheaper, for smooth fields.
   */
  advect(a: Float32Array, dt: number, monotone = true) {
    this.start.set(a)
    const start = this.start, tend = this.tend, n = a.length
    for (const fraction of RK3) {
      this.tendency(a, tend, 0, this.grid.nz, monotone)
      for (let i = 0; i < n; i++) a[i] = start[i] + fraction * dt * tend[i]
    }
  }

  /**
   * The transport tendency of q at the levels z0..z1-1, into the same nodes of `tend` (helper threads each take a slab
   * of levels: the stencil only reads q, and the vertical flux below the slab is recomputed here).
   */
  tendency(q: Float32Array, tend: Float64Array, z0: number, z1: number, monotone: boolean) {
    if (monotone) this.tendencyWeno(q, tend, z0, z1); else this.tendencyLinear(q, tend, z0, z1)
  }

  /**
   * Marks the grid rows whose stencil (3 nodes in y and z) reaches a non-zero value. Water species other than vapour
   * are exactly zero in most of the domain (the positivity fix removes WENO's tiny tails): their rows are skipped.
   */
  private markActiveRows(q: Float32Array, z0: number, z1: number) {
    const { nx, ny, nz } = this.grid, rows = this.rowNonzero, active = this.rowActive
    for (let r = Math.max(0, z0 - 3) * ny; r < Math.min(nz, z1 + 3) * ny; r++) { const b = r * nx; let any = 0; for (let x = 0; x < nx; x++) if (q[b + x] !== 0) { any = 1; break } rows[r] = any }
    let count = 0
    for (let z = z0; z < z1; z++) for (let y = 0; y < ny; y++) {
      let any = 0
      for (let dz = -3; dz <= 3 && !any; dz++) { const zz = z + dz; if (zz < 0 || zz >= nz) continue; for (let dy = -3; dy <= 3; dy++) if (rows[zz * ny + (y + dy + ny) % ny]) { any = 1; break } }
      active[z * ny + y] = any; count += any
    }
    return count
  }

  private tendencyWeno(q: Float32Array, tend: Float64Array, z0: number, z1: number) {
    const { nx, ny, nz, dx, dy, layer } = this.grid, { mx, my, mz, div, fx, fy, fz, xo, yo, h, rho } = this
    const [xm2, xm1, , xp1, xp2, xp3] = xo, [ym2, ym1, , yp1, yp2, yp3] = yo
    const active = this.rowActive, below = Math.max(0, z0 - 1)
    if (this.markActiveRows(q, below, z1) === 0) { tend.fill(0, z0 * layer, z1 * layer); return }
    for (let z = below, i = below * layer; z < z1; z++) {
      const l = z * layer, top = z === nz - 1
      const zm2 = Math.max(0, z - 2) * layer, zm1 = Math.max(0, z - 1) * layer, zp1 = Math.min(nz - 1, z + 1) * layer, zp2 = Math.min(nz - 1, z + 2) * layer, zp3 = Math.min(nz - 1, z + 3) * layer
      for (let y = 0; y < ny; y++) {
        const row = y * nx + l, c0 = y * nx
        // Nothing within reach: the fluxes are exactly zero (and are read as such by the neighbouring rows).
        if (!active[z * ny + y]) { fx.fill(0, i, i + nx); fy.fill(0, i, i + nx); fz.fill(0, i, i + nx); i += nx; continue }
        for (let x = 0; x < nx; x++, i++) {
          // Face between this node and the next one in each direction; the upwind side picks the stencil.
          const m1 = mx[i]
          fx[i] = m1 >= 0 ? m1 * weno(q[xm2[x] + row], q[xm1[x] + row], q[i], q[xp1[x] + row], q[xp2[x] + row]) : m1 * weno(q[xp3[x] + row], q[xp2[x] + row], q[xp1[x] + row], q[i], q[xm1[x] + row])
          const m2 = my[i]
          fy[i] = m2 >= 0 ? m2 * weno(q[x + ym2[y] + l], q[x + ym1[y] + l], q[i], q[x + yp1[y] + l], q[x + yp2[y] + l]) : m2 * weno(q[x + yp3[y] + l], q[x + yp2[y] + l], q[x + yp1[y] + l], q[i], q[x + ym1[y] + l])
          const m3 = mz[i], c = x + c0
          fz[i] = top ? 0 : m3 >= 0 ? m3 * weno(q[c + zm2], q[c + zm1], q[i], q[c + zp1], q[c + zp2]) : m3 * weno(q[c + zp3], q[c + zp2], q[c + zp1], q[i], q[c + zm1])
        }
      }
    }
    for (let z = z0, i = z0 * layer; z < z1; z++) {
      const l = z * layer, r = rho[z], hz = h[z]
      for (let y = 0; y < ny; y++) {
        if (!active[z * ny + y]) { tend.fill(0, i, i + nx); i += nx; continue }
        for (let x = 0; x < nx; x++, i++) {
          const flux = (fx[i] - fx[xm1[x] + y * nx + l]) / dx + (fy[i] - fy[x + ym1[y] + l]) / dy + (fz[i] - (z > 0 ? fz[i - layer] : 0)) / hz
          tend[i] = -(flux - q[i] * div[i]) / r
        }
      }
    }
  }

  // Same as tendency with the linear reconstruction: a separate copy keeps each loop monomorphic for the JIT.
  private tendencyLinear(q: Float32Array, tend: Float64Array, z0: number, z1: number) {
    const { nx, ny, nz, dx, dy, layer } = this.grid, { mx, my, mz, div, fx, fy, fz, xo, yo, h, rho } = this
    const [xm2, xm1, , xp1, xp2, xp3] = xo, [ym2, ym1, , yp1, yp2, yp3] = yo
    const below = Math.max(0, z0 - 1)
    for (let z = below, i = below * layer; z < z1; z++) {
      const l = z * layer, top = z === nz - 1
      const zm2 = Math.max(0, z - 2) * layer, zm1 = Math.max(0, z - 1) * layer, zp1 = Math.min(nz - 1, z + 1) * layer, zp2 = Math.min(nz - 1, z + 2) * layer, zp3 = Math.min(nz - 1, z + 3) * layer
      for (let y = 0; y < ny; y++) {
        const row = y * nx + l, c0 = y * nx
        for (let x = 0; x < nx; x++, i++) {
          // Face between this node and the next one in each direction; the upwind side picks the stencil.
          const m1 = mx[i]
          fx[i] = m1 >= 0 ? m1 * upwind5(q[xm2[x] + row], q[xm1[x] + row], q[i], q[xp1[x] + row], q[xp2[x] + row]) : m1 * upwind5(q[xp3[x] + row], q[xp2[x] + row], q[xp1[x] + row], q[i], q[xm1[x] + row])
          const m2 = my[i]
          fy[i] = m2 >= 0 ? m2 * upwind5(q[x + ym2[y] + l], q[x + ym1[y] + l], q[i], q[x + yp1[y] + l], q[x + yp2[y] + l]) : m2 * upwind5(q[x + yp3[y] + l], q[x + yp2[y] + l], q[x + yp1[y] + l], q[i], q[x + ym1[y] + l])
          const m3 = mz[i], c = x + c0
          fz[i] = top ? 0 : m3 >= 0 ? m3 * upwind5(q[c + zm2], q[c + zm1], q[i], q[c + zp1], q[c + zp2]) : m3 * upwind5(q[c + zp3], q[c + zp2], q[c + zp1], q[i], q[c + zm1])
        }
      }
    }
    for (let z = z0, i = z0 * layer; z < z1; z++) {
      const l = z * layer, r = rho[z], hz = h[z]
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
        const flux = (fx[i] - fx[xm1[x] + y * nx + l]) / dx + (fy[i] - fy[x + ym1[y] + l]) / dy + (fz[i] - (z > 0 ? fz[i - layer] : 0)) / hz
        tend[i] = -(flux - q[i] * div[i]) / r
      }
    }
  }
}

/** Fractions of the step of the three Runge-Kutta stages (Wicker & Skamarock 2002). */
export const RK3 = [1 / 3, 1 / 2, 1] as const

/** Linear fifth-order upwind value at the face between c and d for flow from a towards e (Wicker & Skamarock 2002). */
export function upwind5(a: number, b: number, c: number, d: number, e: number) { return (2 * a - 13 * b + 47 * c + 27 * d - 3 * e) / 60 }

/** WENO5 value at the face between c and d for flow from a towards e (Jiang & Shu weights, scale-aware epsilon). */
export function weno(a: number, b: number, c: number, d: number, e: number) {
  // Most of the domain has no ice, snow, graupel or rain: skip the weights there (the result would be 0 anyway).
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0) return 0
  const p0 = (2 * a - 7 * b + 11 * c) / 6, p1 = (-b + 5 * c + 2 * d) / 6, p2 = (2 * c + 5 * d - e) / 6
  const s0 = a - 2 * b + c, t0 = a - 4 * b + 3 * c, s1 = b - 2 * c + d, t1 = b - d, s2 = c - 2 * d + e, t2 = 3 * c - 4 * d + e
  const eps = 2e-7 * (a * a + b * b + c * c + d * d + e * e) + 1e-40
  const b0 = eps + 13 / 12 * s0 * s0 + .25 * t0 * t0, b1 = eps + 13 / 12 * s1 * s1 + .25 * t1 * t1, b2 = eps + 13 / 12 * s2 * s2 + .25 * t2 * t2
  // Weights .1/b0², .6/b1², .3/b2², both sums multiplied by (b0 b1 b2)²: one division instead of four (b >= 1e-40,
  // so the products stay far from underflow).
  const c0 = b0 * b0, c1 = b1 * b1, c2 = b2 * b2, w0 = .1 * c1 * c2, w1 = .6 * c0 * c2, w2 = .3 * c0 * c1
  return (w0 * p0 + w1 * p1 + w2 * p2) / (w0 + w1 + w2)
}
