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

// Э3 step 6: the sedimentation (model.ts sedimentPart) before the transport, and after the physics the subgrid
// turbulence (Turbulence.viscosity, explicit mix), the surface friction (mixStep) — then the projection (elliptic.ts).
const PHYS = /* wgsl */`
struct T { nx: u32, ny: u32, nz: u32, flags: u32, dx: f32, dy: f32, lenH2: f32, capH: f32, dt: f32, pad0: f32, pad1: f32, pad2: f32 }
@group(0) @binding(0) var<uniform> p: T;
// Per level, three vec4: (len2, cap, span, theta_base), (exner, rho, h, dzs), (rho at the face above, -, -, -).
@group(0) @binding(1) var<storage, read> lv: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> u: array<f32>;
@group(0) @binding(3) var<storage, read_write> v: array<f32>;
@group(0) @binding(4) var<storage, read_write> w: array<f32>;
@group(0) @binding(5) var<storage, read> th: array<f32>;
@group(0) @binding(6) var<storage, read> qv: array<f32>;
@group(0) @binding(7) var<storage, read> cond: array<f32>;
@group(0) @binding(8) var<storage, read_write> k2: array<vec2f>;
struct M { factor: f32, dt: f32, column: u32, pad: f32 }
@group(0) @binding(9) var<uniform> m: M;
@group(0) @binding(10) var<storage, read> a: array<f32>;
@group(0) @binding(11) var<storage, read_write> scratch: array<f32>;
@group(0) @binding(12) var<storage, read> base: array<f32>;
@group(0) @binding(13) var<storage, read_write> dst: array<f32>;
struct Drag { factor: f32, fu: f32, fv: f32, ue0: f32, ve0: f32, pad0: f32, pad1: f32, pad2: f32 }
@group(0) @binding(14) var<uniform> drag: Drag;
@group(0) @binding(15) var<storage, read> vt: array<f32>;
@group(0) @binding(16) var<storage, read_write> ground: array<f32>;

const G = 9.81; const LV = 2.5e6; const CP = 1004.0; const RD = 287.05; const EPS = 0.622; const PRANDTL = 0.33333334;

fn node(x: u32, y: u32, z: u32) -> u32 { return x + p.nx * (y + p.ny * z); }

// One sub-step of a field's fall (upwind from above, flux form) into scratch; what leaves the ground node into ground.
@compute @workgroup_size(256)
fn sediment(@builtin(global_invocation_id) g: vec3u) {
  let layer = p.nx * p.ny; let i = g.x; if (i >= layer * p.nz) { return; }
  let z = i / layer; let L = lv[3u * z + 1u];
  var inflow = 0.0; if (z < p.nz - 1u) { inflow = lv[3u * (z + 1u) + 1u].y * a[i + layer] * vt[i + layer]; }
  let out = L.y * a[i] * vt[i];
  scratch[i] = a[i] + m.dt * (inflow - out) / (L.y * L.z);
  if (z == 0u) { ground[m.column * layer + i] += out * m.dt; }
}

// scratch back into the field.
@compute @workgroup_size(256)
fn copyBack(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; if (i >= p.nx * p.ny * p.nz) { return; }
  dst[i] = scratch[i];
}

// The eddy viscosities (Turbulence.viscosity): K = len² sqrt(max(0, |S|² - N²/Pr)), capped; theta is the departure from
// the base profile, the base's own difference added from the levels.
@compute @workgroup_size(256)
fn viscosity(@builtin(global_invocation_id) g: vec3u) {
  let layer = p.nx * p.ny; let i = g.x; if (i >= layer * p.nz) { return; }
  let z = i / layer; let c = i % layer; let x = c % p.nx; let y = c / p.nx;
  let e = node((x + 1u) % p.nx, y, z); let wst = node((x + p.nx - 1u) % p.nx, y, z);
  let n = node(x, (y + 1u) % p.ny, z); let s = node(x, (y + p.ny - 1u) % p.ny, z);
  var up = i; var zu = z; if (z < p.nz - 1u) { up = i + layer; zu = z + 1u; }
  var dn = i; var zd = z; if (z > 0u) { dn = i - layer; zd = z - 1u; }
  let A = lv[3u * z]; let span = A.z;
  let dudx = (u[e] - u[wst]) / (2.0 * p.dx); let dvdy = (v[n] - v[s]) / (2.0 * p.dy); let dwdz = (w[up] - w[dn]) / span;
  let dudy = (u[n] - u[s]) / (2.0 * p.dy); let dvdx = (v[e] - v[wst]) / (2.0 * p.dx);
  let dudz = (u[up] - u[dn]) / span; let dwdx = (w[e] - w[wst]) / (2.0 * p.dx);
  let dvdz = (v[up] - v[dn]) / span; let dwdy = (w[n] - w[s]) / (2.0 * p.dy);
  let s2 = 2.0 * (dudx * dudx + dvdy * dvdy + dwdz * dwdz) + (dudy + dvdx) * (dudy + dvdx) + (dudz + dwdx) * (dudz + dwdx) + (dvdz + dwdy) * (dvdz + dwdy);
  let bu = lv[3u * zu].w; let bd = lv[3u * zd].w; let bz = A.w;
  var n2 = G / bz * (th[up] - th[dn] + bu - bd) / span;
  let saturated = (p.flags & 4u) != 0u;
  if (cond[i] > 1e-5 && saturated && cond[up] > 1e-5 && cond[dn] > 1e-5) {
    let t = (th[i] + bz) * lv[3u * z + 1u].x; let qs = qv[i];
    let factor = (1.0 + LV * qs / (RD * t)) / (1.0 + EPS * LV * LV * qs / (CP * RD * t * t));
    n2 = G * (factor * ((th[up] - th[dn] + bu - bd) / (th[i] + bz) + LV / (CP * t) * (qv[up] - qv[dn])) - (qv[up] + cond[up] - qv[dn] - cond[dn])) / span;
  } else if (cond[i] > 1e-5) {
    let tu = th[up] + bu; let td = th[dn] + bd; let ti = th[i] + bz;
    let eu = tu * exp(LV * qv[up] / (CP * tu * lv[3u * zu + 1u].x));
    let ed = td * exp(LV * qv[dn] / (CP * td * lv[3u * zd + 1u].x));
    let ei = ti * exp(LV * qv[i] / (CP * ti * lv[3u * z + 1u].x));
    n2 = G / ei * (eu - ed) / span;
  }
  let rate = sqrt(max(0.0, s2 - n2 / PRANDTL));
  let km = min(A.y, A.x * rate);
  var kh = km; if ((p.flags & 1u) != 0u) { kh = min(p.capH, p.lenH2 * rate); }
  k2[i] = vec2f(km, kh);
}

// The explicit diffusion of a's departure from its base (Turbulence.mix, gathered per node) into scratch.
@compute @workgroup_size(256)
fn mix(@builtin(global_invocation_id) g: vec3u) {
  let layer = p.nx * p.ny; let i = g.x; if (i >= layer * p.nz) { return; }
  let z = i / layer; let c = i % layer; let x = c % p.nx; let y = c / p.nx; let f = m.factor;
  let here = a[i] - base[z]; let K = k2[i]; let B = lv[3u * z + 1u];
  let e = node((x + 1u) % p.nx, y, z); let wst = node((x + p.nx - 1u) % p.nx, y, z);
  let n = node(x, (y + 1u) % p.ny, z); let s = node(x, (y + p.ny - 1u) % p.ny, z);
  var t = f * (K.y + k2[e].y) / 2.0 * (a[e] - base[z] - here) / p.dx / p.dx;
  t -= f * (k2[wst].y + K.y) / 2.0 * (here - (a[wst] - base[z])) / p.dx / p.dx;
  t += f * (K.y + k2[n].y) / 2.0 * (a[n] - base[z] - here) / p.dy / p.dy;
  t -= f * (k2[s].y + K.y) / 2.0 * (here - (a[s] - base[z])) / p.dy / p.dy;
  if (z < p.nz - 1u) { let fz = f * lv[3u * z + 2u].x * (K.x + k2[i + layer].x) / 2.0 * (a[i + layer] - base[z + 1u] - here) / B.w; t += fz / (B.y * B.z); }
  if (z > 0u) { let Bd = lv[3u * (z - 1u) + 1u]; let fz = f * lv[3u * (z - 1u) + 2u].x * (k2[i - layer].x + K.x) / 2.0 * (here - (a[i - layer] - base[z - 1u])) / Bd.w; t -= fz / (B.y * B.z); }
  scratch[i] = a[i] + m.dt * t;
}

// The surface drag on the ground node and the rigid ground and top (mixStep).
@compute @workgroup_size(256)
fn surface(@builtin(global_invocation_id) g: vec3u) {
  let layer = p.nx * p.ny; let b = g.x; if (b >= layer) { return; }
  let ug = u[b] + drag.fu; let vg = v[b] + drag.fv; let speed = sqrt(ug * ug + vg * vg); let envSpeed = sqrt(drag.ue0 * drag.ue0 + drag.ve0 * drag.ve0);
  u[b] -= drag.factor * (speed * ug - envSpeed * drag.ue0); v[b] -= drag.factor * (speed * vg - envSpeed * drag.ve0);
  w[b] = 0.0; w[b + (p.nz - 1u) * layer] = 0.0;
}`

