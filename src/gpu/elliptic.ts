// WebGPU port of the two exact elliptic projections, Э3 step 3 (16.11.2026): the face mass fluxes' projection
// (src/core/advection.ts FluxTransport.setVelocity: faces, divergence, the spectral solve, correctFaces) and the
// pressure projection of the node velocities (src/core/pressure.ts PressureSolver: dual-cell divergence, solve, correct).
// Both: a 2D DFT of each layer (here a direct sum over each row in x, then each column in y, with a table of the
// twiddles — any nx, ny), one tridiagonal system per horizontal mode (one GPU thread each, Thomas algorithm), the
// inverse DFT. Float32 (no doubles in WebGPU): the divergence left is ~1e-6 of what it was, not round-off of float64.
// tests/bench/gpucheck.ts compares both with the TypeScript core.
import type { Grid } from '../core/grid'

const MAP_READ = 1, COPY_SRC = 4, COPY_DST = 8, UNIFORM = 64, STORAGE = 128

const WGSL = /* wgsl */`
struct P { nx: u32, ny: u32, nz: u32, layers: u32, mh: u32, pad0: u32, pad1: u32, pad2: u32, dx: f32, dy: f32, dt: f32, scale: f32 }
@group(0) @binding(0) var<uniform> p: P;
// Per node level: rho, the node's control-volume height hz, the spacing to the next level dzs, rho at the face above.
@group(0) @binding(1) var<storage, read> lv: array<vec4f>;
// Twiddles cos/sin(2 pi k / nx) and (2 pi k / ny).
@group(0) @binding(2) var<storage, read> twx: array<vec2f>;
@group(0) @binding(3) var<storage, read> twy: array<vec2f>;
// A real field (input of the forward DFT or output of the inverse), the half spectra A (after x) and B (after y).
@group(0) @binding(4) var<storage, read_write> real: array<f32>;
@group(0) @binding(5) var<storage, read_write> sa: array<vec2f>;
@group(0) @binding(6) var<storage, read_write> sb: array<vec2f>;
// Thomas scratch per mode and level: (cp, -), (dRe, dIm).
@group(0) @binding(7) var<storage, read_write> scr: array<vec4f>;
// Velocities and face fluxes.
@group(0) @binding(8) var<storage, read_write> u: array<f32>;
@group(0) @binding(9) var<storage, read_write> v: array<f32>;
@group(0) @binding(10) var<storage, read_write> w: array<f32>;
@group(0) @binding(11) var<storage, read_write> mx: array<f32>;
@group(0) @binding(12) var<storage, read_write> my: array<f32>;
@group(0) @binding(13) var<storage, read_write> mz: array<f32>;

fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn spec(layer: u32, n: u32, m: u32) -> u32 { return (layer * p.ny + n) * (p.mh + 1u) + m; }

// Forward DFT in x of each real row: A[l][j][m] = sum_i real[l][j][i] exp(-2 pi i m i / nx), m <= nx/2.
@compute @workgroup_size(64)
fn dftX(@builtin(global_invocation_id) g: vec3u) {
  let t = g.x; let mm = p.mh + 1u; if (t >= p.layers * p.ny * mm) { return; }
  let m = t % mm; let row = t / mm; let base = row * p.nx;
  var s = vec2f(0.0);
  for (var i = 0u; i < p.nx; i++) { let c = twx[(m * i) % p.nx]; s += real[base + i] * vec2f(c.x, -c.y); }
  sa[t] = s;
}
// Forward DFT in y of each column: B[l][n][m] = sum_j A[l][j][m] exp(-2 pi i n j / ny).
@compute @workgroup_size(64)
fn dftY(@builtin(global_invocation_id) g: vec3u) {
  let t = g.x; let mm = p.mh + 1u; if (t >= p.layers * p.ny * mm) { return; }
  let m = t % mm; let n = (t / mm) % p.ny; let l = t / (mm * p.ny);
  var s = vec2f(0.0);
  for (var j = 0u; j < p.ny; j++) { let c = twy[(n * j) % p.ny]; s += cmul(sa[spec(l, j, m)], vec2f(c.x, -c.y)); }
  sb[t] = s;
}
// Inverse DFT in y: A[l][j][m] = sum_n B[l][n][m] exp(+2 pi i n j / ny).
@compute @workgroup_size(64)
fn idftY(@builtin(global_invocation_id) g: vec3u) {
  let t = g.x; let mm = p.mh + 1u; if (t >= p.layers * p.ny * mm) { return; }
  let m = t % mm; let j = (t / mm) % p.ny; let l = t / (mm * p.ny);
  var s = vec2f(0.0);
  for (var n = 0u; n < p.ny; n++) { s += cmul(sb[spec(l, n, m)], twy[(n * j) % p.ny]); }
  sa[t] = s;
}
// Inverse DFT in x of the Hermitian rows, normalised: real = Re sum over m of the full spectrum (m > nx/2 the conjugates):
// weight 1 for m = 0 and m = nx/2 (their imaginary parts drop out), 2 for the others.
@compute @workgroup_size(64)
fn idftX(@builtin(global_invocation_id) g: vec3u) {
  let t = g.x; if (t >= p.layers * p.ny * p.nx) { return; }
  let i = t % p.nx; let row = t / p.nx; let mm = p.mh + 1u;
  var s = 0.0;
  for (var m = 0u; m < mm; m++) {
    let a = sa[row * mm + m]; let c = twx[(m * i) % p.nx];
    let edge = m == 0u || 2u * m == p.nx;
    if (edge) { s += a.x * c.x; } else { s += 2.0 * (a.x * c.x - a.y * c.y); }
  }
  real[t] = s * p.scale;
}

// The face projection's systems (FluxTransport.modes): per mode, levels 0..nz-1 of sb; lambda the horizontal symbol.
@compute @workgroup_size(64)
fn modesFaces(@builtin(global_invocation_id) g: vec3u) {
  let mm = p.mh + 1u; let t = g.x; if (t >= p.ny * mm) { return; }
  let m = t % mm; let n = t / mm; let nz = p.nz;
  let sx = sin(3.14159265358979 * f32(m) / f32(p.nx)); let sy = sin(3.14159265358979 * f32(n) / f32(p.ny));
  var lam = 4.0 * sx * sx / (p.dx * p.dx) + 4.0 * sy * sy / (p.dy * p.dy);
  let pinned = m == 0u && n == 0u; if (pinned) { lam = 0.0; }
  for (var k = 0u; k < nz; k++) {
    let L = lv[k]; var lo = 0.0; var up = 0.0;
    if (k > 0u) { lo = lv[k - 1u].w / lv[k - 1u].z; }
    if (k < nz - 1u) { up = L.w / L.z; }
    var di = -L.x * L.y * lam - lo - up; var r = L.y * sb[spec(k, n, m)];
    if (pinned && k == 0u) { lo = 0.0; di = 1.0; up = 0.0; r = vec2f(0.0); }
    if (pinned && k == 1u) { lo = 0.0; }
    var piv = di; var prev = vec4f(0.0); if (k > 0u) { prev = scr[spec(k - 1u, n, m)]; piv = di - lo * prev.x; }
    scr[spec(k, n, m)] = vec4f(up / piv, 0.0, (r - lo * prev.zw) / piv);
  }
  var next = vec2f(0.0);
  for (var kk = 0u; kk < nz; kk++) {
    let k = nz - 1u - kk; let s = scr[spec(k, n, m)]; var d = s.zw;
    if (k < nz - 1u) { d = d - s.x * next; }
    next = d; sb[spec(k, n, m)] = d;
  }
}

// The pressure's systems (PressureSolver.tridiagonal): per mode, cell layers 0..nz-2; alpha, beta the symbols.
@compute @workgroup_size(64)
fn modesPressure(@builtin(global_invocation_id) g: vec3u) {
  let mm = p.mh + 1u; let t = g.x; if (t >= p.ny * mm) { return; }
  let m = t % mm; let n = t / mm; let nc = p.nz - 1u;
  let ax = 3.14159265358979 * f32(m) / f32(p.nx); let ay = 3.14159265358979 * f32(n) / f32(p.ny);
  var sx = sin(ax) * sin(ax); var cx = cos(ax) * cos(ax); var sy = sin(ay) * sin(ay); var cy = cos(ay) * cos(ay);
  // The null modes must be exactly zero (cos^2 of pi/2 is not, in floating point).
  if (sx < 1e-6) { sx = 0.0; } if (cx < 1e-6) { cx = 0.0; } if (sy < 1e-6) { sy = 0.0; } if (cy < 1e-6) { cy = 0.0; }
  let a = 4.0 * (sx * cy / (p.dx * p.dx) + cx * sy / (p.dy * p.dy)); let b = cx * cy;
  if ((a == 0.0 && b == 0.0) || (nc == 1u && a == 0.0)) { for (var k = 0u; k < nc; k++) { sb[spec(k, n, m)] = vec2f(0.0); } return; }
  let pinned = a == 0.0;
  for (var k = 0u; k < nc; k++) {
    let L0 = lv[k]; let L1 = lv[k + 1u];
    var di = -a / 2.0 * (L0.x * L0.z / (2.0 * L0.y) + L1.x * L0.z / (2.0 * L1.y)); var lo = 0.0; var up = 0.0;
    if (k > 0u) { lo = -a / 2.0 * L0.x * lv[k - 1u].z / (2.0 * L0.y); let vv = b * L0.x / (L0.y * L0.z); lo += vv; di -= vv; }
    if (k < nc - 1u) { up = -a / 2.0 * L1.x * L1.z / (2.0 * L1.y); let vv = b * L1.x / (L1.y * L0.z); up += vv; di -= vv; }
    var r = sb[spec(k, n, m)];
    if (pinned && k == 0u) { lo = 0.0; di = 1.0; up = 0.0; r = vec2f(0.0); }
    if (pinned && k == 1u) { lo = 0.0; }
    var piv = di; var prev = vec4f(0.0); if (k > 0u) { prev = scr[spec(k - 1u, n, m)]; piv = di - lo * prev.x; }
    scr[spec(k, n, m)] = vec4f(up / piv, 0.0, (r - lo * prev.zw) / piv);
  }
  var next = vec2f(0.0);
  for (var kk = 0u; kk < nc; kk++) {
    let k = nc - 1u - kk; let s = scr[spec(k, n, m)]; var d = s.zw;
    if (k < nc - 1u) { d = d - s.x * next; }
    next = d; sb[spec(k, n, m)] = d;
  }
}

fn node(x: u32, y: u32, z: u32) -> u32 { return x + p.nx * (y + p.ny * z); }

// Face mass fluxes from the node velocities (FluxTransport.faces).
@compute @workgroup_size(64)
fn faces(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; if (i >= p.nx * p.ny * p.nz) { return; }
  let x = i % p.nx; let y = (i / p.nx) % p.ny; let z = i / (p.nx * p.ny); let r = lv[z].x;
  mx[i] = r * (u[i] + u[node((x + 1u) % p.nx, y, z)]) / 2.0;
  my[i] = r * (v[i] + v[node(x, (y + 1u) % p.ny, z)]) / 2.0;
  if (z < p.nz - 1u) { mz[i] = lv[z].w * (w[i] + w[i + p.nx * p.ny]) / 2.0; } else { mz[i] = 0.0; }
}
// Their divergence at the nodes into real (FluxTransport.divergence).
@compute @workgroup_size(64)
fn faceDivergence(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; if (i >= p.nx * p.ny * p.nz) { return; }
  let x = i % p.nx; let y = (i / p.nx) % p.ny; let z = i / (p.nx * p.ny);
  var below = 0.0; if (z > 0u) { below = mz[i - p.nx * p.ny]; }
  real[i] = (mx[i] - mx[node((x + p.nx - 1u) % p.nx, y, z)]) / p.dx + (my[i] - my[node(x, (y + p.ny - 1u) % p.ny, z)]) / p.dy + (mz[i] - below) / lv[z].y;
}
// Subtracts rho0 grad(phi) from the face fluxes; phi in real (FluxTransport.correctFaces).
@compute @workgroup_size(64)
fn correctFaces(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; if (i >= p.nx * p.ny * p.nz) { return; }
  let x = i % p.nx; let y = (i / p.nx) % p.ny; let z = i / (p.nx * p.ny); let r = lv[z].x;
  mx[i] -= r * (real[node((x + 1u) % p.nx, y, z)] - real[i]) / p.dx;
  my[i] -= r * (real[node(x, (y + 1u) % p.ny, z)] - real[i]) / p.dy;
  if (z < p.nz - 1u) { mz[i] -= lv[z].w * (real[i + p.nx * p.ny] - real[i]) / lv[z].z; }
}
// Dual-cell divergence of rho0 u over dt into real (PressureSolver.divergence), cells c = i + nx (j + ny k), k < nz-1.
@compute @workgroup_size(64)
fn pressureDivergence(@builtin(global_invocation_id) g: vec3u) {
  let c = g.x; if (c >= p.nx * p.ny * (p.nz - 1u)) { return; }
  let i = c % p.nx; let j = (c / p.nx) % p.ny; let k = c / (p.nx * p.ny);
  let i1 = (i + 1u) % p.nx; let j1 = (j + 1u) % p.ny; let r0 = lv[k].x / 4.0; let r1 = lv[k + 1u].x / 4.0; let dz = lv[k].z;
  let a = node(i, j, k); let b = node(i1, j, k); let e = node(i, j1, k); let f = node(i1, j1, k);
  let gg = node(i, j, k + 1u); let h = node(i1, j, k + 1u); let s = node(i, j1, k + 1u); let tt = node(i1, j1, k + 1u);
  let ddx = (r0 * (u[b] + u[f] - u[a] - u[e]) + r1 * (u[h] + u[tt] - u[gg] - u[s])) / p.dx;
  let ddy = (r0 * (v[e] + v[f] - v[a] - v[b]) + r1 * (v[s] + v[tt] - v[gg] - v[h])) / p.dy;
  let ddz = (r1 * (w[gg] + w[h] + w[s] + w[tt]) - r0 * (w[a] + w[b] + w[e] + w[f])) / dz;
  real[c] = (ddx + ddy + ddz) / p.dt;
}
// Subtracts dt G p from the node velocities; p in real (PressureSolver.correct).
@compute @workgroup_size(64)
fn pressureCorrect(@builtin(global_invocation_id) g: vec3u) {
  let t = g.x; if (t >= p.nx * p.ny * p.nz) { return; }
  let i = t % p.nx; let j = (t / p.nx) % p.ny; let k = t / (p.nx * p.ny); let nz = p.nz; let cl = p.nx * p.ny;
  var lo = 0u; if (k > 0u) { lo = (k - 1u) * cl; } let hi = min(nz - 2u, k) * cl;
  var wLo = 0.0; if (k > 0u) { wLo = lv[k - 1u].z / lv[k].y; } var wHi = 0.0; if (k < nz - 1u) { wHi = lv[k].z / lv[k].y; }
  let jm = ((j + p.ny - 1u) % p.ny) * p.nx; let j0 = j * p.nx; let im = (i + p.nx - 1u) % p.nx;
  let gx = (wLo * (real[lo + i + jm] + real[lo + i + j0] - real[lo + im + jm] - real[lo + im + j0]) + wHi * (real[hi + i + jm] + real[hi + i + j0] - real[hi + im + jm] - real[hi + im + j0])) / (4.0 * p.dx);
  let gy = (wLo * (real[lo + im + j0] + real[lo + i + j0] - real[lo + im + jm] - real[lo + i + jm]) + wHi * (real[hi + im + j0] + real[hi + i + j0] - real[hi + im + jm] - real[hi + i + jm])) / (4.0 * p.dy);
  u[t] -= p.dt * gx; v[t] -= p.dt * gy;
  if (k > 0u && k < nz - 1u) {
    let below = (k - 1u) * cl; let above = k * cl;
    let gz = (real[above + im + jm] + real[above + i + jm] + real[above + im + j0] + real[above + i + j0] - real[below + im + jm] - real[below + i + jm] - real[below + im + j0] - real[below + i + j0]) / (4.0 * lv[k].y);
    w[t] -= p.dt * gz;
  }
}`

