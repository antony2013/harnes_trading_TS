import { test, expect, beforeEach, mock } from 'bun:test'
import { writeSettings } from './settings'
import * as realDeepagent from '@harnesh-trading-ts/deepagent'

// Record what streamEvents receives so we can assert the route threaded workspace_id through.
let recordedConfigurable: any

// Stub the deepagent package BEFORE ./index imports it. Spread the real namespace so the
// route's `workspaceDir(workspaceId)` call resolves to the REAL function (Task 9 export),
// while buildAgent/buildModel are overridden to a fake that records `configurable`.
// (Coordinator-authorized resolution: the brief's mock omitted workspaceDir, which the
// route calls before buildAgent — see task-10-report.md.)
mock.module('@harnesh-trading-ts/deepagent', () => ({
  ...realDeepagent,
  buildAgent: async () => ({
    // Fake agent: record configurable, emit no events, let the route yield `done`.
    streamEvents: async function* (_input: any, opts: any) {
      recordedConfigurable = opts?.configurable
    },
  }),
  buildModel: () => ({}),
}))

// Import AFTER mock.module so the route picks up the stubbed buildAgent.
const { agent } = await import('./index')

beforeEach(() => {
  process.env.AGENT_SETTINGS_PATH = `/tmp/agent-settings-${Math.random().toString(36).slice(2)}.json`
  recordedConfigurable = undefined
  // Configure the agent so readSettings() returns a valid model and the route proceeds to buildAgent.
  writeSettings({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '' })
})

test('POST /agent/chat passes body.workspaceId as configurable.workspace_id to streamEvents', async () => {
  const res = await agent.handle(
    new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'wA',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }),
  )
  expect(res.status).toBe(200)
  // Drain the SSE stream so the handler runs to completion (the stub yields nothing; route then yields `done`).
  await res.text()
  expect(recordedConfigurable).toEqual({ workspace_id: 'wA' })
})

test('POST /agent/chat defaults workspace_id to __default__ when body omits workspaceId', async () => {
  const res = await agent.handle(
    new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
  )
  expect(res.status).toBe(200)
  await res.text()
  expect(recordedConfigurable).toEqual({ workspace_id: '__default__' })
})

test('POST /agent/chat rejects a path-traversing workspaceId with 422 (schema guard)', async () => {
  const res = await agent.handle(
    new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: '../../etc/x',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }),
  )
  // Elysia validates the body against the RegExp BEFORE the handler runs; a
  // non-matching workspaceId yields 422 (not 200, and never reaches mkdirSync).
  expect(res.status).toBe(422)
  await res.text()
  expect(recordedConfigurable).toBeUndefined()
})