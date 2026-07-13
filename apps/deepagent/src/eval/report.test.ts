// apps/deepagent/src/eval/report.test.ts
import { test, expect } from 'bun:test'
import { summarize, toJson } from './report'
import type { EvalResult } from './types'

const results: EvalResult[] = [
  {
    caseId: 'ir-1',
    category: 'instrument-resolution',
    passed: true,
    trajectory: [{ name: 'get_ltp', args: { instrument_keys: 'X' }, tool_call_id: '0' }],
    assertionResults: [{ assertion: { kind: 'calls', tool: 'get_ltp', min: 1 }, passed: true, detail: 'get_ltp called 1 time(s)' }],
    durationMs: 12,
  },
  {
    caseId: 'cs-1',
    category: 'candle-sync',
    passed: false,
    trajectory: [{ name: 'sync_candles', args: { source: 'v2' }, tool_call_id: '0' }],
    assertionResults: [{ assertion: { kind: 'not_called', tool: 'sync_candles' }, passed: false, detail: 'sync_candles called 1 time(s)' }],
    durationMs: 9,
  },
]

test('summarize: PASS line, FAIL line with detail + trajectory, summary', () => {
  const out = summarize(results)
  expect(out).toContain('PASS ir-1 (instrument-resolution)')
  expect(out).toContain('FAIL cs-1 (candle-sync)')
  expect(out).toContain('sync_candles called 1 time(s)')
  expect(out).toContain('sync_candles({"source":"v2"})')
  expect(out).toContain('1/2 passed')
})

test('toJson: valid JSON with expected keys', () => {
  const parsed = JSON.parse(toJson(results))
  expect(parsed).toHaveLength(2)
  expect(parsed[0].caseId).toBe('ir-1')
  expect(parsed[0].passed).toBe(true)
})