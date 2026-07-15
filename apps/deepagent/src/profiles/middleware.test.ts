// apps/deepagent/src/profiles/middleware.test.ts
import { test, expect } from 'bun:test'
import { ToolMessage } from '@langchain/core/messages'
import { MIDDLEWARE_REGISTRY } from './middleware'
import { buildReadFileContinuationMiddleware } from './implementations'

const ctx = {
  ptcAllowlist: ['get_ltp'],
  interpreter: { executionTimeoutMs: 30000, subagents: true },
  parent: true,
  allTools: [],
}

test('registry: exactly interpreter + coerceToolContent + openshell + readFileContinuation + search', () => {
  expect(Object.keys(MIDDLEWARE_REGISTRY).sort()).toEqual(['coerceToolContent', 'interpreter', 'openshell', 'readFileContinuation', 'search'])
})

test('registry: search builds a middleware with 2 tools when ctx.search is a complete spec', () => {
  const mw: any = MIDDLEWARE_REGISTRY.search({
    ...ctx,
    search: { searxngBaseUrl: 'http://localhost:8080', crawl4aiBaseUrl: 'http://localhost:11235', maxResults: 5, crawlTimeoutMs: 60000 },
  })
  expect(mw).toBeTruthy()
  expect(mw.tools).toHaveLength(2)
  expect(mw.tools.map((t: any) => t.name).sort()).toEqual(['crawl_page', 'web_search'])
})

test('registry: search throws when ctx.search is missing/incomplete', () => {
  expect(() => MIDDLEWARE_REGISTRY.search({ ...ctx, search: undefined })).toThrow(/search/)
  expect(() => MIDDLEWARE_REGISTRY.search({ ...ctx, search: { searxngBaseUrl: 'x' } as any })).toThrow(/search/)
})

test('registry: interpreter builds a truthy middleware (parent)', () => {
  expect(MIDDLEWARE_REGISTRY.interpreter(ctx)).toBeTruthy()
})

test('registry: interpreter builds a truthy middleware (subagent)', () => {
  expect(MIDDLEWARE_REGISTRY.interpreter({ ...ctx, parent: false })).toBeTruthy()
})

test('registry: coerceToolContent + readFileContinuation build truthy', () => {
  expect(MIDDLEWARE_REGISTRY.coerceToolContent(ctx)).toBeTruthy()
  expect(MIDDLEWARE_REGISTRY.readFileContinuation(ctx)).toBeTruthy()
})

test('readFileContinuation: appends notice when read_file returns == limit line-numbered lines', async () => {
  const mw = buildReadFileContinuationMiddleware()
  const lines = Array.from({ length: 100 }, (_, i) => `${i + 1}\tline ${i + 1}`).join('\n')
  const handler = async () => new ToolMessage({ content: lines, tool_call_id: 'tc1', name: 'read_file' })
  const out: any = await mw.wrapToolCall({ toolCall: { name: 'read_file', args: { offset: 0, limit: 100 } } }, handler)
  expect(out.content).toContain('continues past this read window')
  expect(out.content).toContain('offset=100')
  expect(out.tool_call_id).toBe('tc1')
})