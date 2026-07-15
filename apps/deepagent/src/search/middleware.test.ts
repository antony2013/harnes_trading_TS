import { test, expect, beforeAll, afterAll } from 'bun:test'
import { runWebSearch, runCrawlPage, buildSearchMiddleware } from './middleware'
import type { SearchSpec } from '../profiles/types'

// Minimal Bun.serve stubs for SearXNG and Crawl4AI (pattern from src/eval/stub-server.ts).
let searxngPort = 0
let crawlPort = 0
let searxngSrv: ReturnType<typeof Bun.serve> | undefined
let crawlSrv: ReturnType<typeof Bun.serve> | undefined

beforeAll(() => {
  searxngSrv = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/search') return new Response('not found', { status: 404 })
      return Response.json({
        results: [
          { title: 'TCS news', url: 'https://example.com/tcs', content: 'TCS announces results', engines: ['google'] },
          { title: 'Nifty view', url: 'https://example.com/nifty', content: 'Nifty closes up', engines: ['bing'] },
        ],
      })
    },
  })
  searxngPort = searxngSrv.port
  crawlSrv = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/crawl') return new Response('not found', { status: 404 })
      const body = await req.json()
      return Response.json([{ success: true, markdown: `# ${body.url}\nPage content here.`, html: '', cleaned_html: '', status_code: 200, error_message: null }])
    },
  })
  crawlPort = crawlSrv.port
})

afterAll(() => { searxngSrv?.stop(); crawlSrv?.stop() })

function spec(): SearchSpec {
  return {
    searxngBaseUrl: `http://localhost:${searxngPort}`,
    crawl4aiBaseUrl: `http://localhost:${crawlPort}`,
    maxResults: 2,
    crawlTimeoutMs: 5000,
  }
}

test('runWebSearch: parses SearXNG results, maps content->snippet, returns top maxResults', async () => {
  const out = await runWebSearch(spec(), 'tcs news')
  const parsed = JSON.parse(out)
  expect(Array.isArray(parsed)).toBe(true)
  expect(parsed).toHaveLength(2)
  expect(parsed[0]).toEqual({ title: 'TCS news', url: 'https://example.com/tcs', snippet: 'TCS announces results', engines: ['google'] })
  expect(parsed[1].snippet).toBe('Nifty closes up')
})

test('runWebSearch: respects maxResults cap', async () => {
  const s = { ...spec(), maxResults: 1 }
  const parsed = JSON.parse(await runWebSearch(s, 'tcs'))
  expect(parsed).toHaveLength(1)
})

test('runWebSearch: builds the /search URL with format=json + the query', async () => {
  let seenUrl = ''
  const srv = Bun.serve({
    port: 0,
    async fetch(req) { seenUrl = req.url; return Response.json({ results: [] }) },
  })
  const s = { ...spec(), searxngBaseUrl: `http://localhost:${srv.port}` }
  await runWebSearch(s, 'q with spaces')
  srv.stop()
  expect(seenUrl).toContain('/search?q=q+with+spaces')
  expect(seenUrl).toContain('format=json')
})

test('runWebSearch: never throws on fetch failure (unreachable host)', async () => {
  const s = { ...spec(), searxngBaseUrl: 'http://localhost:1' } // nothing listening
  const out = await runWebSearch(s, 'x')
  expect(JSON.parse(out).error).toMatch(/SearXNG not reachable/i)
})

test('runCrawlPage: POSTs to /crawl and returns markdown', async () => {
  const out = await runCrawlPage(spec(), 'https://example.com/article')
  expect(out).toContain('# https://example.com/article')
  expect(out).toContain('Page content here.')
})

test('runCrawlPage: rejects non-http(s) URLs with an error string (no throw)', async () => {
  const out = await runCrawlPage(spec(), 'file:///etc/passwd')
  expect(JSON.parse(out).error).toMatch(/http\(s\):\/\//i)
})

test('runCrawlPage: never throws on fetch failure', async () => {
  const s = { ...spec(), crawl4aiBaseUrl: 'http://localhost:1' }
  const out = await runCrawlPage(s, 'https://example.com/x')
  expect(JSON.parse(out).error).toMatch(/Crawl4AI not reachable/i)
})

test('runCrawlPage: truncates markdown over 20000 chars', async () => {
  const longMd = 'x'.repeat(30000)
  const srv = Bun.serve({
    port: 0,
    async fetch() { return Response.json([{ success: true, markdown: longMd, html: '', cleaned_html: '', status_code: 200, error_message: null }]) },
  })
  const s = { ...spec(), crawl4aiBaseUrl: `http://localhost:${srv.port}` }
  const out = await runCrawlPage(s, 'https://example.com/big')
  srv.stop()
  expect(out.length).toBeLessThanOrEqual(20000 + 50) // cap + truncation marker
  expect(out).toContain('[truncated]')
})

test('buildSearchMiddleware: returns middleware with 2 tools named web_search + crawl_page', () => {
  const mw: any = buildSearchMiddleware(spec())
  expect(mw.name).toBe('SearchMiddleware')
  expect(Array.isArray(mw.tools)).toBe(true)
  expect(mw.tools).toHaveLength(2)
  expect(mw.tools.map((t: any) => t.name).sort()).toEqual(['crawl_page', 'web_search'])
})