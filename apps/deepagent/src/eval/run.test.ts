// apps/deepagent/src/eval/run.test.ts
import { test, expect } from 'bun:test'
import { captureRun } from './run'

/** Build an async iterable over a plain array. */
function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return (async function* () {
    for (const x of items) yield x
  })()
}

/**
 * Build a v3-shaped DeepAgentRunStream fake for unit tests (no real model).
 * - messages: each string becomes one message whose `.text` yields it as a single token.
 * - toolCalls: each {name,input} becomes a coordinator tool call.
 * - subagents: each {name,toolCalls} becomes a subagent handle (used by Task 2).
 */
function v3Stream(spec: {
  messages?: string[]
  toolCalls?: Array<{ name: string; input?: any }>
  subagents?: Array<{ name: string; toolCalls?: Array<{ name: string; input?: any }> }>
}): any {
  return {
    messages: asyncIter((spec.messages ?? []).map((text) => ({ text: asyncIter([text]) }))),
    toolCalls: asyncIter(
      (spec.toolCalls ?? []).map((c) => ({
        name: c.name,
        input: c.input ?? {},
        status: Promise.resolve('finished' as const),
        output: Promise.resolve('ok'),
      })),
    ),
    subagents: asyncIter(
      (spec.subagents ?? []).map((s) => ({
        name: s.name,
        toolCalls: asyncIter((s.toolCalls ?? []).map((c) => ({ name: c.name, input: c.input ?? {} }))),
        messages: asyncIter([]),
        subagents: asyncIter([]),
      })),
    ),
  }
}

test('captureRun collects tool starts and final answer', async () => {
  const stream = v3Stream({
    messages: ['Hi ', 'there'],
    toolCalls: [{ name: 'search_instruments', input: { q: 'TCS' } }],
  })
  const cap = await captureRun(stream, { maxTurns: 8 })
  expect(cap.trajectory).toHaveLength(1)
  expect(cap.trajectory[0]).toMatchObject({ name: 'search_instruments', args: { q: 'TCS' }, scope: 'coordinator' })
  expect(cap.finalAnswer).toBe('Hi there')
  expect(cap.error).toBeUndefined()
})

test('captureRun stops at maxTurns', async () => {
  const ac = new AbortController()
  const stream = v3Stream({
    toolCalls: Array.from({ length: 20 }, () => ({ name: 'get_ltp', input: {} })),
  })
  const cap = await captureRun(stream, { maxTurns: 3, signal: ac.signal, abort: () => ac.abort() })
  expect(cap.trajectory).toHaveLength(3)
  expect(cap.trajectory.every((s) => s.scope === 'coordinator')).toBe(true)
  expect(cap.error).toBeUndefined()
})

test('captureRun swallows stream errors into error field', async () => {
  const stream = {
    messages: asyncIter([]),
    toolCalls: (async function* () {
      yield { name: 'x', input: {} }
      throw new Error('stream blew up')
    })(),
    subagents: asyncIter([]),
  }
  const cap = await captureRun(stream, { maxTurns: 8 })
  expect(cap.trajectory).toHaveLength(1)
  expect(cap.error).toBe('stream blew up')
})

// append to apps/deepagent/src/eval/run.test.ts
import { runSuite } from './run'
import type { EvalCase } from './types'

function fakeAgent(spec: Parameters<typeof v3Stream>[0]) {
  return {
    streamEvents: async () => v3Stream(spec),
  }
}

test('runSuite: grades a passing case via injected fake agent', async () => {
  const oneCase: EvalCase = {
    id: 't1',
    category: 'ir',
    prompt: 'hi',
    stubRoutes: [],
    assertions: [{ kind: 'calls', tool: 'search_instruments', min: 1 }],
  }
  const results = await runSuite({
    cfg: { provider: 'ollama', apiKey: '', baseUrl: '', model: 'x' },
    cases: [oneCase],
    buildAgentFn: async () => fakeAgent({
      messages: ['done'],
      toolCalls: [{ name: 'search_instruments', input: { q: 'TCS' } }],
    }),
  })
  expect(results).toHaveLength(1)
  expect(results[0].passed).toBe(true)
  expect(results[0].trajectory[0].name).toBe('search_instruments')
  expect(results[0].finalAnswer).toBe('done')
})

test('runSuite: a failing assertion makes the case fail', async () => {
  const oneCase: EvalCase = {
    id: 't2',
    category: 'ir',
    prompt: 'hi',
    stubRoutes: [],
    assertions: [{ kind: 'not_called', tool: 'get_ltp' }],
  }
  const results = await runSuite({
    cfg: { provider: 'ollama', apiKey: '', baseUrl: '', model: 'x' },
    cases: [oneCase],
    buildAgentFn: async () => fakeAgent({ toolCalls: [{ name: 'get_ltp', input: {} }] }),
  })
  expect(results[0].passed).toBe(false)
  expect(results[0].assertionResults[0].passed).toBe(false)
})

test('runSuite: categories filter applies', async () => {
  const a: EvalCase = { id: 'a', category: 'c1', prompt: 'p', stubRoutes: [], assertions: [] }
  const b: EvalCase = { id: 'b', category: 'c2', prompt: 'p', stubRoutes: [], assertions: [] }
  const results = await runSuite({
    cfg: { provider: 'ollama', apiKey: '', baseUrl: '', model: 'x' },
    cases: [a, b],
    categories: ['c1'],
    buildAgentFn: async () => fakeAgent({}),
  })
  expect(results.map((r) => r.caseId)).toEqual(['a'])
})

test('runSuite: restores env and cleans up after run (no leak)', async () => {
  const before = process.env.API_BASE_URL
  await runSuite({
    cfg: { provider: 'ollama', apiKey: '', baseUrl: '', model: 'x' },
    cases: [{ id: 'leak', category: 'x', prompt: 'p', stubRoutes: [], assertions: [] }],
    buildAgentFn: async () => fakeAgent({}),
  })
  expect(process.env.API_BASE_URL).toBe(before)
})

test('captureRun captures subagent-internal tool calls, scope-tagged', async () => {
  const stream = v3Stream({
    toolCalls: [{ name: 'task', input: { subagent_type: 'quant' } }],
    subagents: [
      {
        name: 'quant',
        toolCalls: [
          { name: 'historical_candles', input: { instrument_key: 'NSE_EQ|RELIANCE' } },
          { name: 'read_candles', input: {} },
        ],
      },
    ],
  })
  const cap = await captureRun(stream, { maxTurns: 8 })
  expect(cap.trajectory.map((s) => s.name)).toEqual(['task', 'historical_candles', 'read_candles'])
  expect(cap.trajectory[0].scope).toBe('coordinator')
  expect(cap.trajectory[1].scope).toBe('quant')
  expect(cap.trajectory[2].scope).toBe('quant')
  expect(cap.error).toBeUndefined()
})