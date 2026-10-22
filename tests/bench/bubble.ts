// @ts-nocheck
// The Bryan & Fritsch (2002) rising thermal at a time step (roadmap A4: does the latent heat, added once a step after
// the RK3 stages, make the moist w max depend on the step? STORMLAB_STAGES=0 for the old splitting):
//   npx vite build --ssr tests/bench/bubble.ts --outDir .bench/bubble && node .bench/bubble/bubble.js [moist|dry] [dt=0.5] [dx=100]
import { bryanFritsch } from '../../src/validation/cases'

const opt = (k: string, d: number) => Number(process.argv.slice(2).find(a => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? d)
const moist = !process.argv.includes('dry'), dt = opt('dt', .5), dx = opt('dx', 100), started = Date.now(), r = bryanFritsch(moist, dx, dt)
console.log(`Bryan-Fritsch ${moist ? 'moist' : 'dry'} dx ${dx} m dt ${dt} s${process.env.STORMLAB_STAGES === '0' ? ' (old splitting)' : ''}: top ${r.top.toFixed(2)} km, centre ${r.centre.toFixed(3)} km, w max ${r.wMax.toFixed(2)} m/s (${Math.round((Date.now() - started) / 1000)} s)`)