type Kernel = 'dftX' | 'dftY' | 'idftY' | 'idftX' | 'modesFaces' | 'modesPressure' | 'faces' | 'faceDivergence' | 'correctFaces' | 'pressureDivergence' | 'pressureCorrect'
/** The bindings each kernel uses (at most 8 storage buffers each). */
const USES: Record<Kernel, number[]> = {
  dftX: [0, 2, 4, 5], dftY: [0, 3, 5, 6], idftY: [0, 3, 5, 6], idftX: [0, 2, 4, 5],
  modesFaces: [0, 1, 6, 7], modesPressure: [0, 1, 6, 7],
  faces: [0, 1, 8, 9, 10, 11, 12, 13], faceDivergence: [0, 1, 4, 11, 12, 13], correctFaces: [0, 1, 4, 11, 12, 13],
  pressureDivergence: [0, 1, 4, 8, 9, 10], pressureCorrect: [0, 1, 4, 8, 9, 10],
}

/**
 * The face-flux projection and the pressure projection on the GPU for a grid. Velocities u, v, w live in its buffers
 * (setVelocity / velocity()); faceProjection() leaves the projected face fluxes in mx, my, mz (faceFluxes() reads them,
 * with their divergence), pressureProjection(dt) makes u, v, w free of dual-cell divergence.
 */
