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