type Kernel = 'loading' | 'buoyancy' | 'rigid' | 'profileTendency'
const USES: Record<Kernel, number[]> = {
  loading: [0, 7, 9, 10, 11, 12, 13, 14], buoyancy: [0, 1, 2, 3, 4, 5, 6, 7, 8], rigid: [0, 8], profileTendency: [0, 2, 15, 16, 17],
}
type PhysKernel = 'sediment' | 'copyBack' | 'viscosity' | 'mix' | 'surface'
const PHYS_USES: Record<PhysKernel, number[]> = {
  sediment: [0, 1, 9, 10, 11, 15, 16], copyBack: [0, 11, 13], viscosity: [0, 1, 2, 3, 4, 5, 6, 7, 8], mix: [0, 1, 8, 9, 10, 11, 12], surface: [0, 2, 3, 4, 14],
}

/** A falling field for the GPU's sedimentation (model.ts fallInputs): its index among the fields, fall speed, sub-steps. */
export interface DynamicsFall { k: number; vt: Float32Array; parts: number }

/** What the GPU's turbulence, friction and projection need (model.ts mixingInputs). */
export interface MixingInputs {
  /** The mixed fields: index among the fields of step(), base profile (null: none) and K factor. */
  mixed: readonly { k: number; base: ArrayLike<number> | null; factor: number }[]
  condensate: Float32Array; exner: ArrayLike<number>
  cs: number; anisotropic: boolean; lengthDz: boolean; saturated: boolean
  drag: { factor: number; fu: number; fv: number; ue0: number; ve0: number }
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
  /** Slots whose constant tendency is zeroed already; the read-back buffer (grown when more fields come). */
  private readonly zeroed = new Set<number>(); private readBuffer: GPUBuffer | null = null; private signature = ''
  /** The bind groups of the field set (made anew with it). */
  private groups: { load: GPUBindGroup; buoyancy: GPUBindGroup[]; rigid: GPUBindGroup; profile: GPUBindGroup } | null = null
  /** Step 6: the sedimentation and turbulence kernels, their buffers (made on first use) and the slots of the last step. */
  private readonly phys = new Map<PhysKernel, GPUComputePipeline>()
  private readonly physParams: GPUBuffer; private readonly physLevels: GPUBuffer; private readonly k2: GPUBuffer; private readonly scratch: GPUBuffer
  private readonly cond: GPUBuffer; private readonly dragParams: GPUBuffer
  private ground: GPUBuffer | null = null; private groundRead: GPUBuffer | null = null
  private readonly fallBuffers: GPUBuffer[] = []; private readonly fallParams: GPUBuffer[] = []
  private readonly mixParams: GPUBuffer[] = []; private readonly mixBases: GPUBuffer[] = []
  private slots: Slot[] = []; private thetaIndex = -1

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
    const phys = device.createShaderModule({ code: PHYS })
    for (const k of Object.keys(PHYS_USES) as PhysKernel[]) this.phys.set(k, device.createComputePipeline({ layout: 'auto', compute: { module: phys, entryPoint: k } }))
    this.physParams = device.createBuffer({ size: 48, usage: UNIFORM | COPY_DST }); this.dragParams = device.createBuffer({ size: 32, usage: UNIFORM | COPY_DST })
    this.physLevels = make(48 * nz); this.k2 = make(8 * n); this.scratch = make(4 * n); this.cond = make(4 * n)
  }

  private physGroup(k: PhysKernel, buffers: Record<number, GPUBuffer>) {
    return this.device.createBindGroup({ layout: this.phys.get(k)!.getBindGroupLayout(0), entries: PHYS_USES[k].map(b => ({ binding: b, resource: { buffer: buffers[b] } })) })
  }

  private physDispatch(pass: GPUComputePassEncoder, k: PhysKernel, group: GPUBindGroup, threads: number) {
    pass.setPipeline(this.phys.get(k)!); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(threads / 256))
  }

  /** The uniforms and per-level data of the step-6 kernels (Turbulence.viscosity's widths and caps, the levels). */
  private writePhysics(dt: number, mix: MixingInputs | null) {
    const g = this.grid, { nx, ny, nz, dx, dy, zs, dzs, hz } = g, rho = this.env.rho, cs = mix?.cs ?? 0
    const raw = new ArrayBuffer(48), U = new Uint32Array(raw, 0, 4), F = new Float32Array(raw, 16, 8)
    U.set([nx, ny, nz, (mix?.anisotropic ? 1 : 0) | (mix?.saturated ? 4 : 0)])
    F.set([dx, dy, (cs * Math.sqrt(dx * dy)) ** 2, .05 * Math.min(dx, dy) ** 2 / dt, dt, 0, 0, 0])
    this.device.queue.writeBuffer(this.physParams, 0, raw)
    const lv = new Float32Array(12 * nz)
    for (let z = 0; z < nz; z++) {
      const local = z === 0 ? dzs[0] : z === nz - 1 ? dzs[nz - 2] : hz[z], len2 = (cs * (mix?.anisotropic && mix.lengthDz ? local : Math.cbrt(dx * dy * local))) ** 2
      const cap = .05 * Math.min(dx, dy, z > 0 ? dzs[z - 1] : Infinity, z < nz - 1 ? dzs[z] : Infinity) ** 2 / dt
      const span = zs[z + (z < nz - 1 ? 1 : 0)] - zs[z - (z > 0 ? 1 : 0)]
      lv.set([len2, cap, span, this.env.theta[z], mix?.exner[z] ?? this.env.exner[z], rho[z], hz[z], z < nz - 1 ? dzs[z] : 1, z < nz - 1 ? (rho[z] + rho[z + 1]) / 2 : 0, 0, 0, 0], 12 * z)
    }
    this.device.queue.writeBuffer(this.physLevels, 0, lv)
  }

  /** Encodes the sedimentation of the falls (into the fields' slots), what leaves the ground into `ground`. */
  private encodeFalls(enc: GPUCommandEncoder, falls: readonly DynamicsFall[], slots: Slot[], dt: number) {
    const d = this.device, { n, layer } = this.grid
    if (!falls.length) return
    if (!this.ground || this.ground.size < 4 * layer * falls.length) {
      this.ground?.destroy(); this.groundRead?.destroy()
      this.ground = d.createBuffer({ size: 4 * layer * falls.length, usage: STORAGE | COPY_SRC | COPY_DST })
      this.groundRead = d.createBuffer({ size: 4 * layer * falls.length, usage: MAP_READ | COPY_DST })
    }
    enc.clearBuffer(this.ground, 0, 4 * layer * falls.length)
    falls.forEach((f, j) => {
      if (!this.fallBuffers[j]) { this.fallBuffers[j] = d.createBuffer({ size: 4 * n, usage: STORAGE | COPY_DST }); this.fallParams[j] = d.createBuffer({ size: 16, usage: UNIFORM | COPY_DST }) }
      d.queue.writeBuffer(this.fallBuffers[j], 0, f.vt)
      const raw = new ArrayBuffer(16); new Float32Array(raw, 0, 2).set([0, dt / f.parts]); new Uint32Array(raw, 8, 1)[0] = j
      d.queue.writeBuffer(this.fallParams[j], 0, raw)
    })
    const pass = enc.beginComputePass()
    falls.forEach((f, j) => {
      const q = slots[f.k].q
      const fall = this.physGroup('sediment', { 0: this.physParams, 1: this.physLevels, 9: this.fallParams[j], 10: q, 11: this.scratch, 15: this.fallBuffers[j], 16: this.ground! })
      const back = this.physGroup('copyBack', { 0: this.physParams, 11: this.scratch, 13: q })
      for (let part = 0; part < f.parts; part++) { this.physDispatch(pass, 'sediment', fall, n); this.physDispatch(pass, 'copyBack', back, n) }
    })
    pass.end()
  }

  /**
   * After the physics (CPU), the subgrid turbulence of the mixed fields, the surface friction and the projection on the
   * GPU (model.ts mixStep and project): uploads the mixed fields and the condensate, returns the mixed fields (in
   * `mix.mixed` order) and the pressure (the solver's cells, as model.pressure), and the round trip, ms.
   * Needs the slots of a step() just done (the same fields, by index).
   */
  async mix(fields: readonly DynamicsField[], mix: MixingInputs, dt: number): Promise<{ fields: Float32Array[]; pressure: Float32Array; gpuMs: number }> {
    const d = this.device, g = this.grid, { n, nz, layer } = g, queue = d.queue, el = this.elliptic, slots = this.slots, th = this.thetaIndex, base = this.env.theta
    if (!slots.length) throw new Error('GpuDynamics.mix before step')
    this.writePhysics(dt, mix)
    el.setPressureStep(dt)
    queue.writeBuffer(this.dragParams, 0, Float32Array.of(mix.drag.factor, mix.drag.fu, mix.drag.fv, mix.drag.ue0, mix.drag.ve0, 0, 0, 0))
    queue.writeBuffer(this.cond, 0, mix.condensate)
    mix.mixed.forEach(({ k, base: profile, factor }, j) => {
      const f = fields[k].q
      if (k === th) { const pert = new Float32Array(n); for (let i = 0; i < n; i++) pert[i] = f[i] - base[Math.floor(i / layer)]; queue.writeBuffer(slots[k].q, 0, pert) }
      else queue.writeBuffer(slots[k].q, 0, f)
      if (!this.mixParams[j]) { this.mixParams[j] = d.createBuffer({ size: 16, usage: UNIFORM | COPY_DST }); this.mixBases[j] = d.createBuffer({ size: Math.max(16, 4 * nz), usage: STORAGE | COPY_DST }) }
      queue.writeBuffer(this.mixParams[j], 0, Float32Array.of(factor, dt, 0, 0))
      // theta's slot holds the departure already: its base is zero.
      queue.writeBuffer(this.mixBases[j], 0, k === th || !profile ? new Float32Array(nz) : Float32Array.from(profile))
    })
    const roleOf = (r: Role) => slots[fields.findIndex(f => f.role === r)].q
    const t0 = performance.now(), enc = d.createCommandEncoder(), pass = enc.beginComputePass()
    this.physDispatch(pass, 'viscosity', this.physGroup('viscosity', { 0: this.physParams, 1: this.physLevels, 2: el.buffer(8), 3: el.buffer(9), 4: el.buffer(10), 5: slots[th].q, 6: roleOf('q'), 7: this.cond, 8: this.k2 }), n)
    mix.mixed.forEach(({ k }, j) => {
      const q = slots[k].q
      this.physDispatch(pass, 'mix', this.physGroup('mix', { 0: this.physParams, 1: this.physLevels, 8: this.k2, 9: this.mixParams[j], 10: q, 11: this.scratch, 12: this.mixBases[j] }), n)
      this.physDispatch(pass, 'copyBack', this.physGroup('copyBack', { 0: this.physParams, 11: this.scratch, 13: q }), n)
    })
    this.physDispatch(pass, 'surface', this.physGroup('surface', { 0: this.physParams, 2: el.buffer(8), 3: el.buffer(9), 4: el.buffer(10), 14: this.dragParams }), layer)
    el.encodePressure(pass)
    pass.end()
    const cells = g.nx * g.ny * (nz - 1), bytes = 4 * (n * mix.mixed.length + cells)
    if (!this.readBuffer || this.readBuffer.size < bytes) { this.readBuffer?.destroy(); this.readBuffer = d.createBuffer({ size: bytes, usage: MAP_READ | COPY_DST }) }
    const read = this.readBuffer
    mix.mixed.forEach(({ k }, j) => enc.copyBufferToBuffer(slots[k].q, 0, read, 4 * n * j, 4 * n))
    enc.copyBufferToBuffer(el.buffer(4), 0, read, 4 * n * mix.mixed.length, 4 * cells)
    queue.submit([enc.finish()]); await read.mapAsync(1, 0, bytes)
    const all = new Float32Array(read.getMappedRange(0, bytes).slice(0)); read.unmap()
    const gpuMs = performance.now() - t0
    const out = mix.mixed.map((_, j) => all.subarray(j * n, (j + 1) * n))
    mix.mixed.forEach(({ k }, j) => { if (k === th) for (let i = 0; i < n; i++) out[j][i] += base[Math.floor(i / layer)] })
    this.errors.push(...this.transport.errors.splice(0), ...el.errors.splice(0))
    return { fields: out, pressure: all.subarray(n * mix.mixed.length), gpuMs }
  }

  /** Whether this instance fits a model's grid and base state (a new model with the same domain may keep it). */
  matches(grid: Grid, env: { rho: ArrayLike<number>; theta: ArrayLike<number>; exner: ArrayLike<number> }) {
    const g = this.grid, same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, k) => x === b[k])
    return g.nx === grid.nx && g.ny === grid.ny && g.nz === grid.nz && g.dx === grid.dx && g.dy === grid.dy && same(g.zs, grid.zs) && same(this.env.rho, env.rho) && same(this.env.theta, env.theta) && same(this.env.exner, env.exner)
  }

  /** Frees the device and its buffers. */
  destroy() { this.device.destroy() }

  private group(k: Kernel, buffers: Record<number, GPUBuffer>) {
    return this.device.createBindGroup({ layout: this.pipelines.get(k)!.getBindGroupLayout(0), entries: USES[k].map(b => ({ binding: b, resource: { buffer: buffers[b] } })) })
  }

  private dispatch(pass: GPUComputePassEncoder, k: Kernel, group: GPUBindGroup, threads: number) {
    pass.setPipeline(this.pipelines.get(k)!); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(threads / 256))
  }

  /**
   * One step's dynamics by dt. `fields`: the carried fields in any order (u, v, w and theta among them); returns them
   * after the three stages, in the same order (views of one array), and the time: with `timed` the computation's alone
   * (ms, submission to completion), otherwise the whole round trip with the read-back.
   */
  async step(fields: readonly DynamicsField[], env: DynamicsEnv, dt: number, timed = false, falls: readonly DynamicsFall[] = []): Promise<{ fields: Float32Array[]; ground: Float32Array[]; gpuMs: number }> {
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
    // The fields: u, v, w in the elliptic solver's buffers (transported in place), the rest in the transport's own;
    // all made anew when the set of fields changes (e.g. the ice microphysics or lightning switched).
    const signature = fields.map(f => f.role).join()
    if (signature !== this.signature) { this.transport.reset(); this.zeroed.clear(); this.groups = null; this.signature = signature }
    const wind: Partial<Record<Role, number>> = { u: 8, v: 9, w: 10 }
    const slots: Slot[] = fields.map((f, k) => this.transport.slot(k, f.monotone, wind[f.role] !== undefined ? el.buffer(wind[f.role]!) : undefined))
    const th = roleOf('theta'), base = this.env.theta
    fields.forEach((f, k) => {
      if (k === th) { const pert = new Float32Array(n); for (let i = 0; i < n; i++) pert[i] = f.q[i] - base[Math.floor(i / layer)]; queue.writeBuffer(slots[k].q, 0, pert) }
      else queue.writeBuffer(slots[k].q, 0, f.q)
      if (k !== th && !this.zeroed.has(k)) { queue.writeBuffer(slots[k].extra, 0, new Float32Array(n)); this.zeroed.add(k) }
    })
    if (!this.groups) {
      const slotOf = (r: Role) => { const k = roleOf(r); return k < 0 ? this.zero : slots[k].q }, wSlot = slots[roleOf('w')]
      this.groups = {
        load: this.group('loading', { 0: this.params, 7: this.load, 9: slotOf('cloud'), 10: slotOf('ice'), 11: slotOf('rain'), 12: slotOf('snow'), 13: slotOf('graupel'), 14: slotOf('hail') }),
        buoyancy: this.stageRates.map(r => this.group('buoyancy', { 0: this.params, 1: r, 2: this.levels, 3: this.zone, 4: wSlot.tend, 5: slots[th].q, 6: slotOf('q'), 7: this.load, 8: el.buffer(10) })),
        rigid: this.group('rigid', { 0: this.params, 8: el.buffer(10) }),
        profile: this.group('profileTendency', { 0: this.params, 2: this.levels, 15: el.buffer(13), 16: this.base, 17: slots[th].extra }),
      }
    }
    const { load: loadGroup, buoyancy: buoyGroups, rigid: rigidGroup, profile: profileGroup } = this.groups
    // timed (the bench): the computation alone, from a quiet queue to its completion; otherwise one submission with the
    // read-back and a single wait for it (the app).
    this.slots = slots; this.thetaIndex = th
    if (falls.length) this.writePhysics(dt, null)
    if (timed) await queue.onSubmittedWorkDone()
    const t0 = performance.now(), enc = d.createCommandEncoder()
    // Step 6: the precipitation falls first (model.ts beginStep), then the transport.
    this.encodeFalls(enc, falls, slots, dt)
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
    pass.end()
    let gpuMs = 0
    if (timed) { queue.submit([enc.finish()]); await queue.onSubmittedWorkDone(); gpuMs = performance.now() - t0 }
    const bytes = 4 * n * slots.length
    if (!this.readBuffer || this.readBuffer.size < bytes) { this.readBuffer?.destroy(); this.readBuffer = d.createBuffer({ size: bytes, usage: MAP_READ | COPY_DST }) }
    const read = this.readBuffer, e2 = timed ? d.createCommandEncoder() : enc
    slots.forEach((s, k) => e2.copyBufferToBuffer(s.q, 0, read, 4 * n * k, 4 * n))
    const groundBytes = 4 * layer * falls.length
    if (falls.length) e2.copyBufferToBuffer(this.ground!, 0, this.groundRead!, 0, groundBytes)
    queue.submit([e2.finish()]); await Promise.all([read.mapAsync(1, 0, bytes), falls.length ? this.groundRead!.mapAsync(1, 0, groundBytes) : null])
    const all = new Float32Array(read.getMappedRange(0, bytes).slice(0)); read.unmap()
    let landed = new Float32Array(0)
    if (falls.length) { landed = new Float32Array(this.groundRead!.getMappedRange(0, groundBytes).slice(0)); this.groundRead!.unmap() }
    if (!timed) gpuMs = performance.now() - t0
    const out = slots.map((_, k) => all.subarray(k * n, (k + 1) * n))
    if (th >= 0) for (let i = 0; i < n; i++) out[th][i] += base[Math.floor(i / layer)]
    this.errors.push(...this.transport.errors.splice(0), ...el.errors.splice(0))
    return { fields: out, ground: falls.map((_, j) => landed.subarray(j * layer, (j + 1) * layer)), gpuMs }
  }
}
