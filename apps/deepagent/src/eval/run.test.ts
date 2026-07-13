// apps/deepagent/src/eval/run.test.ts
import { test, expect } from 'bun:test'
import { captureRun } from './run'

async function* mockStream(events: any[]) {
  for (const e of events) yield e
}

test('captureRun collects tool starts and final answer', async () => {
  const events = [
    { event: 'on_chat_model_stream', data: { chunk: { content: 'Hi ' } } },
    { event: 'on_tool_start', name: 'search_instruments', data: { input: { q: 'TCS' } } },
    { event: 'on_chat_model_stream', data: { chunk: { content: 'there' } } },
  ]
  const cap = await captureRun(mockStream(events), { maxTurns: 8 })
  expect(cap.trajectory).toHaveLength(1)
  expect(cap.trajectory[0]).toMatchObject({ name: 'search_instruments', args: { q: 'TCS' } })
  expect(cap.finalAnswer).toBe('Hi there')
  expect(cap.error).toBeUndefined()
})

test('captureRun stops at maxTurns', async () => {
  const events = Array.from({ length: 20 }, () => ({ event: 'on_tool_start', name: 'get_ltp', data: { input: {} } }))
  const cap = await captureRun(mockStream(events), { maxTurns: 3 })
  expect(cap.trajectory).toHaveLength(3)
})

test('captureRun swallows stream errors into error field', async () => {
  async function* boom() {
    yield { event: 'on_tool_start', name: 'x', data: { input: {} } }
    throw new Error('stream blew up')
  }
  const cap = await captureRun(boom(), { maxTurns: 8 })
  expect(cap.trajectory).toHaveLength(1)
  expect(cap.error).toBe('stream blew up')
})

// append to apps/deepagent/src/eval/run.test.ts
import { runSuite } from './run'
import type { EvalCase } from './types'

function fakeAgent(events: any[]) {
  return {
    streamEvents: async function* () {
      for (const e of events) yield e
    },
  }
}

test('runSuite: grades a passing case via injected fake agent', async () => {
  const events = [
    { event: 'on_tool_start', name: 'search_instruments', data: { input: { q: 'TCS' } } },
    { event: 'on_chat_model_stream', data: { chunk: { content: 'done' } } },
  ]
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
    buildAgentFn: async () => fakeAgent(events),
  })
  expect(results).toHaveLength(1)
  expect(results[0].passed).toBe(true)
  expect(results[0].trajectory[0].name).toBe('search_instruments')
  expect(results[0].finalAnswer).toBe('done')
})

test('runSuite: a failing assertion makes the case fail', async () => {
  const events = [{ event: 'on_tool_start', name: 'get_ltp', data: { input: {} } }]
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
    buildAgentFn: async () => fakeAgent(events),
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
    buildAgentFn: async () => fakeAgent([]),
  })
  expect(results.map((r) => r.caseId)).toEqual(['a'])
})

test('runSuite: restores env and cleans up after run (no leak)', async () => {
  const before = process.env.API_BASE_URL
  await runSuite({
    cfg: { provider: 'ollama', apiKey: '', baseUrl: '', model: 'x' },
    cases: [{ id: 'leak', category: 'x', prompt: 'p', stubRoutes: [], assertions: [] }],
    buildAgentFn: async () => fakeAgent([]),
  })
  expect(process.env.API_BASE_URL).toBe(before)
})