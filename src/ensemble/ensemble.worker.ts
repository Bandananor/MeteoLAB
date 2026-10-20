// Runs ensemble members (src/ensemble/member.ts) off the main thread, one at a time, on one core each: the ensemble
// keeps several of these busy at once (src/ensemble/panel.ts).
import type { SimConfig } from '../core'
import { runMember, type MemberResult } from './member'

export type EnsembleRequest = { type: 'run'; config: SimConfig; minutes: number }
export type EnsembleReply = { type: 'progress'; time: number } | { type: 'done'; result: MemberResult } | { type: 'error'; message: string }

const scope = self as unknown as { postMessage(message: EnsembleReply, transfer?: Transferable[]): void; addEventListener(type: 'message', listener: (event: MessageEvent<EnsembleRequest>) => void): void }

scope.addEventListener('message', ({ data }) => {
  try {
    const result = runMember(data.config, data.minutes, time => scope.postMessage({ type: 'progress', time }))
    scope.postMessage({ type: 'done', result }, [result.rainTotal.buffer, result.hailSize.buffer, result.gustMax.buffer, result.uhMax.buffer])
  } catch (error) { scope.postMessage({ type: 'error', message: (error as Error).message }) }
})
