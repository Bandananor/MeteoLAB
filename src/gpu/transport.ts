// WebGPU port of the transport tendency (src/core/advection.ts FluxTransport.tendency), Э3 step 1 (16.11.2026): the
// flux-form WENO5 (monotone fields) or linear fifth-order upwind tendency of a field, given the projected face mass
// fluxes. Float32 throughout (WebGPU has no doubles), so the result matches the TypeScript core (float64 sums) to about
// 1e-6 of the field's tendency scale, not bit for bit; tests/bench/gpucheck.ts compares them on a storm.
// The WENO weights are made scale-free before the division: the stencil is divided by its largest value, which the
// TypeScript form (eps 1e-40, products of squares) cannot afford in float32 — water of 1e-6 kg/kg would underflow.
import type { Grid } from '../core/grid'

// WebGPU flag values (the spec's; the DOM types here carry the interfaces but not these constants).
const MAP_READ = 1, COPY_SRC = 4, COPY_DST = 8, UNIFORM = 64, STORAGE = 128

const WGSL = /* wgsl */`
struct Params { nx: u32, ny: u32, nz: u32, monotone: u32, dx: f32, dy: f32, pad0: f32, pad1: f32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> q: array<f32>;
@group(0) @binding(2) var<storage, read> mx: array<f32>;
@group(0) @binding(3) var<storage, read> my: array<f32>;
@group(0) @binding(4) var<storage, read> mz: array<f32>;
@group(0) @binding(5) var<storage, read_write> fx: array<f32>;
@group(0) @binding(6) var<storage, read_write> fy: array<f32>;
@group(0) @binding(7) var<storage, read_write> fz: array<f32>;
@group(0) @binding(8) var<storage, read> div: array<f32>;
@group(0) @binding(9) var<storage, read> rho: array<f32>;
@group(0) @binding(10) var<storage, read> h: array<f32>;
@group(0) @binding(11) var<storage, read_write> tend: array<f32>;
@group(0) @binding(12) var<storage, read_write> qw: array<f32>;
@group(0) @binding(13) var<storage, read> start: array<f32>;
@group(0) @binding(14) var<storage, read> extra: array<f32>;
struct Stage { step: f32, pad0: f32, pad1: f32, pad2: f32 }
@group(0) @binding(15) var<uniform> stage: Stage;

fn at(x: i32, y: i32, z: i32) -> f32 {
  let nx = i32(p.nx); let ny = i32(p.ny); let nz = i32(p.nz);
  return q[u32(((x % nx) + nx) % nx + nx * ((((y % ny) + ny) % ny) + ny * clamp(z, 0, nz - 1)))];
}
fn weno(a0: f32, b0: f32, c0: f32, d0: f32, e0: f32) -> f32 {
  let s = max(max(max(abs(a0), abs(b0)), max(abs(c0), abs(d0))), abs(e0));
  if (s == 0.0) { return 0.0; }
  let a = a0 / s; let b = b0 / s; let c = c0 / s; let d = d0 / s; let e = e0 / s;
  let p0 = (2.0 * a - 7.0 * b + 11.0 * c) / 6.0; let p1 = (-b + 5.0 * c + 2.0 * d) / 6.0; let p2 = (2.0 * c + 5.0 * d - e) / 6.0;
  let s0 = a - 2.0 * b + c; let t0 = a - 4.0 * b + 3.0 * c; let s1 = b - 2.0 * c + d; let t1 = b - d; let s2 = c - 2.0 * d + e; let t2 = 3.0 * c - 4.0 * d + e;
  let eps = 2e-7 * (a * a + b * b + c * c + d * d + e * e) + 1e-30;
  let k0 = eps + 13.0 / 12.0 * s0 * s0 + 0.25 * t0 * t0; let k1 = eps + 13.0 / 12.0 * s1 * s1 + 0.25 * t1 * t1; let k2 = eps + 13.0 / 12.0 * s2 * s2 + 0.25 * t2 * t2;
  let w0 = 0.1 / (k0 * k0); let w1 = 0.6 / (k1 * k1); let w2 = 0.3 / (k2 * k2);
  return s * (w0 * p0 + w1 * p1 + w2 * p2) / (w0 + w1 + w2);
}
fn upwind5(a: f32, b: f32, c: f32, d: f32, e: f32) -> f32 { return (2.0 * a - 13.0 * b + 47.0 * c + 27.0 * d - 3.0 * e) / 60.0; }
fn face(a: f32, b: f32, c: f32, d: f32, e: f32) -> f32 { if (p.monotone == 1u) { return weno(a, b, c, d, e); } return upwind5(a, b, c, d, e); }

// Fluxes through the faces between each node and its next neighbour in x, y and z (none through the top).
@compute @workgroup_size(8, 8, 4)
fn fluxes(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.nx || g.y >= p.ny || g.z >= p.nz) { return; }
  let x = i32(g.x); let y = i32(g.y); let z = i32(g.z); let i = g.x + p.nx * (g.y + p.ny * g.z);
  let m1 = mx[i];
  if (m1 >= 0.0) { fx[i] = m1 * face(at(x - 2, y, z), at(x - 1, y, z), at(x, y, z), at(x + 1, y, z), at(x + 2, y, z)); }
  else { fx[i] = m1 * face(at(x + 3, y, z), at(x + 2, y, z), at(x + 1, y, z), at(x, y, z), at(x - 1, y, z)); }
  let m2 = my[i];
  if (m2 >= 0.0) { fy[i] = m2 * face(at(x, y - 2, z), at(x, y - 1, z), at(x, y, z), at(x, y + 1, z), at(x, y + 2, z)); }
  else { fy[i] = m2 * face(at(x, y + 3, z), at(x, y + 2, z), at(x, y + 1, z), at(x, y, z), at(x, y - 1, z)); }
  let m3 = mz[i];
  if (g.z == p.nz - 1u) { fz[i] = 0.0; }
  else if (m3 >= 0.0) { fz[i] = m3 * face(at(x, y, z - 2), at(x, y, z - 1), at(x, y, z), at(x, y, z + 1), at(x, y, z + 2)); }
  else { fz[i] = m3 * face(at(x, y, z + 3), at(x, y, z + 2), at(x, y, z + 1), at(x, y, z), at(x, y, z - 1)); }
}

// The tendency from the flux divergence, with -q div(rho0 u) (round-off after the face projection).
@compute @workgroup_size(8, 8, 4)
fn tendency(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.nx || g.y >= p.ny || g.z >= p.nz) { return; }
  let nx = p.nx; let ny = p.ny; let layer = nx * ny; let i = g.x + nx * (g.y + ny * g.z);
  let xm = (g.x + nx - 1u) % nx + nx * (g.y + ny * g.z); let ym = g.x + nx * ((g.y + ny - 1u) % ny + ny * g.z);
  var below = 0.0; if (g.z > 0u) { below = fz[i - layer]; }
  let flux = (fx[i] - fx[xm]) / p.dx + (fy[i] - fy[ym]) / p.dy + (fz[i] - below) / h[g.z];
  tend[i] = -(flux - q[i] * div[i]) / rho[g.z];
}

// An RK3 stage: the field from its value at the start of the step, the stage's share of dt times the tendency and an
// added constant tendency (theta's base profile, transported in float64 on the CPU; zero otherwise).
@compute @workgroup_size(256)
fn update(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; if (i >= p.nx * p.ny * p.nz) { return; }
  qw[i] = start[i] + stage.step * (tend[i] + extra[i]);
}`

