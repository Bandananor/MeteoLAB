import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, levelAt, weismanKlemp } from '.'
import { run, SUMMER_DAY } from './fixtures'

/** Local maxima of w at a level (w above `minW`, strongest within ±2 nodes), strongest first. */
function updraftCores(model: AtmosphereModel, height: number, minW: number) {
  const { nx, ny, dx, dy, layer } = model.grid, l = Math.round(levelAt(model.grid, height)) * layer, cores: { x: number; y: number; w: number; uh: number }[] = []
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const w = model.w[x + nx * y + l]
    if (w < minW) continue
    let peak = true
    for (let oy = -2; oy <= 2 && peak; oy++) for (let ox = -2; ox <= 2; ox++) if ((ox || oy) && model.w[(x + ox + nx) % nx + nx * ((y + oy + ny) % ny) + l] > w) { peak = false; break }
    if (peak) cores.push({ x: x * dx, y: y * dy, w, uh: model.uhColumn[x + nx * y] })
  }
  return cores.sort((a, b) => b.w - a.w)
}

// Slow (~7 min with WENO transport): run with `npm run test:slow` (vitest --mode slow); skipped by `npm test`.
const slow = (import.meta as { env?: { MODE?: string } }).env?.MODE === 'slow'

describe('Weisman-Klemp supercell (calibration)', () => {
  // Weisman & Klemp (1982) sounding with a 16 g/kg boundary layer (surface CAPE ~2300 J/kg for the app parcel) and
  // the quarter-circle hodograph (westerly shear, 30 m/s at 6 km). Models at ~1 km resolution split the storm by
  // 40-60 min into a right mover (south of the shear vector, cyclonic) and a weaker left mover (anticyclonic).
  // With the trilinear semi-Lagrangian transport the storm peaks at ~21 m/s and dies by 40 min without splitting;
  // with WENO5 + RK3 it lives past 70 min at ~30 m/s and splits at 30-45 min (2026-09-29).
  it.runIf(slow)('splits into a dominant cyclonic right mover and an anticyclonic left mover (WENO transport)', () => {
    // Warm rain, as in Weisman & Klemp (1982). With ice (the default) the split is the same, but the right mover crosses the
    // periodic east edge at ~52 min into its own cold pool, which melting graupel makes a little colder: it drops to 13 m/s
    // at 60 min (warm rain: 22). The 60-minute check with ice waits for the storm-following domain (level 2).
    const model = new AtmosphereModel({ ...SUMMER_DAY, solarMax: 0, bubble: 0, microphysics: 'warm' }, createGrid(), weismanKlemp({ qvMax: .016 }))
    model.transport = 'weno'
    model.injectBubble(model.grid.width * .3, model.grid.depth * .5, 1.5)
    run(model, 35 * 60)
    const cores = updraftCores(model, 4500, 8)
    expect(cores.length).toBeGreaterThanOrEqual(2)
    const [right, left] = [...cores.slice(0, 2)].sort((a, b) => a.y - b.y)
    expect(left.y - right.y).toBeGreaterThan(4000)
    expect(right.w).toBeGreaterThan(left.w)
    expect(right.uh).toBeGreaterThan(0)
    expect(left.uh).toBeLessThan(0)
    // The right mover is long-lived.
    run(model, 25 * 60)
    expect(updraftCores(model, 4500, 15).length).toBeGreaterThanOrEqual(1)
  }, 1_200_000)
})
