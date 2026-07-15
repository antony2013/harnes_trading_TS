# Search Agent (SearXNG + Crawl4AI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `search` subagent to the deepagent harness that searches the web via SearXNG (`:8080`) and reads pages via Crawl4AI (`:11235`), wired through the same settings pipeline as OpenShell.

**Architecture:** A `search` middleware (entry in `MIDDLEWARE_REGISTRY`) builds `web_search` + `crawl_page` tools from a `SearchSpec` baked in from the profile, and returns `{ name, tools }` — the exact pattern OpenShell uses to deliver its `shell` tool. A `search` subagent references `"search"` in its `middleware` array, so it gets both tools. `applySearchOverride` toggles `'search'` middleware membership + sets `SearchSpec` + splices in the `search` subagent. Config flows from `apps/api` settings JSON → override → profile → middleware builder; no global state, no env reads inside the tools.

**Tech Stack:** Bun 1.3.14 + TypeScript (strict, ESNext), LangChain v1 (`@langchain/core/tools`, `@langchain/core/multi_agent`), zod v4, Elysia (api), SvelteKit + Svelte 5 (web), `bun:test`.

## Global Constraints

- Tools **never throw** — they return `JSON.stringify({ error })` strings, same contract as `src/tools/http.ts` `apiCall`.
- HTTP base URLs are **baked into the tools via `SearchSpec`**, never read from env inside the tools.
- Search is **off by default**: `DEFAULT_PROFILE_DATA` and `profiles/default.jsonc` get NO `search` middleware/subagent/spec (keeps `loader.test.ts` baseline + `agent.test.ts` default-profile tests green).
- Follow existing file patterns exactly: `tool()` + `zod` for tools (see `src/openshell/middleware.ts`), `bun:test` co-located `*.test.ts`, atomic JSON settings writes (see `apps/api/src/modules/agent/openshell.ts`).
- Use `bun add` for any new dependency (never hand-edit package.json). This plan adds **no** new dependencies — everything needed (`@langchain/core`, `zod`, `elysia`, `svelte`) is already present.
- Run tests from the relevant workspace: `cd apps/deepagent && bun test <path>` (or `cd apps/api` / `cd apps/web`). The repo has no `test` script; use `bun test` directly.
- Commit after each task. Branch from `main` first if not already on a feature branch.

## File Structure

**`apps/deepagent` (library):**
- `src/profiles/types.ts` (modify) — add `SearchSpec`, `SearchOverride`, `ProfileData.search`.
- `src/profiles/defaults.ts` (modify) — export `SEARCH_SUBAGENT` constant.
- `src/search/middleware.ts` (create) — `runWebSearch`, `runCrawlPage` pure helpers + `buildSearchMiddleware`.
- `src/search/middleware.test.ts` (create) — stub-server tests for the helpers + middleware shape.
- `src/profiles/middleware.ts` (modify) — `MwCtx.search` + `search` registry entry.
- `src/profiles/middleware.test.ts` (modify) — add `'search'` to the registry-keys assertion.
- `src/profiles/resolve.ts` (modify) — thread `search` spec into both contexts.
- `src/profiles/loader.ts` (modify) — `validateMerged` search check + `applySearchOverride`; import `SEARCH_SUBAGENT`.
- `src/profiles/schema.json` (modify) — add `search` object property.
- `src/profiles/openshell-profile.test.ts` (modify, append) — add `applySearchOverride` tests (new file `search-profile.test.ts` is also acceptable; this plan appends to keep it simple — see Task 5).
- `src/profiles/index.ts` (modify) — export `applySearchOverride`.
- `src/agent.ts` (modify) — third `searchOverride` param + re-exports.
- `src/agent.test.ts` (modify, append) — `buildAgent` search-override test.
- `.env.example` (modify) — document `SEARXNG_BASE_URL` / `CRAWL4AI_BASE_URL`.

**`apps/api` (Elysia):**
- `src/modules/agent/search.ts` (create) — `SearchSettings` settings module + `testSearch`.
- `src/modules/agent/search.test.ts` (create) — settings round-trip tests.
- `src/modules/agent/index.ts` (modify) — `/agent/search` routes + chat-handler wiring.
- `src/modules/agent/index.test.ts` (modify) — extend mock to capture 3rd arg + add search route/override tests.

**`apps/web` (SvelteKit):**
- `src/lib/stores/agentSearch.ts` (create) — settings store + load/save/test.
- `src/lib/stores/agentSearch.test.ts` (create) — store fetch tests.
- `src/lib/components/agent/SearchForm.svelte` (create) — settings form (mirror `OpenShellForm.svelte`).
- `src/routes/settings/+page.svelte` (modify) — mount the form + load on init.

**Docs:**
- `docs/search-setup.md` (create) — Crawl4AI Docker setup.

---

## Task 1: Types, SEARCH_SUBAGENT, and ProfileData.search

**Files:**
- Modify: `apps/deepagent/src/profiles/types.ts`
- Modify: `apps/deepagent/src/profiles/defaults.ts`
- Test: `apps/deepagent/src/profiles/resolve.test.ts` (existing, unchanged — confirms default still has 3 subagents)

**Interfaces:**
- Produces: `SearchSpec`, `SearchOverride` (types), `SEARCH_SUBAGENT: SubagentSpec` (constant), `ProfileData.search?: SearchSpec`. Consumed by Tasks 2–6.

- [ ] **Step 1: Add the types to `types.ts`**

In `apps/deepagent/src/profiles/types.ts`, add after the `OpenShellOverride` interface (after line 28) and add `search?` to `ProfileData`. Insert these two interfaces:

```ts
/** Search subagent spec. Present only when `middleware` includes 'search'. */
export interface SearchSpec {
  searxngBaseUrl: string
  crawl4aiBaseUrl: string
  maxResults: number
  crawlTimeoutMs: number
}

/** API-supplied override applied on top of the auto-selected profile.
 *  `enabled` toggles "search" membership in the middleware array + splices in
 *  the `search` subagent; the four spec fields populate SearchSpec. */
export interface SearchOverride {
  enabled: boolean
  searxngBaseUrl: string
  crawl4aiBaseUrl: string
  maxResults: number
  crawlTimeoutMs: number
}
```

Then edit the `ProfileData` interface to add the optional `search` field. Change:

```ts
  openshell?: OpenShellSpec  // present only when middleware includes 'openshell'
}
```

to:

```ts
  openshell?: OpenShellSpec  // present only when middleware includes 'openshell'
  search?: SearchSpec        // present only when middleware includes 'search'
}
```

- [ ] **Step 2: Add `SEARCH_SUBAGENT` to `defaults.ts`**

In `apps/deepagent/src/profiles/defaults.ts`, add the import of `SubagentSpec` (the file currently imports only `ProfileData`). Change line 2:

```ts
import type { ProfileData } from './types'
```

to:

```ts
import type { ProfileData, SubagentSpec } from './types'
```