export class GpuElliptic {
  readonly adapter: string
  readonly errors: string[] = []
  private readonly device: GPUDevice; private readonly grid: Grid; private readonly mh: number
  private readonly pipelines = new Map<Kernel, GPUComputePipeline>()
  private readonly buffers: GPUBuffer[] = []
  /** Uniforms: the faces' layers (nz), the pressure's cell layers (nz - 1). */
  private readonly faceParams: GPUBuffer; private readonly pressureParams: GPUBuffer
  private readonly groups = new Map<string, GPUBindGroup>()

  static async create(grid: Grid, rho: ArrayLike<number>, options: GPURequestAdapterOptions = { powerPreference: 'high-performance' }) {
    const adapter = await navigator.gpu?.requestAdapter(options)
    if (!adapter) throw new Error('no WebGPU adapter')
    const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } })
    return new GpuElliptic(device, grid, rho, `${adapter.info?.vendor ?? ''} ${adapter.info?.architecture ?? ''}`.trim())
  }

  private constructor(device: GPUDevice, grid: Grid, rho: ArrayLike<number>, adapter: string) {
    this.device = device; this.grid = grid; this.adapter = adapter; this.mh = Math.floor(grid.nx / 2)
    device.addEventListener('uncapturederror', e => this.errors.push((e as GPUUncapturedErrorEvent).error.message))
    const module = device.createShaderModule({ code: WGSL })
    for (const k of Object.keys(USES) as Kernel[]) this.pipelines.set(k, device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: k } }))
    const { nx, ny, nz, n, hz, dzs } = grid, S = STORAGE | COPY_DST | COPY_SRC, spectrum = nz * ny * (this.mh + 1)
    const make = (bytes: number) => device.createBuffer({ size: Math.max(16, bytes), usage: S })
    const levels = new Float32Array(4 * nz)
    for (let k = 0; k < nz; k++) levels.set([rho[k], hz[k], k < nz - 1 ? dzs[k] : 1, k < nz - 1 ? (rho[k] + rho[k + 1]) / 2 : 0], 4 * k)
    const tw = (len: number) => { const a = new Float32Array(2 * len); for (let k = 0; k < len; k++) { a[2 * k] = Math.cos(2 * Math.PI * k / len); a[2 * k + 1] = Math.sin(2 * Math.PI * k / len) } return a }
    // 0 uniform (per call), 1 levels, 2 twx, 3 twy, 4 real, 5 sa, 6 sb, 7 scratch, 8-10 u v w, 11-13 mx my mz.
    const b = this.buffers
    b[1] = make(levels.byteLength); b[2] = make(8 * nx); b[3] = make(8 * ny); b[4] = make(4 * n); b[5] = make(8 * spectrum); b[6] = make(8 * spectrum); b[7] = make(16 * spectrum)
    for (let k = 8; k <= 13; k++) b[k] = make(4 * n)
    device.queue.writeBuffer(b[1], 0, levels); device.queue.writeBuffer(b[2], 0, tw(nx)); device.queue.writeBuffer(b[3], 0, tw(ny))
    const params = (layers: number) => { const raw = new ArrayBuffer(48), u = new Uint32Array(raw, 0, 8), f = new Float32Array(raw, 32, 4); u.set([nx, ny, nz, layers, this.mh, 0, 0, 0]); f.set([grid.dx, grid.dy, 1, 1 / (nx * ny)]); const buf = device.createBuffer({ size: 48, usage: UNIFORM | COPY_DST }); device.queue.writeBuffer(buf, 0, raw); return buf }
    this.faceParams = params(nz); this.pressureParams = params(nz - 1)
  }

  private group(k: Kernel, params: GPUBuffer) {
    const key = `${k}:${params === this.faceParams ? 'f' : 'p'}`
    let g = this.groups.get(key)
    if (!g) {
      g = this.device.createBindGroup({ layout: this.pipelines.get(k)!.getBindGroupLayout(0), entries: USES[k].map(i => ({ binding: i, resource: { buffer: i === 0 ? params : this.buffers[i] } })) })
      this.groups.set(key, g)
    }
    return g
  }

  private run(pass: GPUComputePassEncoder, k: Kernel, params: GPUBuffer, threads: number) {
    pass.setPipeline(this.pipelines.get(k)!); pass.setBindGroup(0, this.group(k, params)); pass.dispatchWorkgroups(Math.ceil(threads / 64))
  }

  setVelocity(u: Float32Array, v: Float32Array, w: Float32Array) {
    const q = this.device.queue; q.writeBuffer(this.buffers[8], 0, u); q.writeBuffer(this.buffers[9], 0, v); q.writeBuffer(this.buffers[10], 0, w)
  }

  /** The spectral solve of the layers in `real` (forward DFT, systems, inverse DFT) into `real`. */
  private solve(pass: GPUComputePassEncoder, params: GPUBuffer, layers: number, modes: Kernel) {
    const { nx, ny } = this.grid, half = layers * ny * (this.mh + 1)
    this.run(pass, 'dftX', params, half); this.run(pass, 'dftY', params, half)
    this.run(pass, modes, params, ny * (this.mh + 1))
    this.run(pass, 'idftY', params, half); this.run(pass, 'idftX', params, layers * ny * nx)
  }

  /** Projects the face fluxes of the current velocity (FluxTransport.setVelocity); returns the GPU time, ms. */
  async faceProjection() {
    const d = this.device, { n, nz } = this.grid, t0 = performance.now(), enc = d.createCommandEncoder(), pass = enc.beginComputePass(), P = this.faceParams
    this.run(pass, 'faces', P, n); this.run(pass, 'faceDivergence', P, n)
    this.solve(pass, P, nz, 'modesFaces')
    this.run(pass, 'correctFaces', P, n)
    pass.end(); d.queue.submit([enc.finish()]); await d.queue.onSubmittedWorkDone()
    return performance.now() - t0
  }

  /** Makes u, v, w free of dual-cell divergence (PressureSolver: divergence over dt, solve, correct); GPU time, ms. */
  async pressureProjection(dt: number) {
    const d = this.device, { nx, ny, nz, n } = this.grid, P = this.pressureParams
    const raw = new Float32Array([this.grid.dx, this.grid.dy, dt, 1 / (nx * ny)]); d.queue.writeBuffer(P, 32, raw)
    await d.queue.onSubmittedWorkDone()
    const t0 = performance.now(), enc = d.createCommandEncoder(), pass = enc.beginComputePass()
    this.run(pass, 'pressureDivergence', P, nx * ny * (nz - 1))
    this.solve(pass, P, nz - 1, 'modesPressure')
    this.run(pass, 'pressureCorrect', P, n)
    pass.end(); d.queue.submit([enc.finish()]); await d.queue.onSubmittedWorkDone()
    return performance.now() - t0
  }

  /** Reads buffers back: indices as in the layout (4 real, 8-10 u v w, 11-13 mx my mz). */
  async read(indices: number[]) {
    const d = this.device, n = this.grid.n, out = d.createBuffer({ size: 4 * n * indices.length, usage: MAP_READ | COPY_DST }), enc = d.createCommandEncoder()
    indices.forEach((k, j) => enc.copyBufferToBuffer(this.buffers[k], 0, out, 4 * n * j, 4 * n))
    d.queue.submit([enc.finish()]); await out.mapAsync(1)
    const all = new Float32Array(out.getMappedRange().slice(0)); out.unmap(); out.destroy()
    return indices.map((_, j) => all.subarray(j * n, (j + 1) * n))
  }

  /** The projected face fluxes and their divergence (recomputed into `real`). */
  async faceFluxes() {
    const d = this.device, enc = d.createCommandEncoder(), pass = enc.beginComputePass()
    this.run(pass, 'faceDivergence', this.faceParams, this.grid.n); pass.end(); d.queue.submit([enc.finish()])
    const [div, mx, my, mz] = await this.read([4, 11, 12, 13])
    return { mx, my, mz, div }
  }
}
