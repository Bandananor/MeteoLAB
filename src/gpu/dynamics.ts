// WebGPU port of the dynamics of a model step, Э3 step 4 (16.11.2026): src/core/model.ts step() from the face-flux
// projection to the end of the three RK3 stages (before 'finish'): the transport of every carried field, u, v, w
// included, the buoyancy (stageBuoyancy, against the environment or a zone's own air) and the updraught nudging
// (nudgeLevel) in each stage's w tendency, and the pressure projection between the stages (pressureInStages), with
// w held at zero on the ground and the top. One command buffer per step; the fields stay on the GPU between stages.
// theta is carried as its departure from the base profile, the profile's own tendency computed here from the
// differences to the node's level (float32 would lose ~1e-5 of 300 K otherwise). tests/bench/gpucheck.ts compares the
// result with the TypeScript stages.
import type { Grid } from '../core/grid'
import { G } from '../core/constants'
import { NUDGE } from '../core/model'
import { GpuElliptic } from './elliptic'
import { GpuTransport, type Slot } from './transport'

const MAP_READ = 1, COPY_SRC = 4, COPY_DST = 8, UNIFORM = 64, STORAGE = 128

const WGSL = /* wgsl */`
struct D { nx: u32, ny: u32, nz: u32, nudge: u32, dx: f32, dy: f32, cx: f32, cy: f32, width: f32, depth: f32, xr: f32, zr: f32, zc: f32, top: f32, g: f32, pad: f32 }
@group(0) @binding(0) var<uniform> d: D;
struct Stage { rate: f32, pad0: f32, pad1: f32, pad2: f32 }
@group(0) @binding(1) var<uniform> stage: Stage;
// Per level, two vec4: (theta_base - theta_env, theta_env, q_env, zone shape / exner), (zone shape, height, rho, hz).
@group(0) @binding(2) var<storage, read> lv: array<vec4f>;
// Per column: the zone's theta and vapour departures (zero without zones).
@group(0) @binding(3) var<storage, read> zone: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> tend: array<f32>;
@group(0) @binding(5) var<storage, read> theta: array<f32>;
@group(0) @binding(6) var<storage, read> q: array<f32>;
@group(0) @binding(7) var<storage, read_write> load: array<f32>;
@group(0) @binding(8) var<storage, read_write> w: array<f32>;
@group(0) @binding(9) var<storage, read> a0: array<f32>;
@group(0) @binding(10) var<storage, read> a1: array<f32>;
@group(0) @binding(11) var<storage, read> a2: array<f32>;
@group(0) @binding(12) var<storage, read> a3: array<f32>;
@group(0) @binding(13) var<storage, read> a4: array<f32>;
@group(0) @binding(14) var<storage, read> a5: array<f32>;
@group(0) @binding(15) var<storage, read> mz: array<f32>;
@group(0) @binding(16) var<storage, read> base: array<f32>;
@group(0) @binding(17) var<storage, read_write> out: array<f32>;

// The condensate loading: cloud, ice, rain, snow, graupel, hail (absent ones bound to a zero buffer).
@compute @workgroup_size(256)
fn loading(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; if (i >= d.nx * d.ny * d.nz) { return; }
  load[i] = a0[i] + a1[i] + a2[i] + a3[i] + a4[i] + a5[i];
}

// g B added to w's tendency (stageBuoyancy), then the nudging towards the target updraught (nudgeLevel with a tendency).
// theta here is the departure from the base profile; theta_v minus the reference is formed from small differences.
@compute @workgroup_size(256)
fn buoyancy(@builtin(global_invocation_id) g: vec3u) {
  let layer = d.nx * d.ny; let i = g.x; if (i >= layer * d.nz) { return; }
  let z = i / layer; let c = i % layer; let L = lv[2u * z]; let M = lv[2u * z + 1u]; let zn = zone[c];
  let R = L.y + zn.x * L.w; let Q = L.z + zn.y * M.x;
  let dth = theta[i] + L.x - zn.x * L.w;
  let num = dth + 0.61 * ((R + dth) * (q[i] - Q) + Q * dth);
  var t = tend[i] + d.g * (num / (R * (1.0 + 0.61 * Q)) - load[i]);
  if (d.nudge == 1u && stage.rate > 0.0) {
    let sz = (M.y - d.zc) / d.zr;
    if (abs(sz) < 1.0) {
      var ddx = f32(c % d.nx) * d.dx - d.cx; var ddy = f32(c / d.nx) * d.dy - d.cy;
      if (ddx > d.width / 2.0) { ddx -= d.width; } if (ddx < -d.width / 2.0) { ddx += d.width; }
      if (ddy > d.depth / 2.0) { ddy -= d.depth; } if (ddy < -d.depth / 2.0) { ddy += d.depth; }
      let r = sqrt((ddx / d.xr) * (ddx / d.xr) + (ddy / d.xr) * (ddy / d.xr) + sz * sz);
      if (r < 1.0) { let k = cos(1.5707963267948966 * r); let gap = d.top * k * k - w[i]; if (gap > 0.0) { t += stage.rate * gap; } }
    }
  }
  tend[i] = t;
}

// w = 0 on the ground and the top (before each stage's pressure projection).
@compute @workgroup_size(256)
fn rigid(@builtin(global_invocation_id) g: vec3u) {
  let layer = d.nx * d.ny; let b = g.x; if (b >= layer) { return; }
  w[b] = 0.0; w[b + (d.nz - 1u) * layer] = 0.0;
}

// The flux-form tendency of the base profile theta_b(z) (horizontally uniform): the horizontal fluxes cancel against
// -theta div exactly, leaving the vertical faces with the interpolated value's difference to the node's own level.
fn up5(a: f32, b: f32, c: f32, dd: f32, e: f32) -> f32 { return (2.0 * a - 13.0 * b + 47.0 * c + 27.0 * dd - 3.0 * e) / 60.0; }
fn bz(k: i32, r0: f32) -> f32 { return base[u32(clamp(k, 0, i32(d.nz) - 1))] - r0; }
// The face above level k: m (F - ref), zero flux through the top (where -ref m stays).
fn faceAbove(k: i32, i: u32, r0: f32) -> f32 {
  let m = mz[i];
  if (k == i32(d.nz) - 1) { return -r0 * m; }
  var f = 0.0;
  if (m >= 0.0) { f = up5(bz(k - 2, r0), bz(k - 1, r0), bz(k, r0), bz(k + 1, r0), bz(k + 2, r0)); }
  else { f = up5(bz(k + 3, r0), bz(k + 2, r0), bz(k + 1, r0), bz(k, r0), bz(k - 1, r0)); }
  return m * f;
}
@compute @workgroup_size(256)
fn profileTendency(@builtin(global_invocation_id) g: vec3u) {
  let layer = d.nx * d.ny; let i = g.x; if (i >= layer * d.nz) { return; }
  let z = i32(i / layer); let r0 = base[u32(z)]; let M = lv[2u * u32(z) + 1u];
  // -(1 / rho h) [(fz - ref mz) above - (fz - ref mz) below]; nothing below the ground.
  var below = 0.0; if (z > 0) { below = faceAbove(z - 1, i - layer, r0); }
  out[i] = -(faceAbove(z, i, r0) - below) / (M.z * M.w);
}`

