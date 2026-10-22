// @ts-nocheck
// The Straka et al. (1993) density current at a grid spacing and a time step (roadmap A4: the front ~3 % behind and the
// u max ~10 % below the converged reference — is it the time splitting?).
//   npx vite build --ssr tests/bench/straka.ts --outDir .bench/straka && node .bench/straka/straka.js [dx=100] [dt=0.5] [split]
import { straka } from '../../src/validation/cases'

const opt = (k: string, d: number) => Number(process.argv.slice(2).find(a => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? d)
const stages = process.argv.includes('split') ? false : undefined, dx = opt('dx', 100), dt = opt('dt', .5), started = Date.now(), r = straka(dx, dt, stages)
console.log(`Straka dx ${dx} m dt ${dt} s${stages === false ? ' (pressure once a step, as before 22.10.2026)' : ''}: front ${r.front.toFixed(2)} km, theta' min ${r.thetaMin.toFixed(2)} K, u max ${r.uMax.toFixed(1)}, w ${r.wMin.toFixed(1)}..${r.wMax.toFixed(1)} m/s (${Math.round((Date.now() - started) / 1000)} s)`)
