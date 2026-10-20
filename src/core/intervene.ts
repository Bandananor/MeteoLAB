/**
 * Interventions in a run going on (2.9): what a hand can do to the air at a place, all through one function — a warm
 * thermal (the double click, and the starting thermals: AtmosphereModel.injectBubble), warming or cooling the air near
 * the ground, moistening or drying it, laying a cold pool, setting a vortex spinning. Each is a smooth patch, round on
 * the map (an e-folding radius) and fading with height, added to the fields as they are; the heat and vapour put in
 * are counted (AtmosphereModel.added), so what came from outside the physics is seen beside the storm's own.
 */
import { CP } from './constants'
import { qsatP } from './microphysics'
import type { AtmosphereModel } from './model'

export type InterventionKind = 'thermal' | 'warm' | 'cool' | 'moisten' | 'dry' | 'coldPool' | 'vortex'
/** An intervention at (x, y), m from the domain's corner; `strength` scales its standard size (1 = as described). */
export interface Intervention { kind: InterventionKind; x: number; y: number; strength: number }

/**
 * Each kind's patch: the e-folding radius (m, null: the thermal's own, SimConfig.bubbleRadius) and depth (m), and per
 * unit strength what it adds at the centre. The cold pool is the outflow of a storm that has rained out (-6 K in the
 * lowest ~700 m, a few km across, as in the cold-pool studies of Rotunno et al. 1988); the vortex a cyclonic circulation
 * of 10 m/s at its radius through the lowest 3 km, about a mesocyclone's.
 */
export const INTERVENTIONS: Record<InterventionKind, { radius: number | null; depth: number; top?: number; theta?: number; vapour?: number; w?: number; spin?: number }> = {
  // The thermal as it always was (+3.2 K, 1.1 m/s, up to 2.7 km): the starting thermals and the calibration rest on it.
  thermal: { radius: null, depth: 1800, top: 2700, theta: 3.2, w: 1.1 },
  warm: { radius: 5000, depth: 1000, theta: 2 },
  cool: { radius: 5000, depth: 1000, theta: -2 },
  moisten: { radius: 5000, depth: 1200, vapour: .002 },
  dry: { radius: 5000, depth: 1200, vapour: -.002 },
  coldPool: { radius: 4000, depth: 700, theta: -6 },
  vortex: { radius: 3000, depth: 3000, spin: 10 },
}
/** The moistening stops short of saturation: a cloud should grow from the air rising, not be painted in. */
const MOIST_CAP = .95
/** Heights a patch reaches unless it sets its own top, in e-folding depths (beyond it, nothing worth adding). */
const REACH = 3

/** Applies an intervention to the model's fields; returns the heat (J) and vapour (kg) put in. */
export function intervene(m: AtmosphereModel, it: Intervention) {
  const { nx, ny, nz, dx, dy, zs, hz, width: W, depth: D } = m.grid, kind = INTERVENTIONS[it.kind], e = m.env
  const radius = kind.radius ?? (m.config.bubbleRadius ?? 4.2) * 1000, a0 = it.strength
  let heat = 0, vapour = 0
  for (let z = 0; z < nz && zs[z] < (kind.top ?? kind.depth * REACH); z++) {
    const mass = e.rho[z] * dx * dy * hz[z], exner = e.exner[z], p = e.p[z]
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      // The shortest way round the periodic domain.
      let ddx = x * dx - it.x, ddy = y * dy - it.y
      if (ddx > W / 2) ddx -= W; if (ddx < -W / 2) ddx += W; if (ddy > D / 2) ddy -= D; if (ddy < -D / 2) ddy += D
      const r2 = (ddx / radius) ** 2 + (ddy / radius) ** 2, a = Math.exp(-r2 - (zs[z] / kind.depth) ** 2) * a0, i = x + nx * (y + ny * z)
      if (kind.theta) { m.theta[i] += kind.theta * a; heat += CP * exner * kind.theta * a * mass }
      if (kind.w) m.w[i] += kind.w * a
      if (kind.vapour) {
        const before = m.q[i], cap = MOIST_CAP * qsatP(m.theta[i] * exner - 273.15, p)
        m.q[i] = kind.vapour > 0 ? Math.max(before, Math.min(cap, before + kind.vapour * a)) : Math.max(0, before + kind.vapour * a)
        vapour += (m.q[i] - before) * mass
      }
      if (kind.spin) {
        // A cyclonic (anticlockwise) vortex, non-divergent: the speed r/R exp((1 - r²/R²)/2) times spin, round the centre.
        const r = Math.sqrt(r2), speed = kind.spin * a0 * r * Math.exp((1 - r2) / 2) * Math.exp(-((zs[z] / kind.depth) ** 2)), d = Math.hypot(ddx, ddy)
        if (d > 0) { m.u[i] -= speed * ddy / d; m.v[i] += speed * ddx / d }
      }
    }
  }
  m.added.heat += heat; m.added.vapour += vapour; m.added.count++
  return { heat, vapour }
}
