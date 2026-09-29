import { describe, expect, it } from 'vitest'
import { AtmosphereModel, createGrid, weismanKlemp } from '.'
import { run, SUMMER_DAY } from './fixtures'

/** Local maxima of w at a level (w above `minW`, strongest within ±2 nodes), strongest first. */
function updraftCores(model: AtmosphereModel, height: number, minW: number) {
  const { nx, ny, dx, dy, dz, layer } = model.grid, l = Math.round(height / dz) * layer, cores: { x: number; y: number; w: number; uh: number }[] = []
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const w = model.w[x + nx * y + l]
    if (w < minW) continue
    let peak = true
    for (let oy = -2; oy <= 2 && peak; oy++) for (let ox = -2; ox <= 2; ox++) if ((ox || oy) && model.w[(x + ox + nx) % nx + nx * ((y + oy + ny) % ny) + l] > w) { peak = false; break }
    if (peak) cores.push({ x: x * dx, y: y * dy, w, uh: model.uhColumn[x + nx * y] })
  }
  return cores.sort((a, b) => b.w - a.w)
}

describe('Weisman-Klemp supercell (calibration)', () => {
  // Weisman & Klemp (1982) sounding with a 16 g/kg boundary layer (surface CAPE ~2300 J/kg for the app parcel) and
  // the quarter-circle hodograph (westerly shear, 30 m/s at 6 km). Models at ~1 km resolution split the storm by
  // 40-60 min into a right mover (south of the shear vector, cyclonic) and a weaker left mover (anticyclonic).
  // Today the storm peaks at ~19 m/s around 20 min and dies by 40 min without splitting: the semi-Lagrangian trilinear
  // transport smears a 4-node updraft (turbulence and the cold-pool parameterisation do not change it). Expected to
  // pass after the level-2 transport and grid work; vitest reports when it starts passing.
  it.fails('splits into a dominant cyclonic right mover and an anticyclonic left mover by 60 min', () => {
    const model = new AtmosphereModel({ ...SUMMER_DAY, solarMax: 0, bubble: 0 }, createGrid(), weismanKlemp({ qvMax: .016 }))
    model.injectBubble(model.grid.width * .3, model.grid.depth * .5, 1.5)
    run(model, 3600)
    const cores = updraftCores(model, 4500, 10)
    expect(cores.length).toBeGreaterThanOrEqual(2)
    const [right, left] = [...cores.slice(0, 2)].sort((a, b) => a.y - b.y)
    expect(left.y - right.y).toBeGreaterThan(8000)
    expect(right.w).toBeGreaterThan(left.w)
    expect(right.uh).toBeGreaterThan(0)
    expect(left.uh).toBeLessThan(0)
  }, 300_000)
})