Then, after the `DEFAULT_PROFILE_DATA` export block (after the closing `}` of the constant, at the end of the file), append:

```ts

/** The search subagent, spliced into a profile by applySearchOverride when
 *  enabled. NOT part of DEFAULT_PROFILE_DATA — search is opt-in (off by default),
 *  mirroring OpenShell. tools:'none' because web_search/crawl_page are delivered
 *  via the 'search' middleware, not the static allTools registry. */
export const SEARCH_SUBAGENT: SubagentSpec = {
  name: 'search',
  description:
    'Search the public web (SearXNG) and read page content (Crawl4AI) for news, announcements, docs, or any topic the other tools cannot answer.',
  systemPrompt:
    'You are a web research subagent. Use web_search to find sources, then crawl_page on the 1-2 most relevant URLs to read their content. Return a concise synthesized answer with source URLs as citations. Prefer recent results. Do not write files.',
  tools: 'none',
  middleware: ['search'],
}
```

Do **not** add `SEARCH_SUBAGENT` to `DEFAULT_PROFILE_DATA.subagents` — search is opt-in.

- [ ] **Step 3: Run the existing profile tests to confirm no regression**

Run: `cd apps/deepagent && bun test src/profiles/resolve.test.ts src/profiles/loader.test.ts`
Expected: PASS. `DEFAULT_PROFILE_DATA` is unchanged, so `resolve.test.ts` (3 subagents) and `loader.test.ts` (default.jsonc == DEFAULT_PROFILE_DATA) stay green. `tsc` may complain that `SearchSpec` is unused — that's fine, it's used in later tasks.

- [ ] **Step 4: Commit**

```bash
cd apps/deepagent
git add src/profiles/types.ts src/profiles/defaults.ts
git commit -m "feat(search): add SearchSpec/SearchOverride types + SEARCH_SUBAGENT constant"
```

---

## Task 2: buildSearchMiddleware (web_search + crawl_page) with tests

**Files:**
- Create: `apps/deepagent/src/search/middleware.ts`
- Create: `apps/deepagent/src/search/middleware.test.ts`

**Interfaces:**
- Consumes: `SearchSpec` from `./profiles/types` (Task 1).
- Produces:
  - `runWebSearch(spec: SearchSpec, query: string): Promise<string>` — pure helper.
  - `runCrawlPage(spec: SearchSpec, url: string): Promise<string>` — pure helper.
  - `buildSearchMiddleware(spec: SearchSpec): AgentMiddleware` — returns `{ name: 'SearchMiddleware', tools: [webSearch, crawlPage] }`.
- Both helpers return stringified JSON; never throw. `web_search` returns top `spec.maxResults` results as `[{title,url,snippet,engines}]`. `crawl_page` returns cleaned markdown (truncated to 20000 chars).

- [ ] **Step 1: Write the failing test**

Create `apps/deepagent/src/search/middleware.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/deepagent && bun test src/search/middleware.test.ts`
Expected: FAIL — `Cannot find module './middleware'` (file not created yet).

- [ ] **Step 3: Write the implementation**

Create `apps/deepagent/src/search/middleware.ts`:

```ts
// apps/deepagent/src/search/middleware.ts
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { AgentMiddleware } from '@langchain/core/multi_agent'
import type { SearchSpec } from '../profiles/types'

const SEARXNG_TIMEOUT_MS = 15_000
const CRAWL_MAX_CHARS = 20_000

function tryParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

/** Strip a trailing slash from a base URL. */
function base(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Search SearXNG and return top N results as a JSON string of
 *  [{ title, url, snippet, engines }]. Never throws. */
export async function runWebSearch(spec: SearchSpec, query: string): Promise<string> {
  const url = new URL(base(spec.searxngBaseUrl) + '/search')
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('safesearch', '1')
  url.searchParams.set('pageno', '1')
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(SEARXNG_TIMEOUT_MS) })
    const text = await res.text()
    if (!res.ok) return JSON.stringify({ status: res.status, error: tryParse(text) ?? text })
    const body = tryParse(text) as { results?: any[] } | null
    const results = Array.isArray(body?.results) ? body!.results : []
    const top = results.slice(0, spec.maxResults).map((r: any) => ({
      title: String(r?.title ?? ''),
      url: String(r?.url ?? ''),
      snippet: String(r?.content ?? ''),
      engines: Array.isArray(r?.engines) ? r.engines : [],
    }))
    return JSON.stringify(top)
  } catch (err: any) {
    return JSON.stringify({
      error: `SearXNG not reachable at ${spec.searxngBaseUrl} — is it running? (${err?.message ?? String(err)})`,
    })
  }
}

/** Extract markdown from a Crawl4AI /crawl response (shape varies by version:
 *  array of {markdown}, or {result:{markdown}}, or {data:{markdown|content}}). */
function extractMarkdown(body: any): string {
  if (Array.isArray(body)) body = body[0]
  if (body?.success === false) {
    const msg = body?.error_message || body?.error || 'crawl failed'
    throw new Error(String(msg))
  }
  if (typeof body?.result?.markdown === 'string') return body.result.markdown
  if (typeof body?.data?.markdown === 'string') return body.data.markdown
  if (typeof body?.data?.content === 'string') return body.data.content
  if (typeof body?.markdown === 'string') return body.markdown
  return JSON.stringify(body)
}

/** Crawl a single URL via Crawl4AI and return its cleaned markdown (truncated
 *  to CRAWL_MAX_CHARS). Never throws. */
export async function runCrawlPage(spec: SearchSpec, url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    return JSON.stringify({ error: 'url must be an http(s):// URL' })
  }
  try {
    const res = await fetch(base(spec.crawl4aiBaseUrl) + '/crawl', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url,
        browser_config: { headless: true },
        crawler_config: { cache_mode: 'BYPASS' },
      }),
      signal: AbortSignal.timeout(spec.crawlTimeoutMs),
    })
    const text = await res.text()
    if (!res.ok) return JSON.stringify({ status: res.status, error: tryParse(text) ?? text })
    let md: string
    try {
      md = extractMarkdown(tryParse(text))
    } catch (extractErr: any) {
      return JSON.stringify({ error: `Crawl4AI returned an error for ${url}: ${extractErr?.message ?? extractErr}` })
    }
    if (md.length > CRAWL_MAX_CHARS) md = md.slice(0, CRAWL_MAX_CHARS) + '\n\n…[truncated]'
    return md
  } catch (err: any) {
    return JSON.stringify({
      error: `Crawl4AI not reachable at ${spec.crawl4aiBaseUrl} — is it running? (${err?.message ?? String(err)})`,
    })
  }
}

/** Build the 'search' middleware: web_search + crawl_page tools with `spec`
 *  baked in. Mirrors buildOpenShellMiddleware's shape ({ name, tools }). */
export function buildSearchMiddleware(spec: SearchSpec): AgentMiddleware {
  const webSearch = tool(
    async ({ query }) => runWebSearch(spec, query),
    {
      name: 'web_search',
      description:
        'Search the public web via SearXNG. Returns the top results as JSON: [{ title, url, snippet, engines }]. Use this to find sources, then crawl_page on the most relevant URL(s) to read their full content.',
      schema: z.object({
        query: z.string().min(1).describe('The search query, e.g. "TCS Q4 results 2026"'),
      }),
    },
  )
  const crawlPage = tool(
    async ({ url }) => runCrawlPage(spec, url),
    {
      name: 'crawl_page',
      description:
        'Fetch a single web page URL via Crawl4AI and return its cleaned markdown content (truncated). Use this to read the full content of a URL found via web_search. The URL must be http(s)://.',
      schema: z.object({
        url: z.string().min(1).describe('The full http(s):// URL to crawl'),
      }),
    },
  )
  const mw: AgentMiddleware = {
    name: 'SearchMiddleware', // unique — must not collide with other middleware
    tools: [webSearch, crawlPage],
  }
  return mw
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/deepagent && bun test src/search/middleware.test.ts`
Expected: PASS (all 10 tests).

