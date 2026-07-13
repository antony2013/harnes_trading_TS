// apps/deepagent/src/eval/assertions.test.ts
import { test, expect } from 'bun:test'
import { gradeAssertion, gradeCase } from './assertions'
import type { TrajectoryStep } from './types'

const traj = (names: string[]): TrajectoryStep[] =>
  names.map((n, i) => ({ name: n, args: {}, tool_call_id: String(i) }))

test('calls: min/max bounds', () => {
  expect(gradeAssertion({ kind: 'calls', tool: 'x', min: 1 }, traj(['x'])).passed).toBe(true)
  expect(gradeAssertion({ kind: 'calls', tool: 'x', min: 2 }, traj(['x'])).passed).toBe(false)
  expect(gradeAssertion({ kind: 'calls', tool: 'x', max: 1 }, traj(['x', 'x'])).passed).toBe(false)
})

test('not_called', () => {
  expect(gradeAssertion({ kind: 'not_called', tool: 'x' }, traj(['y'])).passed).toBe(true)
  expect(gradeAssertion({ kind: 'not_called', tool: 'x' }, traj(['x'])).passed).toBe(false)
})

test('order: relative subsequence', () => {
  expect(gradeAssertion({ kind: 'order', sequence: ['a', 'c'] }, traj(['a', 'b', 'c'])).passed).toBe(true)
  expect(gradeAssertion({ kind: 'order', sequence: ['c', 'a'] }, traj(['a', 'b', 'c'])).passed).toBe(false)
})

test('arg_in / arg_not_in', () => {
  const t: TrajectoryStep[] = [{ name: 'get_ltp', args: { instrument_keys: 'NSE_EQ|INE002A01018' }, tool_call_id: '0' }]
  expect(gradeAssertion({ kind: 'arg_in', tool: 'get_ltp', arg: 'instrument_keys', values: ['NSE_EQ|INE002A01018'] }, t).passed).toBe(true)
  expect(gradeAssertion({ kind: 'arg_in', tool: 'get_ltp', arg: 'instrument_keys', values: ['other'] }, t).passed).toBe(false)
  expect(gradeAssertion({ kind: 'arg_not_in', tool: 'get_ltp', arg: 'instrument_keys', values: ['week'] }, t).passed).toBe(true)
  expect(gradeAssertion({ kind: 'arg_not_in', tool: 'get_ltp', arg: 'instrument_keys', values: ['NSE_EQ|INE002A01018'] }, t).passed).toBe(false)
})

test('arg_matches', () => {
  const t: TrajectoryStep[] = [{ name: 'sync_candles', args: { interval: '5' }, tool_call_id: '0' }]
  expect(gradeAssertion({ kind: 'arg_matches', tool: 'sync_candles', arg: 'interval', regex: '^5$' }, t).passed).toBe(true)
  expect(gradeAssertion({ kind: 'arg_matches', tool: 'sync_candles', arg: 'interval', regex: '^30$' }, t).passed).toBe(false)
})

test('first_is', () => {
  expect(gradeAssertion({ kind: 'first_is', tool: 'a' }, traj(['a', 'b'])).passed).toBe(true)
  expect(gradeAssertion({ kind: 'first_is', tool: 'b' }, traj(['a', 'b'])).passed).toBe(false)
  expect(gradeAssertion({ kind: 'first_is', tool: 'a' }, traj([])).passed).toBe(false)
})

test('custom', () => {
  const t = traj(['x', 'y'])
  expect(gradeAssertion({ kind: 'custom', label: 'len2', check: (tr) => tr.length === 2 ? { passed: true } : { passed: false, detail: 'len!=2' } }, t).passed).toBe(true)
  expect(gradeAssertion({ kind: 'custom', label: 'len3', check: (tr) => tr.length === 3 ? { passed: true } : { passed: false, detail: 'len!=3' } }, t).passed).toBe(false)
})

test('gradeCase: all-must-pass', () => {
  const t = traj(['a'])
  const results = gradeCase(
    [{ kind: 'calls', tool: 'a', min: 1 }, { kind: 'calls', tool: 'b', min: 1 }],
    t,
  )
  expect(results).toHaveLength(2)
  expect(results[0].passed).toBe(true)
  expect(results[1].passed).toBe(false)
})