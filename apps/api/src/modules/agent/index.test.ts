import { test, expect, beforeEach, mock } from 'bun:test'
import { writeSettings } from './settings'
import * as realDeepagent from '@harnesh-trading-ts/deepagent'

// Record what streamEvents receives so we can assert the route threaded workspace_id through.
let recordedConfigurable: any
let recordedOverride: any
let recordedSearchOverride: any

// Stub the deepagent package BEFORE ./index imports it. Spread the real namespace so the
// route's `workspaceDir(workspaceId)` call resolves to the REAL function (Task 9 export),
// while buildAgent/buildModel are overridden to a fake that records `configurable`.
// (Coordinator-authorized resolution: the brief's mock omitted workspaceDir, which the
// route calls before buildAgent — see task-10-report.md.)
mock.module('@harnesh-trading-ts/deepagent', () => ({
  ...realDeepagent,
  buildAgent: async (_cfg: any, osOverride: any, searchOverride: any) => {
    recordedOverride = osOverride
    recordedSearchOverride = searchOverride
    return {
      // Fake agent: record configurable, emit no events, let the route yield `done`.
      streamEvents: async function* (_input: any, opts: any) {
        recordedConfigurable = opts?.configurable
      },
    }
  },
  buildModel: () => ({}),
}))

// Import AFTER mock.module so the route picks up the stubbed buildAgent.
const { agent } = await import('./index')

beforeEach(() => {
  process.env.AGENT_SETTINGS_PATH = `/tmp/agent-settings-${Math.random().toString(36).slice(2)}.json`
  process.env.AGENT_OPENSHELL_SETTINGS_PATH = `/tmp/openshell-settings-${Math.random().toString(36).slice(2)}.json`
  process.env.AGENT_SEARCH_SETTINGS_PATH = `/tmp/search-settings-${Math.random().toString(36).slice(2)}.json`
  recordedConfigurable = undefined
  recordedOverride = undefined
  recordedSearchOverride = undefined
  // Configure the agent so readSettings() returns a valid model and the route proceeds to buildAgent.
  writeSettings({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '' })
})

test('POST /agent/chat passes body.workspaceId as configurable.workspace_id + emits workspace event', async () => {
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
  const text = await res.text()
  expect(recordedConfigurable).toEqual({ workspace_id: 'wA' })
  expect(text).toContain('event: workspace')
  expect(text).toContain('"id":"wA"')
})

test('POST /agent/chat generates a uuid workspace_id + emits a workspace SSE event when body omits workspaceId', async () => {
  const res = await agent.handle(
    new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
  )
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toContain('event: workspace')
  expect(recordedConfigurable).toBeDefined()
  expect(recordedConfigurable.workspace_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  // the emitted workspace event carries the same id used in configurable
  expect(text).toContain(`"id":"${recordedConfigurable.workspace_id}"`)
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

import { writeOpenShellSettings } from './openshell'

test('GET /agent/openshell: returns defaults when no file', async () => {
  const res = await agent.handle(new Request('http://localhost/agent/openshell'))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toEqual({
    enabled: false,
    image: 'harnesh/agent-sandbox:ubuntu-lts',
    idleTimeoutMs: 1_800_000,
    bridgePort: 7777,
    executionTimeoutMs: 120_000,
  })
})

test('PUT /agent/openshell: writes + GET returns saved values', async () => {
  const putRes = await agent.handle(
    new Request('http://localhost/agent/openshell', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        image: 'harnesh/agent-sandbox:ubuntu-lts',
        idleTimeoutMs: 900_000,
        bridgePort: 8000,
        executionTimeoutMs: 60_000,
      }),
    }),
  )
  expect(putRes.status).toBe(200)
  const getRes = await agent.handle(new Request('http://localhost/agent/openshell'))
  expect(await getRes.json()).toEqual({
    enabled: true,
    image: 'harnesh/agent-sandbox:ubuntu-lts',
    idleTimeoutMs: 900_000,
    bridgePort: 8000,
    executionTimeoutMs: 60_000,
  })
})

test('PUT /agent/openshell: 422 on bad payload (non-bool enabled)', async () => {
  const res = await agent.handle(
    new Request('http://localhost/agent/openshell', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes', image: 'x', idleTimeoutMs: 1, bridgePort: 1, executionTimeoutMs: 1 }),
    }),
  )
  expect(res.status).toBe(422)
})