type Kernel = 'loading' | 'buoyancy' | 'rigid' | 'profileTendency'
const USES: Record<Kernel, number[]> = {
  loading: [0, 7, 9, 10, 11, 12, 13, 14], buoyancy: [0, 1, 2, 3, 4, 5, 6, 7, 8], rigid: [0, 8], profileTendency: [0, 2, 15, 16, 17],
}

/** Which carried field a slot is, for the buoyancy: its loading, its vapour, theta, w. */
export type Role = 'u' | 'v' | 'w' | 'theta' | 'q' | 'cloud' | 'ice' | 'rain' | 'snow' | 'graupel' | 'hail' | 'other'

/** A carried field: its values (theta: the full theta; the GPU keeps its departure), scheme and role. */
export interface DynamicsField { q: Float32Array; monotone: boolean; role: Role }

/** What the buoyancy and nudging need this step (from the model; see model.ts envNow, zones, nudgeLevel). */
export interface DynamicsEnv {
  /** Per level: the environment's theta and vapour now (envNow), the zone shape (0 above ZONE_DEPTH or without zones). */
  thetaEnv: ArrayLike<number>; qEnv: ArrayLike<number>; shape: ArrayLike<number>
  /** Per column: the zones' theta and vapour departures now (zoneThetaNow, zoneVapourNow), or null. */
  zoneTheta: Float32Array | null; zoneVapour: Float32Array | null
  /** Nudging: model time at the step's start, target (SimConfig.nudge) and centre (m); null without it. */
  nudge: { time: number; top: number; cx: number; cy: number } | null
}

/**
 * The dynamics of a model step on the GPU: step() uploads the fields, runs the face projection and the three RK3 stages
 * with buoyancy, nudging and the pressure in the stages, and reads the fields back.
 */
