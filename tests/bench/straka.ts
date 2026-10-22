// @ts-nocheck
// The Straka et al. (1993) density current at a grid spacing and a time step (roadmap A4: the front ~3 % behind and the
// u max ~10 % below the converged reference — is it the time splitting, the base state, the transport?).
//   npx vite build --ssr tests/bench/straka.ts --outDir .bench/straka && node .bench/straka/straka.js [dx=100] [dt=0.5] [variants…]
// Variants: split (pressure once a step, as before 22.10.2026), p0 (1000 hPa at the ground, as in the paper, not 1013),
// bous (Boussinesq: rho0 = 1 in the projection, the transport and the mixing; rho-p / rho-f / rho-k one of them), erf (see ErfSolver), sl (semi-Lagrangian transport).
import { straka } from '../../src/validation/cases'
import { FluxTransport } from '../../src/core/advection'
import { PressureSolver } from '../../src/core/pressure'
import { Turbulence } from '../../src/core/turbulence'

const args = process.argv.slice(2), has = (k: string) => args.includes(k)
const opt = (k: string, d: number) => Number(args.find(a => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? d)
const stages = has('split') ? false : undefined, dx = opt('dx', 100), dt = opt('dt', .5), started = Date.now()
const profile = has('p0') ? { theta: () => 300, rh: () => 0, wind: () => [0, 0], surfacePressure: 100_000 } : undefined
// erf: the pressure force grad(p')/rho0 (ERF's anelastic form) instead of grad(p'/rho0) (Lipps-Hemler, this model's):
// the operator D G without rho0, the divergence of rho0 u as before, the correction divided by rho0 of the node's level.
class ErfSolver extends PressureSolver {
  constructor(grid, rho) { super(grid); this.rhoTrue = Float64Array.from(rho) }
  divergence(u, v, w, dt, out, k0, k1) { const ones = this.rho; this.rho = this.rhoTrue; super.divergence(u, v, w, dt, out, k0, k1); this.rho = ones }
  correct(p, u, v, w, dt, k0 = 0, k1 = this.grid.nz) { for (let k = k0; k < k1; k++) super.correct(p, u, v, w, dt / this.rhoTrue[k], k, k + 1) }
}
const setup = model => {
  if (has('erf')) model.solver = new ErfSolver(model.grid, model.env.rho)
  if (has('sl')) { model.transport = 'semi-lagrangian'; model.config.transport = 'semi-lagrangian' }
  // rho0 = 1 where asked: rho-p the projection, rho-f the transport, rho-k the mixing (bous: all three)
  const ones = new Float64Array(model.grid.nz).fill(1)
  if (has('bous') || has('rho-p')) model.solver = new PressureSolver(model.grid, ones)
  if (has('bous') || has('rho-f')) model.flux = new FluxTransport(model.grid, ones)
  if (has('bous') || has('rho-k')) model.turbulence = new Turbulence(model.grid, ones)
}
const r = straka(dx, dt, stages, { profile, setup }), names = args.filter(a => !a.includes('='))
console.log(`Straka dx ${dx} m dt ${dt} s${names.length ? ` [${names.join(' ')}]` : ''}: front ${r.front.toFixed(2)} km (${r.front1.toFixed(2)} one level up), theta' min ${r.thetaMin.toFixed(2)} K, u max ${r.uMax.toFixed(1)}, w ${r.wMin.toFixed(1)}..${r.wMax.toFixed(1)} m/s (${Math.round((Date.now() - started) / 1000)} s)`)
