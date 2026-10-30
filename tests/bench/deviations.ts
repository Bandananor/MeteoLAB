// @ts-nocheck
// One case of the known deviations' catalogue (src/validation/deviations.ts, roadmap A7) run and printed:
//   npx vite build --ssr tests/bench/deviations.ts --outDir .bench/deviations && node .bench/deviations/deviations.js <id>
import { DEVIATIONS } from '../../src/validation/deviations'

const c = DEVIATIONS.find(d => d.id === process.argv[2])
if (!c) { console.error(`ids: ${DEVIATIONS.map(d => d.id).join(', ')}`); process.exit(2) }
const t0 = Date.now(), r = c.run()
for (const k of r.checks) console.log(`${c.id}: ${k.quantity} = ${k.value.toFixed(2)} ${k.unit} (nature ${k.reference}) ${k.value >= k.bounds[0] && k.value <= k.bounds[1] ? 'WITHIN' : 'outside'}`)
console.log(`${c.id}: ${r.note ?? ''} (${((Date.now() - t0) / 60000).toFixed(1)} min)`)
