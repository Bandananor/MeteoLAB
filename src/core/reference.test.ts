import { describe, expect, it } from 'vitest'
import { CASES, type Check, passes } from '../validation/cases'

/**
 * Reference cases from the literature, at their own resolution (slow: `npx vitest run --mode slow src/core/reference.test.ts`).
 * Dry, no sun, no Coriolis, no surface drag, no wind relaxation, constant eddy viscosity: the dynamical core alone.
 * The cases, their references and bounds are in src/validation/cases.ts (shared with the validation report).
 */
const slow = (import.meta as { env?: { MODE?: string } }).env?.MODE === 'slow'
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
/** Appends a result line to the file STORMLAB_RESULT, if set (vitest does not show the console output of passing tests). */
async function report(line: string) {
  if (!env.STORMLAB_RESULT) return
  const fs: { appendFileSync(path: string, data: string): void } = await import(/* @vite-ignore */ 'node:' + 'fs')
  fs.appendFileSync(env.STORMLAB_RESULT, line + '\n')
}
/** Every check within its bounds (the failing ones named with their values). */
const outside = (checks: Check[]) => checks.filter(c => !passes(c)).map(c => `${c.quantity} = ${c.value} outside [${c.bounds.join(', ')}]`)
const line = (checks: Check[]) => checks.map(c => `${c.quantity} ${c.value.toFixed(2)}`).join('; ')

describe('reference cases', () => {
  for (const id of ['straka', 'bryan-fritsch']) {
    const c = CASES.find(x => x.id === id)!
    it.runIf(slow)(`${c.title}: within the bounds`, async () => {
      const r = c.run()
      await report(`${c.title}: ${line(r.checks)}`)
      expect(outside(r.checks)).toEqual([])
    }, 1_200_000)
  }
})
