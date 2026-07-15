import { test, expect, mock, beforeEach, afterEach } from 'bun:test'
import { get } from 'svelte/store'
import { searchSettings, loadSearch, saveSearch, testSearch, DEFAULT_SEARCH } from './agentSearch'

const fetchMock = mock((_url: string, init?: any) => {
  const method = init?.method ?? 'GET'
  if (method === 'PUT') return Promise.resolve(new Response('{}', { status: 200 }))
  if (method === 'POST') return Promise.resolve(new Response(JSON.stringify({ ok: true, detail: 'ok' }), { status: 200 }))
  return Promise.resolve(new Response(JSON.stringify(DEFAULT_SEARCH), { status: 200 }))
})

const realFetch = globalThis.fetch
beforeEach(() => { globalThis.fetch = fetchMock as any; fetchMock.mockClear() })
afterEach(() => { globalThis.fetch = realFetch })

test('DEFAULT_SEARCH: disabled with sane defaults', () => {
  expect(DEFAULT_SEARCH).toEqual({
    enabled: false,
    searxngBaseUrl: 'http://localhost:8080',
    crawl4aiBaseUrl: 'http://localhost:11235',
    maxResults: 5,
    crawlTimeoutMs: 60_000,
  })
})

test('loadSearch: GET /agent/search and sets the store', async () => {
  await loadSearch()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0][0]).toBe('/agent/search')
  expect(get(searchSettings)).toEqual(DEFAULT_SEARCH)
})

test('saveSearch: PUT /agent/search with the payload', async () => {
  await saveSearch(DEFAULT_SEARCH)
  const put = fetchMock.mock.calls.find((c) => (c[1] as any)?.method === 'PUT')
  expect(put).toBeTruthy()
  expect(put![0]).toBe('/agent/search')
  expect(JSON.parse((put![1] as any).body)).toEqual(DEFAULT_SEARCH)
})

test('testSearch: POST /agent/search/test', async () => {
  await testSearch()
  const post = fetchMock.mock.calls.find((c) => (c[1] as any)?.method === 'POST')
  expect(post).toBeTruthy()
  expect(post![0]).toBe('/agent/search/test')
})