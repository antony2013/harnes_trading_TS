// apps/deepagent/src/profiles/resolve.test.ts
import { test, expect } from 'bun:test'
import { DEFAULT_PROFILE_DATA } from './defaults'
import { resolveProfile, resolveTools } from './resolve'
import { allTools } from '../tools'

test('defaults: DEFAULT_PROFILE_DATA has profileVersion 1 + 10 ptc tools + 3 subagents', () => {
  expect(DEFAULT_PROFILE_DATA.profileVersion).toBe(1)
  expect(DEFAULT_PROFILE_DATA.ptcAllowlist).toHaveLength(10)
  expect(DEFAULT_PROFILE_DATA.ptcAllowlist).not.toContain('sync_candles')
  expect(DEFAULT_PROFILE_DATA.ptcAllowlist).not.toContain('call_api')
  expect(DEFAULT_PROFILE_DATA.subagents.map((s) => s.name).sort()).toEqual(['general-purpose', 'quant', 'reporter'])
})

test('resolveTools: readOnly = allTools filtered to ptcAllowlist', () => {
  const tools = resolveTools('readOnly', DEFAULT_PROFILE_DATA.ptcAllowlist) as any[]
  const names = tools.map((t) => t.name).sort()
  expect(names).toEqual([...DEFAULT_PROFILE_DATA.ptcAllowlist].sort())
  expect(names).not.toContain('sync_candles')
  expect(names).not.toContain('call_api')
})

test('resolveTools: all = allTools', () => {
  const tools = resolveTools('all', []) as any[]
  expect(tools.map((t) => t.name).sort()).toEqual(allTools.map((t: any) => t.name).sort())
})

test('resolveTools: none = []', () => {
  expect(resolveTools('none', [])).toEqual([])
})

test('resolveTools: explicit list resolves + fails on unknown', () => {
  const tools = resolveTools(['get_ltp', 'news'], DEFAULT_PROFILE_DATA.ptcAllowlist) as any[]
  expect(tools.map((t) => t.name).sort()).toEqual(['get_ltp', 'news'])
  expect(() => resolveTools(['nope'], DEFAULT_PROFILE_DATA.ptcAllowlist)).toThrow(/unknown tool: "nope"/)
})

test('resolveProfile: parent middleware built in order (3)', () => {
  const r = resolveProfile(DEFAULT_PROFILE_DATA)
  expect(r.parentMiddleware).toHaveLength(3)
  expect(r.parentMiddleware.every((m) => m)).toBe(true)
})

test('resolveProfile: 3 subagents resolved with tools + middleware', () => {
  const r = resolveProfile(DEFAULT_PROFILE_DATA)
  const byName = Object.fromEntries(r.subagents.map((s) => [s.name, s]))
  expect(byName['general-purpose'].tools.map((t: any) => t.name).sort()).toEqual([...DEFAULT_PROFILE_DATA.ptcAllowlist].sort())
  expect(byName['quant'].tools.map((t: any) => t.name).sort()).toEqual([...DEFAULT_PROFILE_DATA.ptcAllowlist].sort())
  expect(byName['reporter'].tools).toEqual([])
  expect(byName['quant'].middleware.length).toBeGreaterThan(0)
  expect(byName['general-purpose'].middleware).toEqual([])
  expect(byName['reporter'].middleware).toEqual([])
})

test('resolveProfile: ptcAllowlist + interpreter passed through', () => {
  const r = resolveProfile(DEFAULT_PROFILE_DATA)
  expect(r.ptcAllowlist).toEqual(DEFAULT_PROFILE_DATA.ptcAllowlist)
  expect(r.interpreter).toEqual(DEFAULT_PROFILE_DATA.interpreter)
  expect(r.profileVersion).toBe(1)
})

test('resolveProfile: search subagent resolves with the search middleware (2 tools)', () => {
  const profile = {
    ...DEFAULT_PROFILE_DATA,
    middleware: [...DEFAULT_PROFILE_DATA.middleware, 'search'],
    search: { searxngBaseUrl: 'http://localhost:8080', crawl4aiBaseUrl: 'http://localhost:11235', maxResults: 5, crawlTimeoutMs: 60000 },
    subagents: [...DEFAULT_PROFILE_DATA.subagents, {
      name: 'search', description: 'd', systemPrompt: 's', tools: 'none', middleware: ['search'],
    }],
  }
  const r = resolveProfile(profile)
  // parent middleware gains 'search' -> 4
  expect(r.parentMiddleware).toHaveLength(4)
  const searchSub = r.subagents.find((s) => s.name === 'search')!
  expect(searchSub).toBeTruthy()
  expect(searchSub.tools).toEqual([]) // tools:'none'
  expect(searchSub.middleware).toHaveLength(1)
  // the search middleware object exposes the 2 tools
  const mw: any = searchSub.middleware[0]
  expect(mw.tools.map((t: any) => t.name).sort()).toEqual(['crawl_page', 'web_search'])
})