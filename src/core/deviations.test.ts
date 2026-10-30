import { describe, expect, it } from 'vitest'
import { passes } from '../validation/cases'
import { DEVIATIONS } from '../validation/deviations'

// The known deviations from nature (roadmap A7, src/validation/deviations.ts): each case's bounds are nature's range, so
// today the test fails — it.fails turns that into a pass, and the day the fix named works vitest reports the case as
// passing unexpectedly: take its it.fails off and move it to src/validation/cases.ts. Slow (~40 min in all): run with
// `npx vitest run --mode slow src/core/deviations.test.ts`; skipped by `npm test`.
const slow = (import.meta as { env?: { MODE?: string } }).env?.MODE === 'slow'

describe('known deviations from nature (roadmap A7)', () => {
  for (const d of DEVIATIONS) {
    (slow ? it.fails : it.skip)(`${d.title} — until ${d.plan}`, () => {
      const r = d.run()
      console.log(`${d.id}: ${r.checks.map(c => `${c.quantity} = ${c.value.toFixed(2)} (nature ${c.reference})`).join('; ')}`)
      expect(r.checks.every(passes)).toBe(true)
    }, 3_000_000)
  }
})
