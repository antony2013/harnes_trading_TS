import { test, expect, beforeEach } from 'bun:test'
import { readSearchSettings, writeSearchSettings, DEFAULT_SEARCH_SETTINGS, testSearch } from './search'

beforeEach(() => {
  process.env.AGENT_SEARCH_SETTINGS_PATH = `/tmp/search-settings-${Math.random().toString(36).slice(2)}.json`
})

test('readSearchSettings: returns null when no file', () => {
  expect(readSearchSettings()).toBeNull()
})

test('DEFAULT_SEARCH_SETTINGS: disabled, sane defaults', () => {
  expect(DEFAULT_SEARCH_SETTINGS).toEqual({
    enabled: false,
    searxngBaseUrl: 'http://localhost:8080',
    crawl4aiBaseUrl: 'http://localhost:11235',
    maxResults: 5,
    crawlTimeoutMs: 60_000,
  })
})

test('writeSearchSettings + readSearchSettings: round-trip', () => {
  writeSearchSettings({
    enabled: true,
    searxngBaseUrl: 'http://localhost:9090',
    crawl4aiBaseUrl: 'http://localhost:11236',
    maxResults: 3,
    crawlTimeoutMs: 30_000,
  })
  expect(readSearchSettings()).toEqual({
    enabled: true,
    searxngBaseUrl: 'http://localhost:9090',
    crawl4aiBaseUrl: 'http://localhost:11236',
    maxResults: 3,
    crawlTimeoutMs: 30_000,
  })
})

test('readSearchSettings: returns null on malformed JSON', () => {
  const path = process.env.AGENT_SEARCH_SETTINGS_PATH!
  const { writeFileSync } = require('node:fs')
  writeFileSync(path, '{ not valid json')
  expect(readSearchSettings()).toBeNull()
})

test('readSearchSettings: returns null when required fields missing', () => {
  const path = process.env.AGENT_SEARCH_SETTINGS_PATH!
  const { writeFileSync } = require('node:fs')
  writeFileSync(path, JSON.stringify({ enabled: true, searxngBaseUrl: 'x' })) // missing fields
  expect(readSearchSettings()).toBeNull()
})

test('writeSearchSettings: atomic (no .tmp left behind)', () => {
  writeSearchSettings(DEFAULT_SEARCH_SETTINGS)
  const path = process.env.AGENT_SEARCH_SETTINGS_PATH!
  const { existsSync } = require('node:fs')
  expect(existsSync(path)).toBe(true)
  expect(existsSync(path + '.tmp')).toBe(false)
})

test('testSearch: ok when both services reachable', async () => {
  const sx = Bun.serve({ port: 0, async fetch(req) {
    const u = new URL(req.url)
    if (u.pathname !== '/search') return new Response('nf', { status: 404 })
    return Response.json({ results: [] })
  }})
  const c4 = Bun.serve({ port: 0, async fetch(req) {
    const u = new URL(req.url)
    if (u.pathname !== '/health') return new Response('nf', { status: 404 })
    return Response.json({ status: 'healthy' })
  }})
  try {
    const r = await testSearch({
      enabled: true,
      searxngBaseUrl: `http://localhost:${sx.port}`,
      crawl4aiBaseUrl: `http://localhost:${c4.port}`,
      maxResults: 5,
      crawlTimeoutMs: 60000,
    })
    expect(r.ok).toBe(true)
  } finally {
    sx.stop(); c4.stop()
  }
})

test('testSearch: not ok when Crawl4AI unreachable', async () => {
  const sx = Bun.serve({ port: 0, async fetch() { return Response.json({ results: [] }) } })
  try {
    const r = await testSearch({
      enabled: true,
      searxngBaseUrl: `http://localhost:${sx.port}`,
      crawl4aiBaseUrl: 'http://localhost:1',
      maxResults: 5,
      crawlTimeoutMs: 60000,
    })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/Crawl4AI/i)
  } finally {
    sx.stop()
  }
})