/** Fractions of dt of the three Runge-Kutta stages (Wicker & Skamarock 2002), as advection.ts RK3. */
const RK3_FRACTIONS = [1 / 3, 1 / 2, 1] as const

/** One field's transport on the GPU: its buffers and the bind group. */
interface Slot { q: GPUBuffer; tend: GPUBuffer; start: GPUBuffer; extra: GPUBuffer; fluxGroup: GPUBindGroup; tendGroup: GPUBindGroup; updateGroups: GPUBindGroup[]; params: GPUBuffer }

/**
 * The transport tendency on the GPU for a grid: setFaces() uploads the projected face mass fluxes and their divergence
 * (from FluxTransport), tendencies() computes the tendency of each field (monotone: WENO5, else linear) and reads it back.
 */
export class GpuTransport {
  private readonly device: GPUDevice; private readonly grid: Grid
  private readonly fluxes: GPUComputePipeline; private readonly tend: GPUComputePipeline; private readonly update: GPUComputePipeline
  /** The three RK3 stages' dt shares (uniforms, rewritten by rk3()). */
  private readonly stages: GPUBuffer[]
  private readonly mx: GPUBuffer; private readonly my: GPUBuffer; private readonly mz: GPUBuffer; private readonly div: GPUBuffer
  private readonly fx: GPUBuffer; private readonly fy: GPUBuffer; private readonly fz: GPUBuffer
  private readonly rho: GPUBuffer; private readonly h: GPUBuffer
  private readonly slots: Slot[] = []
  /** WebGPU validation and runtime errors (a failed pipeline does nothing and returns zeros otherwise). */
  readonly errors: string[] = []

