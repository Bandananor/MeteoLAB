// Where a scenario's starting profile is unstable by itself (virtual potential temperature falling with height),
// and its CAPE/CIN: `npx vite-node tests/bench/stability.ts` (or via vite build --ssr).
import { createGrid, Environment, parcelIndices, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'

const grid = createGrid()
for (const s of SCENARIOS.filter(s => !s.values.profile)) {
  const env = new Environment({ ...SUMMER_DAY, ...s.values }, grid)
  const thv = (z: number) => env.thetaEnv(z) * (1 + .61 * env.qEnv(z))
  let worst = 0, at = 0
  for (let z = 50; z < 12000; z += 25) { const g = (thv(z + 25) - thv(z)) / 25 * 1000; if (g < worst) { worst = g; at = z } }
  const i = parcelIndices(env, grid.height)
  console.log(`${s.name.padEnd(24)} min dθv/dz ${worst.toFixed(2).padStart(6)} K/km at ${at} m   SB CAPE ${i.sb.cape.toFixed(0)} CIN ${i.sb.cin.toFixed(0)}  ML CAPE ${i.ml.cape.toFixed(0)} CIN ${i.ml.cin.toFixed(0)}`)
}