export class GpuDynamics {
  readonly adapter: string
  readonly errors: string[] = []
  private readonly device: GPUDevice; private readonly grid: Grid
  private readonly elliptic: GpuElliptic; private readonly transport: GpuTransport
  private readonly pipelines = new Map<Kernel, GPUComputePipeline>()
  private readonly params: GPUBuffer; private readonly stageRates: GPUBuffer[]
  private readonly levels: GPUBuffer; private readonly zone: GPUBuffer; private readonly load: GPUBuffer; private readonly zero: GPUBuffer
  private readonly div: GPUBuffer; private readonly base: GPUBuffer
  private readonly env: { rho: ArrayLike<number>; theta: ArrayLike<number>; exner: ArrayLike<number> }

  static async create(grid: Grid, env: { rho: ArrayLike<number>; theta: ArrayLike<number>; exner: ArrayLike<number> }, options: GPURequestAdapterOptions = { powerPreference: 'high-performance' }) {
    const adapter = await navigator.gpu?.requestAdapter(options)
    if (!adapter) throw new Error('no WebGPU adapter')
    const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } })
    return new GpuDynamics(device, grid, env, `${adapter.info?.vendor ?? ''} ${adapter.info?.architecture ?? ''}`.trim())
  }

  private constructor(device: GPUDevice, grid: Grid, env: { rho: ArrayLike<number>; theta: ArrayLike<number>; exner: ArrayLike<number> }, adapter: string) {
    this.device = device; this.grid = grid; this.env = env; this.adapter = adapter
    device.addEventListener('uncapturederror', e => this.errors.push((e as GPUUncapturedErrorEvent).error.message))
    const { n, nz, layer } = grid, S = STORAGE | COPY_DST | COPY_SRC, make = (bytes: number) => device.createBuffer({ size: Math.max(16, bytes), usage: S })
    this.elliptic = GpuElliptic.on(device, grid, env.rho)
    this.div = make(4 * n)
    this.transport = GpuTransport.on(device, grid, env.rho, { mx: this.elliptic.buffer(11), my: this.elliptic.buffer(12), mz: this.elliptic.buffer(13), div: this.div })
    const module = device.createShaderModule({ code: WGSL })
    for (const k of Object.keys(USES) as Kernel[]) this.pipelines.set(k, device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: k } }))
    this.params = device.createBuffer({ size: 64, usage: UNIFORM | COPY_DST })
    this.stageRates = [0, 1, 2].map(() => device.createBuffer({ size: 16, usage: UNIFORM | COPY_DST }))
    this.levels = make(32 * nz); this.zone = make(8 * layer); this.load = make(4 * n); this.zero = make(4 * n); this.base = make(4 * nz)
    device.queue.writeBuffer(this.base, 0, Float32Array.from(env.theta))
  }

  private group(k: Kernel, buffers: Record<number, GPUBuffer>) {
    return this.device.createBindGroup({ layout: this.pipelines.get(k)!.getBindGroupLayout(0), entries: USES[k].map(b => ({ binding: b, resource: { buffer: buffers[b] } })) })
  }

  private dispatch(pass: GPUComputePassEncoder, k: Kernel, group: GPUBindGroup, threads: number) {
    pass.setPipeline(this.pipelines.get(k)!); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(threads / 256))
  }

  /**
   * One step's dynamics by dt. `fields`: the carried fields in any order (u, v, w and theta among them); returns them
   * after the three stages, in the same order, and the GPU time (ms, submission to completion).
   */
  async step(fields: readonly DynamicsField[], env: DynamicsEnv, dt: number): Promise<{ fields: Float32Array[]; gpuMs: number }> {
    const d = this.device, g = this.grid, { n, nz, layer } = g, queue = d.queue, el = this.elliptic
    const roleOf = (r: Role) => fields.findIndex(f => f.role === r)
    // Uniforms and per-level data.
    const raw = new ArrayBuffer(64), U = new Uint32Array(raw, 0, 4), F = new Float32Array(raw, 16, 12)
    U.set([g.nx, g.ny, nz, env.nudge ? 1 : 0])
    F.set([g.dx, g.dy, env.nudge?.cx ?? 0, env.nudge?.cy ?? 0, g.width, g.depth, NUDGE.xr, NUDGE.zr, NUDGE.zc, env.nudge?.top ?? 0, G, 0])
    queue.writeBuffer(this.params, 0, raw)
    const STAGE_TIME = [0, 1 / 3, 1 / 2]
    STAGE_TIME.forEach((s, k) => {
      const t = (env.nudge?.time ?? 0) + s * dt, rate = !env.nudge || t >= NUDGE.t2 ? 0 : NUDGE.alpha * (t < NUDGE.t1 ? 1 : (NUDGE.t2 - t) / (NUDGE.t2 - NUDGE.t1))
      queue.writeBuffer(this.stageRates[k], 0, Float32Array.of(rate, 0, 0, 0))
    })
    const lv = new Float32Array(8 * nz)
    for (let z = 0; z < nz; z++) lv.set([this.env.theta[z] - env.thetaEnv[z], env.thetaEnv[z], env.qEnv[z], env.shape[z] / this.env.exner[z], env.shape[z], g.zs[z], this.env.rho[z], g.hz[z]], 8 * z)
    queue.writeBuffer(this.levels, 0, lv)
    const zone = new Float32Array(2 * layer)
    if (env.zoneTheta && env.zoneVapour) for (let c = 0; c < layer; c++) { zone[2 * c] = env.zoneTheta[c]; zone[2 * c + 1] = env.zoneVapour[c] }
    queue.writeBuffer(this.zone, 0, zone)
    el.setPressureStep(dt); this.transport.setStages(dt)
    // The fields: u, v, w in the elliptic solver's buffers (transported in place), the rest in the transport's own.
    const wind: Partial<Record<Role, number>> = { u: 8, v: 9, w: 10 }
    const slots: Slot[] = fields.map((f, k) => this.transport.slot(k, f.monotone, wind[f.role] !== undefined ? el.buffer(wind[f.role]!) : undefined))
    const th = roleOf('theta'), base = this.env.theta
    fields.forEach((f, k) => {
      if (k === th) { const pert = new Float32Array(n); for (let i = 0; i < n; i++) pert[i] = f.q[i] - base[Math.floor(i / layer)]; queue.writeBuffer(slots[k].q, 0, pert) }
      else queue.writeBuffer(slots[k].q, 0, f.q)
      if (k !== th) queue.writeBuffer(slots[k].extra, 0, new Float32Array(n))
    })
    const slotOf = (r: Role) => { const k = roleOf(r); return k < 0 ? this.zero : slots[k].q }
    const loadGroup = this.group('loading', { 0: this.params, 7: this.load, 9: slotOf('cloud'), 10: slotOf('ice'), 11: slotOf('rain'), 12: slotOf('snow'), 13: slotOf('graupel'), 14: slotOf('hail') })
    const wSlot = slots[roleOf('w')]
    const buoyGroups = this.stageRates.map(r => this.group('buoyancy', { 0: this.params, 1: r, 2: this.levels, 3: this.zone, 4: wSlot.tend, 5: slots[th].q, 6: slotOf('q'), 7: this.load, 8: el.buffer(10) }))
    const rigidGroup = this.group('rigid', { 0: this.params, 8: el.buffer(10) })
    const profileGroup = this.group('profileTendency', { 0: this.params, 2: this.levels, 15: el.buffer(13), 16: this.base, 17: slots[th].extra })
    await queue.onSubmittedWorkDone()
    const t0 = performance.now(), enc = d.createCommandEncoder()
    {
      const pass = enc.beginComputePass()
      el.encodeFaces(pass, true)
      this.dispatch(pass, 'profileTendency', profileGroup, n)
      pass.end()
    }
    enc.copyBufferToBuffer(el.buffer(4), 0, this.div, 0, 4 * n)
    for (const s of slots) enc.copyBufferToBuffer(s.q, 0, s.start, 0, 4 * n)
    const pass = enc.beginComputePass()
    for (let stage = 0; stage < 3; stage++) {
      for (const s of slots) this.transport.encodeTendency(pass, s)
      this.dispatch(pass, 'loading', loadGroup, n)
      this.dispatch(pass, 'buoyancy', buoyGroups[stage], n)
      for (const s of slots) this.transport.encodeUpdate(pass, s, stage)
      if (stage < 2) { this.dispatch(pass, 'rigid', rigidGroup, layer); el.encodePressure(pass) }
    }
    pass.end(); queue.submit([enc.finish()]); await queue.onSubmittedWorkDone()
    const gpuMs = performance.now() - t0
    const read = d.createBuffer({ size: 4 * n * slots.length, usage: MAP_READ | COPY_DST }), e2 = d.createCommandEncoder()
    slots.forEach((s, k) => e2.copyBufferToBuffer(s.q, 0, read, 4 * n * k, 4 * n))
    queue.submit([e2.finish()]); await read.mapAsync(1)
    const all = new Float32Array(read.getMappedRange().slice(0)); read.unmap(); read.destroy()
    const out = slots.map((_, k) => all.slice(k * n, (k + 1) * n))
    if (th >= 0) for (let i = 0; i < n; i++) out[th][i] += base[Math.floor(i / layer)]
    this.errors.push(...this.transport.errors.splice(0), ...el.errors.splice(0))
    return { fields: out, gpuMs }
  }
}