  static async create(grid: Grid, rho: ArrayLike<number>, adapterOptions: GPURequestAdapterOptions = { powerPreference: 'high-performance' }) {
    const adapter = await navigator.gpu?.requestAdapter(adapterOptions)
    if (!adapter) throw new Error('no WebGPU adapter')
    // Each kernel binds at most 8 storage buffers, the default limit.
    const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } })
    return new GpuTransport(device, grid, rho, `${adapter.info?.vendor ?? ''} ${adapter.info?.architecture ?? ''}`.trim())
  }

  readonly adapter: string

  private constructor(device: GPUDevice, grid: Grid, rho: ArrayLike<number>, adapter: string) {
    this.device = device; this.grid = grid; this.adapter = adapter
    device.addEventListener('uncapturederror', e => this.errors.push((e as GPUUncapturedErrorEvent).error.message))
    const module = device.createShaderModule({ code: WGSL })
    // Layouts of their own (layout 'auto'): the fluxes bind 0-7, the tendency 0, 1 and 5-11 — 7 and 8 storage buffers.
    this.fluxes = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'fluxes' } })
    this.tend = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'tendency' } })
    this.update = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'update' } })
    this.stages = [0, 1, 2].map(() => device.createBuffer({ size: 16, usage: UNIFORM | COPY_DST }))
    const n = grid.n, S = STORAGE | COPY_DST | COPY_SRC, f = (size = n) => device.createBuffer({ size: size * 4, usage: S })
    this.mx = f(); this.my = f(); this.mz = f(); this.div = f(); this.fx = f(); this.fy = f(); this.fz = f()
    this.rho = f(grid.nz); this.h = f(grid.nz)
    device.queue.writeBuffer(this.rho, 0, Float32Array.from(rho)); device.queue.writeBuffer(this.h, 0, Float32Array.from(grid.hz))
  }

  /** The projected face mass fluxes and their divergence (FluxTransport after setVelocity). */
  setFaces(mx: ArrayLike<number>, my: ArrayLike<number>, mz: ArrayLike<number>, div: ArrayLike<number>) {
    const q = this.device.queue
    q.writeBuffer(this.mx, 0, Float32Array.from(mx)); q.writeBuffer(this.my, 0, Float32Array.from(my)); q.writeBuffer(this.mz, 0, Float32Array.from(mz)); q.writeBuffer(this.div, 0, Float32Array.from(div))
  }

  private slot(k: number, monotone: boolean) {
    const d = this.device, g = this.grid, n = g.n
    let s = this.slots[k]
    if (!s) {
      const S = STORAGE | COPY_DST | COPY_SRC
      const q = d.createBuffer({ size: n * 4, usage: S }), tend = d.createBuffer({ size: n * 4, usage: S }), params = d.createBuffer({ size: 32, usage: UNIFORM | COPY_DST })
      const start = d.createBuffer({ size: n * 4, usage: S }), extra = d.createBuffer({ size: n * 4, usage: S })
      const all = [params, q, this.mx, this.my, this.mz, this.fx, this.fy, this.fz, this.div, this.rho, this.h, tend, q, start, extra]
      const bind = (pipeline: GPUComputePipeline, used: number[], more: GPUBindGroupEntry[] = []) => d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [...used.map(i => ({ binding: i, resource: { buffer: all[i] } })), ...more] })
      s = this.slots[k] = { q, tend, start, extra, params, fluxGroup: bind(this.fluxes, [0, 1, 2, 3, 4, 5, 6, 7]), tendGroup: bind(this.tend, [0, 1, 5, 6, 7, 8, 9, 10, 11]),
        updateGroups: this.stages.map(u => bind(this.update, [0, 11, 12, 13, 14], [{ binding: 15, resource: { buffer: u } }])) }
    }
    const raw = new ArrayBuffer(32); new Uint32Array(raw, 0, 4).set([g.nx, g.ny, g.nz, monotone ? 1 : 0]); new Float32Array(raw, 16, 4).set([g.dx, g.dy, 0, 0])
    d.queue.writeBuffer(s.params, 0, raw)
    return s
  }

  /**
   * The three RK3 stages of the fields' transport by dt with the face fluxes of setFaces() (frozen over the step, as in the
   * model): each field uploaded once, its stages on the GPU, the result read back. `extra`: a constant tendency added in
   * every stage (theta's base profile). Returns the fields after the step and the GPU time from submission to completion.
   */
  async rk3(fields: readonly { q: Float32Array; monotone: boolean; extra?: Float32Array }[], dt: number): Promise<{ fields: Float32Array[]; gpuMs: number }> {
    const d = this.device, g = this.grid, n = g.n, wg = [Math.ceil(g.nx / 8), Math.ceil(g.ny / 8), Math.ceil(g.nz / 4)] as const, flat = Math.ceil(n / 256)
    RK3_FRACTIONS.forEach((f, k) => d.queue.writeBuffer(this.stages[k], 0, Float32Array.of(f * dt, 0, 0, 0)))
    const zero = new Float32Array(n)
    const slots = fields.map((f, k) => { const s = this.slot(k, f.monotone); d.queue.writeBuffer(s.q, 0, f.q); d.queue.writeBuffer(s.start, 0, f.q); d.queue.writeBuffer(s.extra, 0, f.extra ?? zero); return s })
    await d.queue.onSubmittedWorkDone()
    const t0 = performance.now(), enc = d.createCommandEncoder(), pass = enc.beginComputePass()
    for (let stage = 0; stage < 3; stage++) for (const s of slots) {
      pass.setPipeline(this.fluxes); pass.setBindGroup(0, s.fluxGroup); pass.dispatchWorkgroups(...wg)
      pass.setPipeline(this.tend); pass.setBindGroup(0, s.tendGroup); pass.dispatchWorkgroups(...wg)
      pass.setPipeline(this.update); pass.setBindGroup(0, s.updateGroups[stage]); pass.dispatchWorkgroups(flat)
    }
    pass.end(); d.queue.submit([enc.finish()]); await d.queue.onSubmittedWorkDone()
    const gpuMs = performance.now() - t0
    const read = d.createBuffer({ size: n * 4 * slots.length, usage: MAP_READ | COPY_DST }), e2 = d.createCommandEncoder()
    slots.forEach((s, k) => e2.copyBufferToBuffer(s.q, 0, read, k * n * 4, n * 4))
    d.queue.submit([e2.finish()]); await read.mapAsync(1)
    const all = new Float32Array(read.getMappedRange().slice(0)); read.unmap(); read.destroy()
    return { fields: slots.map((_, k) => all.subarray(k * n, (k + 1) * n)), gpuMs }
  }

  /**
   * Tendencies of the fields (uploaded, computed, read back), and the GPU time of the computation alone (ms, from the
   * submission to completion, uploads excluded). Each field after the other: the face flux buffers are shared.
   */
  async tendencies(fields: readonly { q: Float32Array; monotone: boolean }[]): Promise<{ tend: Float32Array[]; gpuMs: number }> {
    const d = this.device, g = this.grid, n = g.n, wg = [Math.ceil(g.nx / 8), Math.ceil(g.ny / 8), Math.ceil(g.nz / 4)] as const
    const slots = fields.map((f, k) => { const s = this.slot(k, f.monotone); d.queue.writeBuffer(s.q, 0, f.q); return s })
    await d.queue.onSubmittedWorkDone()
    const t0 = performance.now(), enc = d.createCommandEncoder()
    for (const s of slots) {
      const pass = enc.beginComputePass()
      pass.setPipeline(this.fluxes); pass.setBindGroup(0, s.fluxGroup); pass.dispatchWorkgroups(...wg)
      pass.setPipeline(this.tend); pass.setBindGroup(0, s.tendGroup); pass.dispatchWorkgroups(...wg)
      pass.end()
    }
    d.queue.submit([enc.finish()]); await d.queue.onSubmittedWorkDone()
    const gpuMs = performance.now() - t0
    const read = d.createBuffer({ size: n * 4 * slots.length, usage: MAP_READ | COPY_DST }), e2 = d.createCommandEncoder()
    slots.forEach((s, k) => e2.copyBufferToBuffer(s.tend, 0, read, k * n * 4, n * 4))
    d.queue.submit([e2.finish()]); await read.mapAsync(1)
    const all = new Float32Array(read.getMappedRange().slice(0)); read.unmap(); read.destroy()
    return { tend: slots.map((_, k) => all.subarray(k * n, (k + 1) * n)), gpuMs }
  }
}
