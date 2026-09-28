import { SURFACES, type SimConfig } from './config'
import { CP, DT, G, LV, OMEGA, RAIN_FALL } from './constants'
import { Environment } from './environment'
import { createGrid, type Grid } from './grid'
import { clamp, lerp, mod, mulberry32 } from './math'
import { PressureSolver } from './pressure'
import { insolation } from './solar'
import { computeSounding, type Sounding } from './sounding'

// Updraft helicity (integral of w*zeta over 2-5 km, m2/s2) thresholds and the persistence that makes rotation a mesocyclone.
// Calibrated for the ~1 km, diffusive default grid: sustained rotating updrafts sit at 150-250 m2/s2 (3-km NWP uses ~75).
export const UH_ROTATING = 100, UH_MESOCYCLONE = 150, MESO_PERSISTENCE = 600

export interface RotationState { uh: number; x: number; y: number; anticyclonic: number; persisted: number }

export interface ModelDiagnostics {
  updraft: number; downdraft: number; rainRate: number; cloudTop: number; thermalTop: number
  maxCloud: number; coldMax: number; cores: number; shear06: number; microburst: number
}

/** Cloud-scale atmosphere on a periodic box: prognostic u, v, w, theta, q, cloud, rain and the cold-pool indicator. */
export class AtmosphereModel {
  readonly grid: Grid; readonly config: SimConfig; readonly env: Environment
  readonly u: Float32Array; readonly v: Float32Array; readonly w: Float32Array; readonly theta: Float32Array
  readonly q: Float32Array; readonly cloud: Float32Array; readonly rain: Float32Array; readonly cold: Float32Array
  /** Projection pressure (times dt, per unit density) at the dual-cell centres between nodes; see PressureSolver. */
  readonly pressure: Float64Array
  /** Updraft helicity of every column (2-5 km), m2/s2. */
  readonly uhColumn: Float32Array
  /** Rain that has reached the ground in each column since the start, mm (kg/m2). */
  readonly precipitation: Float32Array
  readonly rotation: RotationState = { uh: 0, x: 0, y: 0, anticyclonic: 0, persisted: 0 }
  readonly sounding: Sounding
  /** Lowest and highest level of the 2-5 km updraft-helicity layer. */
  readonly uhLevels: readonly [number, number]
  time = 0; microburstOutflow = 0
  private readonly solver: PressureSolver; private divergence: Float64Array
  private scratch: Float32Array; private surfacePattern: Float32Array
  private backtraceCorner: Int32Array; private backtraceWeight: Float64Array
  /** Volume weight of each level: nodes on the ground and top walls own half a layer. */
  private levelWeight: Float64Array
  private rng: () => number; private accumulator = 0

  constructor(config: SimConfig, grid: Grid = createGrid()) {
    this.config = config; this.grid = grid
    const f = () => new Float32Array(grid.n)
    this.u = f(); this.v = f(); this.w = f(); this.theta = f(); this.q = f(); this.cloud = f(); this.rain = f(); this.cold = f()
    this.solver = new PressureSolver(grid)
    this.pressure = new Float64Array(this.solver.cells); this.divergence = new Float64Array(this.solver.cells); this.scratch = f()
    this.surfacePattern = new Float32Array(grid.layer); this.uhColumn = new Float32Array(grid.layer); this.precipitation = new Float32Array(grid.layer)
    this.levelWeight = Float64Array.from({ length: grid.nz }, (_, z) => z === 0 || z === grid.nz - 1 ? .5 : 1)
    this.backtraceCorner = new Int32Array(grid.n * 8); this.backtraceWeight = new Float64Array(grid.n * 3)
    this.uhLevels = [Math.ceil(2000 / grid.dz), Math.floor(5000 / grid.dz)]
    this.rng = mulberry32(config.seed)
    this.env = new Environment(config, grid)
    this.initialize()
    this.sounding = computeSounding(config, this.env, grid.height)
  }