test('PUT /agent/openshell: 422 on sub-minimum bridgePort', async () => {
  const res = await agent.handle(
    new Request('http://localhost/agent/openshell', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, image: 'x', idleTimeoutMs: 1, bridgePort: -1, executionTimeoutMs: 1 }),
    }),
  )
  expect(res.status).toBe(422)
})

test('POST /agent/openshell/test: returns 200 with {ok, detail} shape', async () => {
  writeOpenShellSettings({
    enabled: true,
    image: 'harnesh/agent-sandbox:ubuntu-lts',
    idleTimeoutMs: 1_800_000,
    bridgePort: 7777,
    executionTimeoutMs: 120_000,
  })
  const res = await agent.handle(new Request('http://localhost/agent/openshell/test', { method: 'POST' }))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(typeof body.ok).toBe('boolean')
  expect(typeof body.detail).toBe('string')
})

test('POST /agent/chat threads openshell override into buildAgent when settings are saved', async () => {
  writeOpenShellSettings({
    enabled: true,
    image: 'harnesh/agent-sandbox:ubuntu-lts',
    idleTimeoutMs: 900_000,
    bridgePort: 8000,
    executionTimeoutMs: 60_000,
  })
  const res = await agent.handle(
    new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
  )
  await res.text()
  expect(recordedOverride).toEqual({
    enabled: true,
    image: 'harnesh/agent-sandbox:ubuntu-lts',
    idleTimeoutMs: 900_000,
    bridgePort: 8000,
    executionTimeoutMs: 60_000,
  })
})

test('POST /agent/chat passes undefined override when no openshell settings saved', async () => {
  const res = await agent.handle(
    new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
  )
  await res.text()
  expect(recordedOverride).toBeUndefined()
})

import { writeSearchSettings, DEFAULT_SEARCH_SETTINGS } from './search'

test('GET /agent/search: returns defaults when no file', async () => {
  const res = await agent.handle(new Request('http://localhost/agent/search'))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual(DEFAULT_SEARCH_SETTINGS)
})

test('PUT /agent/search: writes + GET returns saved values', async () => {
  const putRes = await agent.handle(
    new Request('http://localhost/agent/search', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        searxngBaseUrl: 'http://localhost:8080',
        crawl4aiBaseUrl: 'http://localhost:11235',
        maxResults: 7,
        crawlTimeoutMs: 45_000,
      }),
    }),
  )
  expect(putRes.status).toBe(200)
  const getRes = await agent.handle(new Request('http://localhost/agent/search'))
  expect(await getRes.json()).toEqual({
    enabled: true,
    searxngBaseUrl: 'http://localhost:8080',
    crawl4aiBaseUrl: 'http://localhost:11235',
    maxResults: 7,
    crawlTimeoutMs: 45_000,
  })
})

test('PUT /agent/search: 422 on non-bool enabled', async () => {
  const res = await agent.handle(
    new Request('http://localhost/agent/search', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes', searxngBaseUrl: 'x', crawl4aiBaseUrl: 'y', maxResults: 1, crawlTimeoutMs: 1 }),
    }),
  )
  expect(res.status).toBe(422)
})

test('POST /agent/chat threads search override into buildAgent when settings enabled', async () => {
  writeSearchSettings({
    enabled: true,
    searxngBaseUrl: 'http://localhost:8080',
    crawl4aiBaseUrl: 'http://localhost:11235',
    maxResults: 5,
    crawlTimeoutMs: 60_000,
  })
  const res = await agent.handle(
    new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
  )
  await res.text()
  expect(recordedSearchOverride).toEqual({
    enabled: true,
    searxngBaseUrl: 'http://localhost:8080',
    crawl4aiBaseUrl: 'http://localhost:11235',
    maxResults: 5,
    crawlTimeoutMs: 60_000,
  })
})

test('POST /agent/chat passes undefined searchOverride when search disabled', async () => {
  writeSearchSettings({ ...DEFAULT_SEARCH_SETTINGS, enabled: false })
  const res = await agent.handle(
    new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
  )
  await res.text()
  expect(recordedSearchOverride).toBeUndefined()
})

test('POST /agent/chat passes undefined searchOverride when no search settings saved', async () => {
  const res = await agent.handle(
    new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
  )
  await res.text()
  expect(recordedSearchOverride).toBeUndefined()
})