- [ ] **Step 5: Commit**

```bash
cd apps/deepagent
git add src/search/middleware.ts src/search/middleware.test.ts
git commit -m "feat(search): buildSearchMiddleware with web_search + crawl_page tools"
```

---

## Task 3: Register 'search' in MIDDLEWARE_REGISTRY + MwCtx.search

**Files:**
- Modify: `apps/deepagent/src/profiles/middleware.ts`
- Modify: `apps/deepagent/src/profiles/middleware.test.ts`

**Interfaces:**
- Consumes: `buildSearchMiddleware` from `../search/middleware` (Task 2), `SearchSpec` from `./types` (Task 1).
- Produces: `MIDDLEWARE_REGISTRY.search` builder; `MwCtx.search?: SearchSpec`.

- [ ] **Step 1: Write the failing test (extend the registry-keys assertion)**

In `apps/deepagent/src/profiles/middleware.test.ts`, update the existing registry-keys test (line 14–16). Change:

```ts
test('registry: exactly interpreter + coerceToolContent + readFileContinuation', () => {
  expect(Object.keys(MIDDLEWARE_REGISTRY).sort()).toEqual(['coerceToolContent', 'interpreter', 'openshell', 'readFileContinuation'])
})
```

to:

```ts
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
```

(The `ctx` object at the top of the file lacks a `search` field — that's fine; spreading `...ctx` and adding `search` is the intended shape.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/deepagent && bun test src/profiles/middleware.test.ts`
Expected: FAIL — `Object.keys(MIDDLEWARE_REGISTRY)` does not include `search`, and `MIDDLEWARE_REGISTRY.search` is undefined.

- [ ] **Step 3: Write the implementation**

In `apps/deepagent/src/profiles/middleware.ts`:

Update the import from `./types` (line 2) to include `SearchSpec`:

```ts
import type { InterpreterSpec, OpenShellSpec, SearchSpec } from './types'
```

Add the `buildSearchMiddleware` import next to the openshell import (after line 8):

```ts
import { buildSearchMiddleware } from '../search/middleware'
```

Add `search?: SearchSpec` to `MwCtx` (after the `openshell?` field, line 14):

```ts
  openshell?: OpenShellSpec   // present only when middleware includes 'openshell'
  search?: SearchSpec         // present only when middleware includes 'search'
  allTools: unknown[]         // the real Tool objects (for the bridge)
```

Add the `search` builder to `MIDDLEWARE_REGISTRY` (after the `openshell` entry, before the closing `}`):

```ts
  search: (ctx) => {
    const s = ctx.search
    if (!s || typeof s.searxngBaseUrl !== 'string' || typeof s.crawl4aiBaseUrl !== 'string' ||
        typeof s.maxResults !== 'number' || typeof s.crawlTimeoutMs !== 'number') {
      throw new Error('search middleware selected but profile has no complete search spec (searxngBaseUrl/crawl4aiBaseUrl/maxResults/crawlTimeoutMs)')
    }
    return buildSearchMiddleware(s)
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/deepagent && bun test src/profiles/middleware.test.ts`
Expected: PASS (all tests, including the 3 new ones).

- [ ] **Step 5: Commit**

```bash
cd apps/deepagent
git add src/profiles/middleware.ts src/profiles/middleware.test.ts
git commit -m "feat(search): register 'search' middleware + thread SearchSpec into MwCtx"
```

---

## Task 4: Thread search spec through resolve.ts

**Files:**
- Modify: `apps/deepagent/src/profiles/resolve.ts`
- Test: `apps/deepagent/src/profiles/resolve.test.ts` (extend)

**Interfaces:**
- Consumes: `ProfileData.search` (Task 1), `MIDDLEWARE_REGISTRY.search` (Task 3).
- Produces: `resolveProfile` builds the `search` middleware for the parent and for any subagent whose `middleware` includes `'search'`.

- [ ] **Step 1: Write the failing test**

Append to `apps/deepagent/src/profiles/resolve.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/deepagent && bun test src/profiles/resolve.test.ts`
Expected: FAIL — `searchSub.middleware[0]` is built without a `search` spec on the context, so the registry builder throws (or the test fails because `ctx.search` is undefined).

- [ ] **Step 3: Write the implementation**

In `apps/deepagent/src/profiles/resolve.ts`, thread `search` into both contexts. Change the `resolveProfile` body.

Replace lines 23–25 (the `openshell` + `parentCtx` block):

```ts
  const openshell = data.middleware.includes('openshell') ? data.openshell : undefined
  const parentCtx: MwCtx = { ptcAllowlist: data.ptcAllowlist, interpreter: data.interpreter, parent: true, openshell, allTools }
```

with:

```ts
  const openshell = data.middleware.includes('openshell') ? data.openshell : undefined
  const search = data.middleware.includes('search') ? data.search : undefined
  const parentCtx: MwCtx = { ptcAllowlist: data.ptcAllowlist, interpreter: data.interpreter, parent: true, openshell, search, allTools }
```

And in the subagent loop, replace the `subOpenshell` + `subCtx` block (lines 32–33):

```ts
    const subOpenshell = s.middleware.includes('openshell') ? data.openshell : undefined
    const subCtx: MwCtx = { ptcAllowlist: data.ptcAllowlist, interpreter: data.interpreter, parent: false, openshell: subOpenshell, allTools }
```

with:

```ts
    const subOpenshell = s.middleware.includes('openshell') ? data.openshell : undefined
    const subSearch = s.middleware.includes('search') ? data.search : undefined
    const subCtx: MwCtx = { ptcAllowlist: data.ptcAllowlist, interpreter: data.interpreter, parent: false, openshell: subOpenshell, search: subSearch, allTools }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/deepagent && bun test src/profiles/resolve.test.ts`
Expected: PASS (all tests, including the new one).

- [ ] **Step 5: Commit**

```bash
cd apps/deepagent
git add src/profiles/resolve.ts src/profiles/resolve.test.ts
git commit -m "feat(search): thread SearchSpec through resolveProfile for parent + subagents"
```

---

## Task 5: validateMerged search check + applySearchOverride + schema + barrel export

**Files:**
- Modify: `apps/deepagent/src/profiles/loader.ts`
- Modify: `apps/deepagent/src/profiles/schema.json`
- Modify: `apps/deepagent/src/profiles/index.ts`
- Create: `apps/deepagent/src/profiles/search-profile.test.ts`

**Interfaces:**
- Consumes: `SEARCH_SUBAGENT` from `./defaults` (Task 1), `SearchSpec`/`SearchOverride` from `./types` (Task 1), `validateMerged` (internal), `mergeProfiles` (internal).
- Produces:
  - `applySearchOverride(profile: ProfileData, override: SearchOverride): ProfileData` (exported via `./loader` and `./profiles` barrel).
  - `validateMerged` rejects `middleware` including `'search'` without a complete `SearchSpec`.
  - `schema.json` accepts a `search` object property.

- [ ] **Step 1: Write the failing test**

Create `apps/deepagent/src/profiles/search-profile.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/deepagent && bun test src/profiles/search-profile.test.ts`
Expected: FAIL — `applySearchOverride` is not exported.

- [ ] **Step 3: Add the schema property**

In `apps/deepagent/src/profiles/schema.json`, add a `search` property next to the `openshell` property (after the `openshell` block, before `subagents`). Insert:

```json
    "search": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "searxngBaseUrl": { "type": "string" },
        "crawl4aiBaseUrl": { "type": "string" },
        "maxResults": { "type": "integer", "minimum": 1 },
        "crawlTimeoutMs": { "type": "integer", "minimum": 1 }
      },
      "required": ["searxngBaseUrl", "crawl4aiBaseUrl", "maxResults", "crawlTimeoutMs"]
    },
```

- [ ] **Step 4: Add `validateMerged` check + `applySearchOverride` in loader.ts**

In `apps/deepagent/src/profiles/loader.ts`:

Update the import from `./types` (line 7) to include `SearchSpec, SearchOverride`:

```ts
import type { ProfileData, SubagentSpec, OpenShellOverride, SearchSpec, SearchOverride } from './types'
```

Update the import from `./defaults` (line 8) to also import `SEARCH_SUBAGENT`:

```ts
import { DEFAULT_PROFILE_DATA, SEARCH_SUBAGENT } from './defaults'
```

In `validateMerged`, after the openshell check block (after line 86, the closing `}` of the `if (d.middleware.includes('openshell'))` block), add the search check:

```ts
  if (d.middleware.includes('search')) {
    const s = (d as any).search
    if (!s || typeof s.searxngBaseUrl !== 'string' || typeof s.crawl4aiBaseUrl !== 'string' ||
        typeof s.maxResults !== 'number' || typeof s.crawlTimeoutMs !== 'number') {
      throw new Error('profile missing complete search spec (searxngBaseUrl/crawl4aiBaseUrl/maxResults/crawlTimeoutMs)')
    }
  }
```

At the end of the file (after `applyOpenShellOverride`), add `applySearchOverride`:

```ts
/** Apply an API-supplied search override on top of a validated profile, then
 *  re-validate. enabled=true adds the 'search' middleware, the SearchSpec, and
 *  splices in the SEARCH_SUBAGENT; enabled=false strips all three. `enabled` is
 *  never written into SearchSpec (the spec has no enabled field). */
export function applySearchOverride(profile: ProfileData, override: SearchOverride): ProfileData {
  if (override.enabled) {
    const middleware = profile.middleware.includes('search')
      ? profile.middleware
      : [...profile.middleware, 'search']
    const hasSub = profile.subagents.some((s) => s.name === 'search')
    const subagents = hasSub ? profile.subagents : [...profile.subagents, { ...SEARCH_SUBAGENT }]
    return validateMerged({
      ...profile,
      middleware,
      subagents,
      search: {
        searxngBaseUrl: override.searxngBaseUrl,
        crawl4aiBaseUrl: override.crawl4aiBaseUrl,
        maxResults: override.maxResults,
        crawlTimeoutMs: override.crawlTimeoutMs,
      },
    })
  }
  // disabled: strip 'search' middleware, drop the spec, remove the search subagent.
  const middleware = profile.middleware.filter((m) => m !== 'search')
  const subagents = profile.subagents.filter((s) => s.name !== 'search')
  const wasPresent =
    middleware.length !== profile.middleware.length ||
    subagents.length !== profile.subagents.length ||
    (profile as any).search !== undefined
  if (!wasPresent) return profile
  const next: ProfileData = { ...profile, middleware, subagents }
  delete (next as any).search
  return validateMerged(next)
}
```

- [ ] **Step 5: Export from the barrel**

In `apps/deepagent/src/profiles/index.ts`, change the last line (line 10):

```ts
export { loadProfile, mergeProfiles, applyOpenShellOverride, ProfileSchemaError, ProfileVersionError } from './loader'
```

to:

```ts
export { loadProfile, mergeProfiles, applyOpenShellOverride, applySearchOverride, ProfileSchemaError, ProfileVersionError } from './loader'
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/deepagent && bun test src/profiles/search-profile.test.ts`
Expected: PASS (all 10 tests).

- [ ] **Step 7: Run the full profiles suite to confirm no regression**

Run: `cd apps/deepagent && bun test src/profiles/`
Expected: PASS (loader baseline, resolve, middleware, schema, openshell-profile, blocks all green).

- [ ] **Step 8: Commit**

```bash
cd apps/deepagent
git add src/profiles/loader.ts src/profiles/schema.json src/profiles/index.ts src/profiles/search-profile.test.ts
git commit -m "feat(search): applySearchOverride + validateMerged search check + schema + barrel export"
```

---

## Task 6: buildAgent third override param + re-exports

**Files:**
- Modify: `apps/deepagent/src/agent.ts`
- Modify: `apps/deepagent/src/agent.test.ts` (append)

**Interfaces:**
- Consumes: `applySearchOverride` from `./profiles` (Task 5), `SearchOverride` from `./profiles/types` (Task 1).
- Produces: `buildAgent(cfg, openshellOverride?, searchOverride?)`; re-exports `SearchOverride` + `applySearchOverride`.

- [ ] **Step 1: Write the failing test**

Append to `apps/deepagent/src/agent.test.ts`:

```ts
test('buildAgent: searchOverride enabled builds an agent with the search subagent (no throw)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'da-')) + '/search-on'
  process.env.AGENT_WORKSPACE_DIR = root
  const agent = await buildAgent(
    { provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama3' },
    undefined,
    { enabled: true, searxngBaseUrl: 'http://localhost:8080', crawl4aiBaseUrl: 'http://localhost:11235', maxResults: 5, crawlTimeoutMs: 60000 },
  )
  expect(agent).toBeTruthy()
  expect(existsSync(root)).toBe(true)
})

test('buildAgent: openshell + search overrides together build without throwing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'da-')) + '/os-search'
  process.env.AGENT_WORKSPACE_DIR = root
  const agent = await buildAgent(
    { provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama3' },
    { enabled: true, image: 'harnesh/agent-sandbox:ubuntu-lts', idleTimeoutMs: 1_800_000, bridgePort: 7777, executionTimeoutMs: 120_000 },
    { enabled: true, searxngBaseUrl: 'http://localhost:8080', crawl4aiBaseUrl: 'http://localhost:11235', maxResults: 5, crawlTimeoutMs: 60000 },
  )
  expect(agent).toBeTruthy()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/deepagent && bun test src/agent.test.ts`
Expected: FAIL — `buildAgent` ignores the 3rd arg; the search subagent isn't added (the test would still pass since it only asserts truthy agent, but the point is the signature). To make the failure meaningful, this test actually passes today because `buildAgent` accepts extra args silently. So instead verify the wiring via the api-level test in Task 9. **Keep this test** — it guards against a future signature regression and confirms no throw. Run it; it should PASS already. If it PASSES, that's acceptable (it's a regression guard). Proceed.

(Note: the real behavioral verification that `searchOverride` is threaded happens in `apps/api` Task 9, where the chat-handler mock captures the 3rd argument.)

- [ ] **Step 3: Write the implementation**

In `apps/deepagent/src/agent.ts`:

Update the profile import (line 11) to include `applySearchOverride`:

```ts
import { loadProfile, resolveProfile, applyOpenShellOverride, applySearchOverride } from './profiles'
```

Update the type import (line 12) to include `SearchOverride`:

```ts
import type { OpenShellOverride, SearchOverride } from './profiles/types'
```

Add the re-exports next to the openshell re-exports (after line 16):

```ts
export type { SearchOverride } from './profiles/types'
export { applySearchOverride } from './profiles'
```

Change the `buildAgent` signature + body (line 85 and 91). Replace:

```ts
export async function buildAgent(cfg: AgentConfig, openshellOverride?: OpenShellOverride) {
  if (!cfg.model) throw new Error('Agent config missing model')
  const model = buildModel(cfg)
  const root = workspaceDir()
  mkdirSync(root, { recursive: true })
  let data = loadProfile(cfg.provider, cfg.model)
  if (openshellOverride) data = applyOpenShellOverride(data, openshellOverride)
```

with:

```ts
export async function buildAgent(cfg: AgentConfig, openshellOverride?: OpenShellOverride, searchOverride?: SearchOverride) {
  if (!cfg.model) throw new Error('Agent config missing model')
  const model = buildModel(cfg)
  const root = workspaceDir()
  mkdirSync(root, { recursive: true })
  let data = loadProfile(cfg.provider, cfg.model)
  if (openshellOverride) data = applyOpenShellOverride(data, openshellOverride)
  if (searchOverride) data = applySearchOverride(data, searchOverride)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/deepagent && bun test src/agent.test.ts`
Expected: PASS (all existing + 2 new tests).

- [ ] **Step 5: Run the whole deepagent suite**

Run: `cd apps/deepagent && bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd apps/deepagent
git add src/agent.ts src/agent.test.ts
git commit -m "feat(search): buildAgent accepts searchOverride + re-exports applySearchOverride"
```

---

## Task 7: Document env defaults in .env.example

**Files:**
- Modify: `apps/deepagent/.env.example`

**Interfaces:** None — documentation only. These env vars are referenced in `docs/search-setup.md` and serve as the defaults documented for the api settings module (which uses static defaults; the env vars are for operators running the CLI REPL).

- [ ] **Step 1: Append the env documentation**

Read the current `apps/deepagent/.env.example` and append (at the end):

```bash

# Web search subagent (opt-in via /settings → Web search). These are the
# documented defaults; the api settings module (apps/api) stores the live
# values in data/search-settings.json. SearXNG must expose /search?format=json;
# Crawl4AI must expose POST /crawl + GET /health. See docs/search-setup.md.
SEARXNG_BASE_URL=http://localhost:8080
CRAWL4AI_BASE_URL=http://localhost:11235
```

- [ ] **Step 2: Commit**

```bash
cd apps/deepagent
git add .env.example
git commit -m "docs(search): document SEARXNG_BASE_URL + CRAWL4AI_BASE_URL defaults"
```

---

## Task 8: apps/api search settings module + testSearch

**Files:**
- Create: `apps/api/src/modules/agent/search.ts`
- Create: `apps/api/src/modules/agent/search.test.ts`

**Interfaces:**
- Produces:
  - `SearchSettings { enabled, searxngBaseUrl, crawl4aiBaseUrl, maxResults, crawlTimeoutMs }`
  - `DEFAULT_SEARCH_SETTINGS: SearchSettings` (enabled:false, `http://localhost:8080`, `http://localhost:11235`, 5, 60000)
  - `readSearchSettings(): SearchSettings | null`
  - `writeSearchSettings(s): void` (atomic)
  - `testSearch(s): Promise<{ ok: boolean; detail: string }>` — pings SearXNG `/search?q=test&format=json` + Crawl4AI `/health`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/agent/search.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && bun test src/modules/agent/search.test.ts`
Expected: FAIL — `Cannot find module './search'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/modules/agent/search.ts` (mirror `openshell.ts`):

```ts
// apps/api/src/modules/agent/search.ts
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export interface SearchSettings {
  enabled: boolean
  searxngBaseUrl: string
  crawl4aiBaseUrl: string
  maxResults: number
  crawlTimeoutMs: number
}

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  enabled: false,
  searxngBaseUrl: 'http://localhost:8080',
  crawl4aiBaseUrl: 'http://localhost:11235',
  maxResults: 5,
  crawlTimeoutMs: 60_000,
}

function defaultSettingsPath(): string {
  // apps/api/src/modules/agent/search.ts -> ../../../data/search-settings.json
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../../data/search-settings.json')
}

function settingsPath(): string {
  return process.env.AGENT_SEARCH_SETTINGS_PATH || defaultSettingsPath()
}

function isValid(raw: any): raw is SearchSettings {
  return !!raw
    && typeof raw.enabled === 'boolean'
    && typeof raw.searxngBaseUrl === 'string' && raw.searxngBaseUrl.length > 0
    && typeof raw.crawl4aiBaseUrl === 'string' && raw.crawl4aiBaseUrl.length > 0
    && typeof raw.maxResults === 'number'
    && typeof raw.crawlTimeoutMs === 'number'
}

export function readSearchSettings(): SearchSettings | null {
  const path = settingsPath()
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!isValid(raw)) return null
    return raw
  } catch {
    return null
  }
}