  private initialize() {
    const { nx, ny, nz, dz, width: W, depth: D } = this.grid
    let walk = 0
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { walk = walk * .82 + (this.rng() - .5) * .34; this.surfacePattern[x + nx * y] = walk }
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      const alt = z * dz, [ue, ve] = this.env.windUV(alt)
      this.u[i] = ue; this.v[i] = ve; this.w[i] = 0
      this.theta[i] = this.env.thetaEnv(alt) + (this.rng() - .5) * .018; this.q[i] = this.env.qEnv(alt)
      this.cloud[i] = this.rain[i] = this.cold[i] = 0
    }
    this.injectBubble(W * .38, D * .45, this.config.bubble); this.injectBubble(W * .61, D * .57, .72 * this.config.bubble)
  }

  /** Warm, moist thermal centred at (cx, cy) metres from the domain corner, near the ground. */
  injectBubble(cx: number, cy: number, strength: number) {
    const { nx, ny, nz, dx, dy, dz, width: W, depth: D } = this.grid
    for (let z = 0; z < Math.min(5, nz); z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let ddx = x * dx - cx, ddy = y * dy - cy
      if (ddx > W / 2) ddx -= W; if (ddx < -W / 2) ddx += W; if (ddy > D / 2) ddy -= D; if (ddy < -D / 2) ddy += D
      const d2 = (ddx / 4200) ** 2 + (ddy / 4200) ** 2 + (z * dz / 1800) ** 2, a = Math.exp(-d2) * strength, i = x + nx * (y + ny * z)
      this.theta[i] += 3.2 * a; this.q[i] += .003 * a; this.w[i] += 1.1 * a
    }
  }

  /** Trilinear sample at fractional grid coordinates (periodic in x, y; clamped in z). */
  sample(a: Float32Array, x: number, y: number, z: number) {
    const { nx, ny, nz, layer } = this.grid
    // z0 stops one level below the top so the top node itself can take weight 1 (no leak from the level below).
    x = mod(x, nx); y = mod(y, ny); z = clamp(z, 0, nz - 1)
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.min(Math.floor(z), nz - 2), x1 = (x0 + 1) % nx, y1 = (y0 + 1) % ny, z1 = z0 + 1, fx = x - x0, fy = y - y0, fz = z - z0
    const r0 = nx * y0, r1 = nx * y1, l0 = layer * z0, l1 = layer * z1
    const c00 = lerp(a[x0 + r0 + l0], a[x1 + r0 + l0], fx), c10 = lerp(a[x0 + r1 + l0], a[x1 + r1 + l0], fx), c01 = lerp(a[x0 + r0 + l1], a[x1 + r0 + l1], fx), c11 = lerp(a[x0 + r1 + l1], a[x1 + r1 + l1], fx)
    return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz)
  }

  /** Semi-Lagrangian transport of `a` with an extra downward fall speed into the scratch buffer (see commit). */
  private advectFalling(a: Float32Array, dt: number, fall: number) {
    const { nx, ny, nz, dx, dy, dz } = this.grid, s = this.scratch, u = this.u, v = this.v, w = this.w
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) s[i] = this.sample(a, x - u[i] * dt / dx, y - v[i] * dt / dy, z - (w[i] - fall) * dt / dz)
  }

  /**
   * Writes the transported values (scratch) back into `a`, then applies `decay`. With `conserve`, the transport's own
   * mass error is removed first: trilinear semi-Lagrangian transport is not conservative, so the total (volume-weighted,
   * as the flow is incompressible) is restored to its old value minus `loss`, with the correction placed where the
   * transport changed the field (proportional to |new - old|), not spread over quiet air.
   */
  private commit(a: Float32Array, decay: number, conserve = false, loss = 0) {
    const s = this.scratch, { nz, layer } = this.grid, lw = this.levelWeight
    if (conserve) {
      let before = 0, after = 0, moved = 0
      for (let z = 0, i = 0; z < nz; z++) { const wz = lw[z]; for (let e = i + layer; i < e; i++) { before += wz * a[i]; after += wz * s[i]; moved += wz * Math.abs(s[i] - a[i]) } }
      const excess = after - (before - loss)
      if (moved > 0) { const c = excess / moved; for (let i = 0; i < s.length; i++) s[i] = Math.max(0, s[i] - c * Math.abs(s[i] - a[i])) }
    }
    for (let i = 0; i < s.length; i++) a[i] = s[i] * decay
  }

  /** Rain leaving through the ground this step: adds it to `precipitation` (mm) and returns it in level-weight units. */
  private rainFallout(dt: number, fall: number) {
    const { layer, dz } = this.grid, e = this.env, rhoGround = e.p[0] / (287.05 * e.theta[0] * e.exner[0])
    let total = 0
    for (let i = 0; i < layer; i++) { const flux = this.rain[i] * fall * dt; this.precipitation[i] += rhoGround * flux; total += flux / dz }
    return total
  }

  // Departure points of one semi-Lagrangian step (8 corner indices + 3 weights per cell), shared by every field
  // so that all of them are carried by the same, pre-step velocity.
  private computeBacktrace(dt: number) {
    const { nx, ny, nz, dx, dy, dz, layer } = this.grid, c = this.backtraceCorner, wt = this.backtraceWeight, u = this.u, v = this.v, w = this.w
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      const px = mod(x - u[i] * dt / dx, nx), py = mod(y - v[i] * dt / dy, ny), pz = clamp(z - w[i] * dt / dz, 0, nz - 1)
      const x0 = Math.floor(px), y0 = Math.floor(py), z0 = Math.min(Math.floor(pz), nz - 2), x1 = (x0 + 1) % nx, r0 = nx * y0, r1 = nx * ((y0 + 1) % ny), l0 = layer * z0, l1 = layer * (z0 + 1), k = i * 8
      c[k] = x0 + r0 + l0; c[k + 1] = x1 + r0 + l0; c[k + 2] = x0 + r1 + l0; c[k + 3] = x1 + r1 + l0; c[k + 4] = x0 + r0 + l1; c[k + 5] = x1 + r0 + l1; c[k + 6] = x0 + r1 + l1; c[k + 7] = x1 + r1 + l1
      wt[i * 3] = px - x0; wt[i * 3 + 1] = py - y0; wt[i * 3 + 2] = pz - z0
    }
  }

  /** Transport of `a` along the shared backtrace into the scratch buffer (see commit). */
  private advectBacktrace(a: Float32Array) {
    const n = this.grid.n, s = this.scratch, c = this.backtraceCorner, wt = this.backtraceWeight
    for (let i = 0; i < n; i++) {
      const k = i * 8, fx = wt[i * 3], fy = wt[i * 3 + 1], fz = wt[i * 3 + 2]
      const c00 = a[c[k]] + (a[c[k + 1]] - a[c[k]]) * fx, c10 = a[c[k + 2]] + (a[c[k + 3]] - a[c[k + 2]]) * fx, c01 = a[c[k + 4]] + (a[c[k + 5]] - a[c[k + 4]]) * fx, c11 = a[c[k + 6]] + (a[c[k + 7]] - a[c[k + 6]]) * fx
      const lo = c00 + (c10 - c00) * fy, hi = c01 + (c11 - c01) * fy; s[i] = lo + (hi - lo) * fz
    }
  }

  /** Advances by real elapsed seconds scaled by the speed setting; returns the number of model steps taken. */
  advance(realDt: number) {
    this.accumulator += realDt * this.config.speed
    let steps = 0
    while (this.accumulator >= DT && steps < 12) { this.step(DT); this.accumulator -= DT; this.time += DT; steps++ }
    return steps
  }

  step(dt: number) {
    const { nx, ny, nz, dz, height: H, layer, xp: XP, xm: XM, yp: YP, ym: YM } = this.grid
    this.microburstOutflow *= .993
    // Water is transported conservatively (mass fixer). Only the cold-pool indicator decays: it belongs to the
    // cold-pool parameterisation and goes away with it.
    const fallout = this.rainFallout(dt, RAIN_FALL)
    this.advectFalling(this.rain, dt, RAIN_FALL); this.commit(this.rain, 1, true, fallout)
    this.computeBacktrace(dt)
    const carry = (a: Float32Array, decay: number, conserve = false) => { this.advectBacktrace(a); this.commit(a, decay, conserve) }
    carry(this.u, 1); carry(this.v, 1); carry(this.w, 1); carry(this.theta, 1); carry(this.q, 1, true); carry(this.cloud, 1, true); carry(this.cold, .9992)
    const cfg = this.config, e = this.env, u = this.u, v = this.v, w = this.w, theta = this.theta, q = this.q, cloud = this.cloud, rain = this.rain, cold = this.cold
    const surf = SURFACES[cfg.surfaceType], solar = insolation(cfg, this.time), absorbed = solar * (1 - surf.albedo), heatFlux = absorbed * surf.sensible / surf.inertia, moistFlux = absorbed * (1 - surf.sensible) * surf.evap * cfg.soilMoisture / 100, lfcZ = (this.sounding.lfc ?? 1.5) * 1000, f = 2 * OMEGA * Math.sin(cfg.latitude * Math.PI / 180)
    const mix = clamp(cfg.turbulence * .0015 * dt, 0, .01), spongeStart = Math.max(cfg.tropopause * 1000 + 1600, 13_000), liftTop = Math.min(3200, lfcZ)
    for (let z = 0, i = 0; z < nz; z++) {
      const alt = z * dz, p = e.p[z], exner = e.exner[z], thEnv = e.theta[z], qEnv = e.q[z], ue = e.u[z], ve = e.v[z], l = z * layer
      for (let y = 0; y < ny; y++) {
        const row = y * nx, yp = YP[y], ym = YM[y]
        for (let x = 0; x < nx; x++, i++) {
          const xp = XP[x], xm = XM[x], temp = theta[i] * exner - 273.15, sat = e.qsatP(temp, p), rh = q[i] / Math.max(.00001, sat)
          if (q[i] > sat) { const cond = Math.min(q[i] - sat, (q[i] - sat) * .32 * dt); q[i] -= cond; cloud[i] += cond; theta[i] += LV / CP / exner * cond }
          if (rh < 1 && cloud[i] > 0) { const evap = Math.min(cloud[i], .00006 * cfg.entrainment * (1 - rh) * dt); cloud[i] -= evap; q[i] += evap; const cool = LV / CP / exner * evap; theta[i] -= cool; cold[i] += cool * .14 }
          const auto = Math.max(0, cloud[i] - .0009) * .035 * cfg.precipEfficiency * dt; cloud[i] -= auto; rain[i] += auto
          if (q[i] < sat && rain[i] > 0) { const evap = Math.min(rain[i], (sat - q[i]) * .018 * cfg.evaporation * dt); rain[i] -= evap; q[i] += evap; const cool = LV / CP / exner * evap * cfg.coldPoolStrength; theta[i] -= cool; cold[i] += cool }
          const buoy = (theta[i] - thEnv) / Math.max(250, thEnv) + .61 * (q[i] - qEnv) - 1.8 * cloud[i] - 2.5 * rain[i]; w[i] += G * buoy * dt
          // Damp and rotate only the departure from the environmental wind, so the imposed shear profile is not eroded.
          const du = (u[i] - ue) * .9999, dv = (v[i] - ve) * .9999; u[i] = ue + du + f * dv * dt; v[i] = ve + dv - f * du * dt
          if (z <= 1) { const weight = Math.exp(-alt / 300), pattern = 1 + this.surfacePattern[x + row] * .32, rho = 1.18 * Math.exp(-alt / 9000); theta[i] += heatFlux * pattern / (rho * CP * 300) * weight * dt; q[i] += moistFlux * 1.3e-10 * weight * dt }
          if (alt < liftTop) { const gx = cold[xp + row] - cold[xm + row], gy = cold[x + yp] - cold[x + ym], edge = Math.hypot(gx, gy), core = cold[x + row]; w[i] += G * edge / 300 * .45 * cfg.coldPoolStrength * Math.max(.12, 1 - alt / Math.max(300, lfcZ)) * dt; if (alt < 1300 && core > 1) w[i] -= G * core / 300 * .52 * Math.exp(-alt / 520) * dt }
          if (z <= 1 && w[i] < -5 && rain[i] > .0001) { const impact = Math.min(38, -w[i] * Math.sqrt(rain[i] / .00055)) * cfg.precipEfficiency, dpx = (-w[xp + row + l] + w[xm + row + l]) * .5, dpy = (-w[x + yp + l] + w[x + ym + l]) * .5; u[i] -= dpx * .12 * dt; v[i] -= dpy * .12 * dt; cold[i] += impact * .0012 * dt; this.microburstOutflow = Math.max(this.microburstOutflow, impact) }
          const thAvg = (theta[xp + row + l] + theta[xm + row + l] + theta[x + yp + l] + theta[x + ym + l]) / 4; theta[i] = lerp(theta[i], thAvg, mix); const qAvg = (q[xp + row + l] + q[xm + row + l] + q[x + yp + l] + q[x + ym + l]) / 4; q[i] = lerp(q[i], qAvg, mix); cold[i] = clamp(cold[i], 0, 15)
          if (alt > spongeStart) { const s = clamp((alt - spongeStart) / (H - spongeStart)) * .06 * dt; w[i] *= 1 - s; u[i] = lerp(u[i], ue, s); v[i] = lerp(v[i], ve, s); theta[i] = lerp(theta[i], thEnv, s) }
        }
      }
    }
    // Ground drag and the rigid ground/top are applied before the projection, so the transport velocity is D-free.
    for (let b = 0; b < layer; b++) { u[b] *= .94; v[b] *= .94; w[b] = 0; w[b + (nz - 1) * layer] = 0 }
    this.project(dt)
    this.updateRotation(dt)
  }

  /** Makes the node velocities exactly free of dual-cell divergence (see PressureSolver); ground and top are rigid walls. */
  private project(dt: number) {
    const u = this.u, v = this.v, w = this.w
    this.solver.divergence(u, v, w, dt, this.divergence)
    this.solver.solve(this.divergence, this.pressure)
    this.solver.correct(this.pressure, u, v, w, dt)
    for (let i = 0; i < this.grid.n; i++) { u[i] = clamp(u[i], -85, 85); v[i] = clamp(v[i], -85, 85); w[i] = clamp(w[i], -60, 60) }
  }

  /** Vertical vorticity dv/dx - du/dy at a grid node, s-1. */
  zeta(x: number, y: number, z: number) {
    const { nx, dx, dy, layer, xp, xm, yp, ym } = this.grid, l = z * layer
    return (this.v[xp[x] + nx * y + l] - this.v[xm[x] + nx * y + l]) / (2 * dx) - (this.u[x + yp[y] + l] - this.u[x + ym[y] + l]) / (2 * dy)
  }

  private updateRotation(dt: number) {
    const { nx, ny, dz, layer } = this.grid, [z0, z1] = this.uhLevels, r = this.rotation, col = this.uhColumn
    let max = 0, min = 0, bx = 0, by = 0
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let uh = 0
      for (let z = z0; z <= z1; z++) uh += this.w[x + nx * y + z * layer] * this.zeta(x, y, z) * dz
      col[x + nx * y] = uh
      if (uh > max) { max = uh; bx = x; by = y }
      min = Math.min(min, uh)
    }
    r.uh = max; r.anticyclonic = -min; r.x = bx; r.y = by; r.persisted = max >= UH_MESOCYCLONE ? r.persisted + dt : 0
  }

  private countCores() {
    const { nx, ny, nz, layer } = this.grid, mask = new Uint8Array(layer)
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let active = false
      for (let z = 3; z < Math.min(nz - 2, 11); z++) { const i = x + nx * y + z * layer; if (this.w[i] > 2 && this.cloud[i] > .00007) { active = true; break } }
      mask[x + nx * y] = active ? 1 : 0
    }
    let cores = 0; const stack: number[] = []
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== 1) continue
      cores++; mask[i] = 2; stack.push(i)
      while (stack.length) {
        const a = stack.pop()!, x = a % nx, y = Math.floor(a / nx)
        for (const b of [mod(x + 1, nx) + nx * y, mod(x - 1, nx) + nx * y, x + nx * mod(y + 1, ny), x + nx * mod(y - 1, ny)]) if (mask[b] === 1) { mask[b] = 2; stack.push(b) }
      }
    }
    return cores
  }

  diagnostics(): ModelDiagnostics {
    const { nx, ny, nz, dz } = this.grid
    let up = 0, down = 0, rainRate = 0, top = 0, coldMax = 0, thermalTop = 0, maxCloud = 0
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      const alt = z * dz
      up = Math.max(up, this.w[i]); down = Math.max(down, -this.w[i]); rainRate = Math.max(rainRate, this.rain[i] * 12000); maxCloud = Math.max(maxCloud, this.cloud[i])
      if (this.cloud[i] > .00007) top = Math.max(top, alt / 1000)
      if (this.w[i] > .6) thermalTop = Math.max(thermalTop, alt / 1000)
      if (alt < 1500) coldMax = Math.max(coldMax, this.cold[i])
    }
    const [u0, v0] = this.env.windUV(0), [u6, v6] = this.env.windUV(6000)
    return { updraft: up, downdraft: down, rainRate, cloudTop: top, thermalTop, maxCloud, coldMax, cores: this.countCores(), shear06: Math.hypot(u6 - u0, v6 - v0), microburst: this.microburstOutflow }
  }
}
