import { test, expect } from 'bun:test'
import { orchestrationCases } from './orchestration'
import type { TrajectoryStep } from '../types'

const or1 = orchestrationCases.find((c) => c.id === 'or-1')!
const check = (or1.assertions[0] as { check: (t: TrajectoryStep[]) => { passed: boolean; detail?: string } }).check

test('or-1 delegated-or-batched: delegation to a subagent passes', () => {
  // Coordinator delegates via task; the quant subagent makes 5 internal market-data calls.
  const t: TrajectoryStep[] = [
    { name: 'task', args: { subagent_type: 'quant' }, tool_call_id: '0', scope: 'coordinator' },
    { name: 'historical_candles', args: {}, tool_call_id: '1', scope: 'quant' },
    { name: 'historical_candles', args: {}, tool_call_id: '2', scope: 'quant' },
    { name: 'historical_candles', args: {}, tool_call_id: '3', scope: 'quant' },
    { name: 'historical_candles', args: {}, tool_call_id: '4', scope: 'quant' },
    { name: 'historical_candles', args: {}, tool_call_id: '5', scope: 'quant' },
  ]
  expect(check(t).passed).toBe(true)
})

test('or-1 delegated-or-batched: 5 direct coordinator market-data calls fails', () => {
  const t: TrajectoryStep[] = Array.from({ length: 5 }, (_, i) => ({
    name: 'historical_candles',
    args: {},
    tool_call_id: String(i),
    scope: 'coordinator',
  }))
  expect(check(t).passed).toBe(false)
})