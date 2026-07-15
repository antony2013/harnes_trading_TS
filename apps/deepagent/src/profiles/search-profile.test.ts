// apps/deepagent/src/profiles/search-profile.test.ts
import { test, expect } from 'bun:test'
import { resolveProfile, mergeProfiles, applySearchOverride } from './loader'
import { loadProfile } from './loader'
import { DEFAULT_PROFILE_DATA, SEARCH_SUBAGENT } from './defaults'

const searchSpec = { searxngBaseUrl: 'http://localhost:8080', crawl4aiBaseUrl: 'http://localhost:11235', maxResults: 5, crawlTimeoutMs: 60000 }

test('default profile unchanged: no search middleware, no search subagent, no search spec', () => {
  expect(DEFAULT_PROFILE_DATA.middleware).not.toContain('search')
  expect((DEFAULT_PROFILE_DATA as any).search).toBeUndefined()
  expect(DEFAULT_PROFILE_DATA.subagents.map((s) => s.name)).not.toContain('search')
})

test('validateMerged: rejects search in middleware when search spec is missing', () => {
  const bad = mergeProfiles(DEFAULT_PROFILE_DATA, { middleware: ['search'] })
  expect(() => resolveProfile(bad)).toThrow(/search/)
})

test('validateMerged: rejects search spec with missing fields', () => {
  const bad = mergeProfiles(DEFAULT_PROFILE_DATA, { middleware: ['search'], search: { searxngBaseUrl: 'x' } } as any)
  expect(() => resolveProfile(bad)).toThrow(/search/)
})

test('validateMerged: accepts a complete search spec', () => {
  expect(() => resolveProfile(mergeProfiles(DEFAULT_PROFILE_DATA, {
    middleware: [...DEFAULT_PROFILE_DATA.middleware, 'search'],
    search: searchSpec,
    subagents: [SEARCH_SUBAGENT],
  }))).not.toThrow()
})

const overrideOn = { enabled: true, ...searchSpec }
const overrideOff = { ...overrideOn, enabled: false }

test('applySearchOverride: enabled adds "search" middleware + spec + search subagent', () => {
  const base = loadProfile('ollama', 'llama3')
  expect(base.middleware).not.toContain('search')
  const merged = applySearchOverride(base, overrideOn)
  expect(merged.middleware).toContain('search')
  expect(merged.search).toEqual(searchSpec)
  expect(merged.subagents.map((s) => s.name)).toContain('search')
  expect(() => resolveProfile(merged)).not.toThrow()
})

test('applySearchOverride: enabled resolves the search subagent with 2 tools', () => {
  const merged = applySearchOverride(loadProfile('ollama', 'llama3'), overrideOn)
  const r = resolveProfile(merged)
  const searchSub = r.subagents.find((s) => s.name === 'search')!
  expect(searchSub.middleware).toHaveLength(1)
  expect((searchSub.middleware[0] as any).tools.map((t: any) => t.name).sort()).toEqual(['crawl_page', 'web_search'])
})

test('applySearchOverride: disabled removes "search" middleware + spec + subagent', () => {
  const withSearch = applySearchOverride(loadProfile('ollama', 'llama3'), overrideOn)
  const merged = applySearchOverride(withSearch, overrideOff)
  expect(merged.middleware).not.toContain('search')
  expect((merged as any).search).toBeUndefined()
  expect(merged.subagents.map((s) => s.name)).not.toContain('search')
  expect(() => resolveProfile(merged)).not.toThrow()
})

test('applySearchOverride: disabled on a profile without search is a no-op (same middleware + subagents)', () => {
  const base = loadProfile('ollama', 'llama3')
  const merged = applySearchOverride(base, overrideOff)
  expect(merged.middleware).toEqual(base.middleware)
  expect(merged.subagents.map((s) => s.name).sort()).toEqual(base.subagents.map((s) => s.name).sort())
})

test('applySearchOverride: enabled=true re-validates; default 3 parent middleware + search = 4', () => {
  const merged = applySearchOverride(loadProfile('ollama', 'llama3'), overrideOn)
  expect(resolveProfile(merged).parentMiddleware).toHaveLength(4)
})