export function writeSearchSettings(s: SearchSettings): void {
  const path = settingsPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n')
  renameSync(tmp, path) // atomic
}

function base(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Verify SearXNG (/search?format=json) and Crawl4AI (/health) are reachable. */
export async function testSearch(s: SearchSettings): Promise<{ ok: boolean; detail: string }> {
  try {
    const sx = await fetch(`${base(s.searxngBaseUrl)}/search?q=test&format=json`, { signal: AbortSignal.timeout(8000) })
    if (!sx.ok) return { ok: false, detail: `SearXNG responded ${sx.status} at ${s.searxngBaseUrl}` }
    await sx.text()
  } catch (err: any) {
    return { ok: false, detail: `SearXNG not reachable at ${s.searxngBaseUrl} (${err?.message ?? err})` }
  }
  try {
    const c = await fetch(`${base(s.crawl4aiBaseUrl)}/health`, { signal: AbortSignal.timeout(8000) })
    if (!c.ok) return { ok: false, detail: `Crawl4AI responded ${c.status} at ${s.crawl4aiBaseUrl}` }
    await c.text()
  } catch (err: any) {
    return { ok: false, detail: `Crawl4AI not reachable at ${s.crawl4aiBaseUrl} (${err?.message ?? err})` }
  }
  return { ok: true, detail: 'SearXNG + Crawl4AI reachable.' }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bun test src/modules/agent/search.test.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
cd apps/api
git add src/modules/agent/search.ts src/modules/agent/search.test.ts
git commit -m "feat(api): search settings module + testSearch (SearXNG/Crawl4AI reachability)"
```

---

## Task 9: apps/api routes + chat-handler wiring

**Files:**
- Modify: `apps/api/src/modules/agent/index.ts`
- Modify: `apps/api/src/modules/agent/index.test.ts`

**Interfaces:**
- Consumes: `readSearchSettings`, `writeSearchSettings`, `DEFAULT_SEARCH_SETTINGS`, `testSearch`, `SearchSettings` from `./search` (Task 8); `buildAgent` 3-arg signature (Task 6).
- Produces: `GET/PUT /agent/search`, `POST /agent/search/test` routes; the chat handler passes a `searchOverride` (3rd arg) to `buildAgent` when search settings are saved + enabled.

- [ ] **Step 1: Write the failing tests (extend index.test.ts)**

In `apps/api/src/modules/agent/index.test.ts`:

a) Extend the `buildAgent` mock to capture the 3rd argument. Change the `mock.module` block's `buildAgent` (around line 16):

```ts
  buildAgent: async (_cfg: any, override: any) => {
    recordedOverride = override
    return {
      // Fake agent: record configurable, emit no events, let the route yield `done`.
      streamEvents: async function* (_input: any, opts: any) {
        recordedConfigurable = opts?.configurable
      },
    }
  },
```

to:

```ts
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
```

b) Add `let recordedSearchOverride: any` next to the other `let` declarations (after `let recordedOverride: any`, line 7):

```ts
let recordedConfigurable: any
let recordedOverride: any
let recordedSearchOverride: any
```

c) Reset it in `beforeEach` (after `recordedOverride = undefined`, line 35):

```ts
  recordedConfigurable = undefined
  recordedOverride = undefined
  recordedSearchOverride = undefined
```

d) Add `AGENT_SEARCH_SETTINGS_PATH` reset in `beforeEach` (after the openshell path line, line 33):

```ts
  process.env.AGENT_OPENSHELL_SETTINGS_PATH = `/tmp/openshell-settings-${Math.random().toString(36).slice(2)}.json`
  process.env.AGENT_SEARCH_SETTINGS_PATH = `/tmp/search-settings-${Math.random().toString(36).slice(2)}.json`
```

e) Add the search route + override tests at the end of the file:

```ts
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
```

(Note: the existing `POST /agent/chat threads openshell override...` test asserts `recordedOverride` equals the openshell override — that still holds because `recordedOverride` is now the 2nd arg (openshell). Confirm that test still passes in Step 4.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && bun test src/modules/agent/index.test.ts`
Expected: FAIL — `GET /agent/search` returns 404 (route not added), `recordedSearchOverride` is undefined for the enabled case.

- [ ] **Step 3: Write the implementation (routes + chat wiring)**

In `apps/api/src/modules/agent/index.ts`:

Add the search import next to the openshell import (after line 15):

```ts
import {
  readSearchSettings,
  writeSearchSettings,
  DEFAULT_SEARCH_SETTINGS,
  testSearch,
  type SearchSettings,
} from './search'
```

Add the three routes after the `POST /agent/openshell/test` route block (after line 227, before the `/agent/chat` route). Insert:

```ts
  .get(
    '/agent/search',
    () => {
      const s = readSearchSettings()
      return s ?? DEFAULT_SEARCH_SETTINGS
    },
    { detail: { summary: 'Get web search settings', tags: ['Agent'] } },
  )
  .put(
    '/agent/search',
    ({ body }) => {
      const next: SearchSettings = {
        enabled: body.enabled,
        searxngBaseUrl: body.searxngBaseUrl,
        crawl4aiBaseUrl: body.crawl4aiBaseUrl,
        maxResults: body.maxResults,
        crawlTimeoutMs: body.crawlTimeoutMs,
      }
      writeSearchSettings(next)
      return { ok: true }
    },
    {
      body: t.Object({
        enabled: t.Boolean(),
        searxngBaseUrl: t.String({ minLength: 1 }),
        crawl4aiBaseUrl: t.String({ minLength: 1 }),
        maxResults: t.Integer({ minimum: 1 }),
        crawlTimeoutMs: t.Integer({ minimum: 1 }),
      }),
      detail: { summary: 'Save web search settings', tags: ['Agent'] },
    },
  )
  .post(
    '/agent/search/test',
    async () => {
      const s = readSearchSettings()
      if (!s) return { ok: false, detail: 'No search settings saved yet.' }
      return testSearch(s)
    },
    { detail: { summary: 'Test SearXNG + Crawl4AI reachability', tags: ['Agent'] } },
  )
```

Wire the override into the chat handler. In the `/agent/chat` handler, after the `openshellOverride` block (after line 256, before `let agent`), add:

```ts
      // Read the search overlay and pass it to the deepagent profile-merge.
      const searchSettings = readSearchSettings()
      const searchOverride = searchSettings?.enabled
        ? {
            enabled: true,
            searxngBaseUrl: searchSettings.searxngBaseUrl,
            crawl4aiBaseUrl: searchSettings.crawl4aiBaseUrl,
            maxResults: searchSettings.maxResults,
            crawlTimeoutMs: searchSettings.crawlTimeoutMs,
          }
        : undefined
```

And change the `buildAgent` call (line 260):

```ts
        agent = await buildAgent(s, openshellOverride)
```

to:

```ts
        agent = await buildAgent(s, openshellOverride, searchOverride)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && bun test src/modules/agent/index.test.ts`
Expected: PASS — all existing openshell tests + the 6 new search tests. Confirm the existing `threads openshell override` test still passes (it asserts `recordedOverride`, now the 2nd arg).

- [ ] **Step 5: Run the whole api agent suite**

Run: `cd apps/api && bun test src/modules/agent/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd apps/api
git add src/modules/agent/index.ts src/modules/agent/index.test.ts
git commit -m "feat(api): /agent/search routes + thread searchOverride into chat handler"
```

---

## Task 10: apps/web search settings store + test

**Files:**
- Create: `apps/web/src/lib/stores/agentSearch.ts`
- Create: `apps/web/src/lib/stores/agentSearch.test.ts`

**Interfaces:**
- Produces: `searchSettings` writable store; `loadSearch()`, `saveSearch(payload)`, `testSearch()`; `DEFAULT_SEARCH` constant; `SearchSettings` type.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/stores/agentSearch.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bun test src/lib/stores/agentSearch.test.ts`
Expected: FAIL — `Cannot find module './agentSearch'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/stores/agentSearch.ts` (mirror `agentOpenshell.ts`):

```ts
import { writable } from 'svelte/store'

export interface SearchSettings {
	enabled: boolean;
	searxngBaseUrl: string;
	crawl4aiBaseUrl: string;
	maxResults: number;
	crawlTimeoutMs: number;
}

export const DEFAULT_SEARCH: SearchSettings = {
	enabled: false,
	searxngBaseUrl: 'http://localhost:8080',
	crawl4aiBaseUrl: 'http://localhost:11235',
	maxResults: 5,
	crawlTimeoutMs: 60_000
};

export const searchSettings = writable<SearchSettings | null>(null);
export const searchSaving = writable(false);
export const searchTesting = writable(false);
export const searchTestResult = writable<{ ok: boolean; detail: string } | null>(null);
export const searchError = writable<string | null>(null);

export async function loadSearch(): Promise<void> {
	const res = await fetch('/agent/search');
	searchSettings.set(await res.json());
}

export async function saveSearch(payload: SearchSettings): Promise<boolean> {
	searchSaving.set(true);
	searchError.set(null);
	searchTestResult.set(null);
	try {
		const res = await fetch('/agent/search', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		});
		if (!res.ok) {
			searchError.set(`Save failed (${res.status})`);
			return false;
		}
		await loadSearch();
		return true;
	} finally {
		searchSaving.set(false);
	}
}

export async function testSearch(): Promise<void> {
	searchTesting.set(true);
	searchTestResult.set(null);
	searchError.set(null);
	try {
		const res = await fetch('/agent/search/test', { method: 'POST' });
		searchTestResult.set(await res.json());
	} finally {
		searchTesting.set(false);
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && bun test src/lib/stores/agentSearch.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
cd apps/web
git add src/lib/stores/agentSearch.ts src/lib/stores/agentSearch.test.ts
git commit -m "feat(web): agentSearch settings store (load/save/test)"
```

---

## Task 11: apps/web SearchForm.svelte + settings page section

**Files:**
- Create: `apps/web/src/lib/components/agent/SearchForm.svelte`
- Modify: `apps/web/src/routes/settings/+page.svelte`

**Interfaces:**
- Consumes: the store from Task 10.

- [ ] **Step 1: Create SearchForm.svelte**

Create `apps/web/src/lib/components/agent/SearchForm.svelte` (mirror `OpenShellForm.svelte` structure + styles):

```svelte
<script lang="ts">
	import {
		searchSettings,
		searchSaving,
		searchTesting,
		searchTestResult,
		searchError,
		saveSearch,
		testSearch,
		DEFAULT_SEARCH,
		type SearchSettings
	} from '$lib/stores/agentSearch';

	let enabled = $state(false);
	let searxngBaseUrl = $state(DEFAULT_SEARCH.searxngBaseUrl);
	let crawl4aiBaseUrl = $state(DEFAULT_SEARCH.crawl4aiBaseUrl);
	let maxResults = $state(DEFAULT_SEARCH.maxResults);
	let crawlTimeoutMs = $state(DEFAULT_SEARCH.crawlTimeoutMs);

	let seeded = false;
	$effect(() => {
		const s = $searchSettings;
		if (s && !seeded) {
			seeded = true;
			enabled = s.enabled;
			searxngBaseUrl = s.searxngBaseUrl;
			crawl4aiBaseUrl = s.crawl4aiBaseUrl;
			maxResults = s.maxResults;
			crawlTimeoutMs = s.crawlTimeoutMs;
		}
	});

	const crawlSec = $derived(Math.round(crawlTimeoutMs / 1000));

	function payload(): SearchSettings {
		return { enabled, searxngBaseUrl, crawl4aiBaseUrl, maxResults, crawlTimeoutMs };
	}

	async function onSave() {
		await saveSearch(payload());
	}
</script>

<div class="form">
	<label class="row toggle">
		<span class="lbl">Enable web search subagent</span>
		<input type="checkbox" bind:checked={enabled} />
	</label>
	<p class="hint">
		When enabled, the agent gets a <code>search</code> subagent it can delegate to. It searches the web via
		<code>SearXNG</code> and reads pages via <code>Crawl4AI</code>. Requires both services running. See
		<a href="/docs/search-setup.md" target="_blank" rel="noreferrer">search setup</a>.
	</p>

	<label class="row">
		<span class="lbl">SearXNG base URL</span>
		<input class="field" type="text" bind:value={searxngBaseUrl} disabled={!enabled} />
	</label>

	<label class="row">
		<span class="lbl">Crawl4AI base URL</span>
		<input class="field" type="text" bind:value={crawl4aiBaseUrl} disabled={!enabled} />
	</label>

	<label class="row">
		<span class="lbl">Max results</span>
		<input class="field" type="number" min="1" bind:value={maxResults} disabled={!enabled} />
	</label>

	<label class="row">
		<span class="lbl">Crawl timeout ({crawlSec} s)</span>
		<input class="field" type="number" min="1000" bind:value={crawlTimeoutMs} disabled={!enabled} />
	</label>

	<div class="actions">
		<button class="btn" disabled={$searchTesting || !enabled} onclick={testSearch}>
			{$searchTesting ? 'Testing…' : 'Test'}
		</button>
		<button class="btn primary" disabled={$searchSaving} onclick={onSave}>
			{$searchSaving ? 'Saving…' : 'Save'}
		</button>
	</div>

	{#if $searchTestResult}
		<div class="result" data-ok={$searchTestResult.ok}>
			{$searchTestResult.ok ? '✓' : '✗'} {$searchTestResult.detail}
		</div>
	{/if}

	{#if $searchError}
		<div class="result" data-ok="false">✗ {$searchError}</div>
	{/if}
</div>

<style>
	.form { display: flex; flex-direction: column; gap: 1rem; }
	.row { display: flex; flex-direction: column; gap: 0.35rem; }
	.row.toggle { flex-direction: row; align-items: center; gap: 0.6rem; }
	.lbl {
		font-family: var(--font-mono);
		font-size: var(--t-2xs);
		text-transform: uppercase;
		letter-spacing: 0.6px;
		color: var(--paper-dim);
	}
	.hint {
		font-size: var(--t-sm);
		color: var(--paper-dim);
		margin: -0.4rem 0 0;
		line-height: 1.5;
	}
	.hint code {
		font-family: var(--font-mono);
		background: var(--ink-900);
		border: 1px solid var(--ink-line);
		border-radius: 3px;
		padding: 0.1rem 0.3rem;
	}
	.field {
		width: 100%;
		padding: 0.5rem 0.65rem;
		background: var(--ink-950);
		border: 1px solid var(--ink-line);
		border-radius: var(--radius-sm);
		color: var(--paper);
		font-family: var(--font-mono);
		font-size: var(--t-sm);
	}
	.field:disabled { opacity: 0.45; }
	.field:focus {
		outline: none;
		border-color: var(--saffron-line);
		box-shadow: 0 0 0 3px var(--saffron-soft);
	}
	.actions { display: flex; gap: 0.6rem; }
	.btn {
		padding: 0.5rem 0.9rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--ink-line);
		background: var(--ink-800);
		color: var(--paper);
		font-family: var(--font-mono);
		font-size: var(--t-xs);
		letter-spacing: 0.3px;
		cursor: pointer;
	}
	.btn:hover:not(:disabled) { border-color: var(--saffron-line); }
	.btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.btn.primary {
		background: var(--saffron);
		border-color: var(--saffron);
		color: #1a1208;
		font-weight: 600;
		text-transform: uppercase;
	}
	.btn.primary:hover:not(:disabled) { background: #f29638; border-color: #f29638; }
	.result {
		font-family: var(--font-mono);
		font-size: var(--t-xs);
		padding: 0.5rem 0.7rem;
		border-radius: var(--radius-sm);
		border: 1px solid;
	}
	.result[data-ok='true'] {
		background: rgba(91, 201, 122, 0.12);
		color: var(--up);
		border-color: rgba(91, 201, 122, 0.4);
	}
	.result[data-ok='false'] {
		background: rgba(248, 84, 106, 0.12);
		color: var(--down);
		border-color: rgba(248, 84, 106, 0.4);
	}
</style>
```

- [ ] **Step 2: Mount the form on the settings page**

In `apps/web/src/routes/settings/+page.svelte`:

Add the import next to the openshell import (after line 4):

```ts
	import { loadSearch } from '$lib/stores/agentSearch';
```

Add the component import (after line 6):

```ts
	import SearchForm from '$lib/components/agent/SearchForm.svelte';
```

Add `await loadSearch();` inside `onMount` (after line 13, the `await loadOpenShell();` line):

```ts
		await loadOpenShell();
		await loadSearch();
```

Add a new section at the end of `.page` (after the OpenShell section, before the closing `</div>`):

```svelte
	<h2>Web search</h2>
	<p class="muted">Optional: give the agent a web-research subagent (SearXNG + Crawl4AI).</p>
	<section class="card"><SearchForm /></section>
```

- [ ] **Step 3: Verify the web build + tests**

Run: `cd apps/web && bun test`
Expected: PASS (existing `shellParse.test.ts` + new `agentSearch.test.ts`).

Then check the Svelte typecheck/build compiles (the repo uses `bun run build` → turbo; a full build may be slow). Run a targeted check if available:

Run: `cd apps/web && bun run check 2>/dev/null || bunx svelte-check --tsconfig ./tsconfig.json 2>/dev/null || echo "no svelte-check configured — rely on build"`
Expected: no errors referencing `SearchForm` or `agentSearch`. (If neither `check` nor `svelte-check` is configured, skip — the form mirrors `OpenShellForm.svelte` exactly, which compiles.)

- [ ] **Step 4: Commit**

```bash
cd apps/web
git add src/lib/components/agent/SearchForm.svelte src/routes/settings/+page.svelte
git commit -m "feat(web): SearchForm + Web search section on the settings page"
```

---

## Task 12: Crawl4AI setup docs

**Files:**
- Create: `docs/search-setup.md`

- [ ] **Step 1: Write the setup doc**

Create `docs/search-setup.md`:

````markdown
# Web search setup (SearXNG + Crawl4AI)

The agent's optional `search` subagent needs two local services: **SearXNG** (meta-search) and **Crawl4AI** (page-to-markdown). Enable it in **Settings → Web search**.

## 1. SearXNG (already running on :8080)

SearXNG must expose `/search?format=json`. Verify:

```bash
curl 'http://localhost:8080/search?q=test&format=json'
```

You should get JSON with a `results` array. (Your SearXNG instance is already running on port 8080.)

## 2. Crawl4AI (run on :11235)

Crawl4AI is not set up yet. Run the server via Docker:

```bash
docker pull unclecode/crawl4ai:basic
docker run -d -p 11235:11235 --name crawl4ai unclecode/crawl4ai:basic
```

Verify the health endpoint:

```bash
curl http://localhost:11235/health
# {"status":"healthy", ...}
```

The server exposes `POST /crawl` (used by the `crawl_page` tool) and `GET /health` (used by the Settings → Test button).

## 3. Enable in the UI

1. Open **/settings** → **Web search**.
2. Toggle **Enable web search subagent**.
3. Confirm the URLs (defaults `http://localhost:8080` and `http://localhost:11235`).
4. Click **Test** — it pings SearXNG `/search` and Crawl4AI `/health` and reports reachability.
5. Click **Save**.

On the next chat, the main agent can delegate web research to the `search` subagent via `task()`.

## Notes

- Search is **off by default**; it's added to the agent only when enabled and saved.
- The `crawl_page` tool POSTs `{ url, browser_config: { headless: true }, crawler_config: { cache_mode: "BYPASS" } }` to `/crawl` and returns the cleaned markdown (truncated to 20 000 chars).
- Both tools never throw — if a service is down, they return a JSON error string the subagent can reason over.
````

- [ ] **Step 2: Commit**

```bash
git add docs/search-setup.md
git commit -m "docs(search): SearXNG + Crawl4AI setup guide"
```

---

## Final verification

- [ ] **Step 1: Run every workspace's tests**

```bash
cd apps/deepagent && bun test
cd apps/api && bun test
cd apps/web && bun test
```
Expected: all PASS.

- [ ] **Step 2: Manual smoke test (operator)**

1. Start SearXNG (already on :8080) and Crawl4AI (`docker run -d -p 11235:11235 --name crawl4ai unclecode/crawl4ai:basic`).
2. Start the stack (`bun run dev` at repo root, or the api + web dev scripts).
3. Open `/settings` → **Web search** → enable → Test (expect ✓) → Save.
4. In chat, ask the agent something web-researchable (e.g. "search the web for the latest TCS news and summarize"). Expect a `task` call to the `search` subagent, `web_search` + `crawl_page` tool calls, and a cited answer.
5. Disable search in settings → confirm a new chat has no `search` subagent (the agent does not attempt web delegation).