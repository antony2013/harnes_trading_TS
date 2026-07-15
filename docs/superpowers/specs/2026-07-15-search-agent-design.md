# Search Agent — SearXNG + Crawl4AI

**Date:** 2026-07-15
**Status:** Approved (brainstorming phase)
**Scope:** Add a `search` subagent to the deepagent harness that searches the public web via SearXNG (running locally on `:8080`) and reads page content via Crawl4AI, wired through the same opt-in settings pipeline used by OpenShell.

## Goal

Give the main trading agent a delegated web-research capability: a `search` subagent it invokes via `task()` for anything its market-data tools cannot answer (news, announcements, docs, general knowledge). The subagent searches with SearXNG, reads the most relevant pages with Crawl4AI, and returns a concise cited answer.

The feature is **opt-in** (default off), toggled at runtime through a full settings pipeline across `apps/deepagent` (library), `apps/api` (Elysia settings + chat handler), and `apps/web` (SvelteKit settings form) — a direct mirror of the OpenShell integration.

## Non-goals (v1)

- No new base prompt block. deepagents advertises subagents to the main agent via the `task` tool using the subagent's `name` + `description`, so the main agent discovers `search` without a `blocks.ts` change. This avoids baseline churn and an always-on mention when the feature is off.
- Search tools are **not** added to `ptcAllowlist`. Search is a subagent capability, not an eval/PTC tool.
- No result caching or rate-limiting.
- No auto-crawl of every search hit; the subagent's prompt directs it to crawl only the 1–2 most relevant URLs.

## Architecture

A `search` subagent with two tools — `web_search` (SearXNG) and `crawl_page` (Crawl4AI) — delivered through a `search` middleware built with a `SearchSpec` from the profile. This mirrors exactly how OpenShell delivers its `shell` tool via the `openshell` middleware. Config (base URLs, max results, crawl timeout) flows through the profile/resolve pipeline — no global state, no env mutation by the tools.

```
apps/web (SvelteKit)          apps/api (Elysia)              apps/deepagent (library)
┌──────────────────┐          ┌────────────────────┐         ┌─────────────────────────┐
│ SearchForm.svelte│──PUT──▶  │ /agent/search      │         │ SearchSpec (types.ts)   │
│ agentSearch.ts   │◀─GET───  │ /agent/search/test │         │ SearchOverride          │
│ (store)          │          │ search.ts (settings│         │ applySearchOverride     │
└──────────────────┘          │  JSON r/w)         │         │   (loader.ts)           │
                              │                    │         │ 'search' middleware      │
                              │  chat handler:     │         │   (middleware.ts)       │
                              │  readSearchSettings│         │   buildSearchMiddleware │
                              │   → searchOverride │──build─▶│   → web_search tool      │
                              │   → buildAgent(s,  │  Agent  │   → crawl_page tool     │
                              │      osOverride,   │         │ search subagent          │
                              │      searchOverride)│        │   (defaults.ts const)   │
                              └────────────────────┘         └─────────────────────────┘
```

### Key decisions

1. **Search is off by default.** `DEFAULT_PROFILE_DATA` has no `search` middleware, no `search` subagent, and no `SearchSpec`. It is added only by `applySearchOverride({ enabled: true })`. This mirrors OpenShell (off by default) and keeps `profiles/default.jsonc` == `DEFAULT_PROFILE_DATA` (the loader baseline test stays green, `blocks.test.ts` stays green).
2. **The `search` subagent definition is a constant** (`SEARCH_SUBAGENT` in `defaults.ts`), spliced into `profile.subagents` by `applySearchOverride` when enabled and removed when disabled. This keeps the subagent declarative data, consistent with the existing `general-purpose`/`quant`/`reporter` subagents.
3. **Config threaded via the middleware spec**, not env. The `search` middleware builder receives a `SearchSpec` (from the profile, ultimately from the api settings) and bakes it into the two tools. The tools never read env or global state.

## Components

### `apps/deepagent` (library)

#### `src/profiles/types.ts`

```ts
export interface SearchSpec {
  searxngBaseUrl: string      // e.g. http://localhost:8080
  crawl4aiBaseUrl: string     // e.g. http://localhost:11235
  maxResults: number          // SearXNG results to return (e.g. 5)
  crawlTimeoutMs: number      // Crawl4AI fetch timeout (e.g. 60000)
}

export interface SearchOverride {
  enabled: boolean
  searxngBaseUrl: string
  crawl4aiBaseUrl: string
  maxResults: number
  crawlTimeoutMs: number
}
```

`ProfileData` gains `search?: SearchSpec` (present only when `middleware` includes `'search'`), mirroring `openshell?: OpenShellSpec`.

#### `src/profiles/defaults.ts`

Export a `SEARCH_SUBAGENT` constant (not added to `DEFAULT_PROFILE_DATA.subagents` — search is opt-in):

```ts
export const SEARCH_SUBAGENT: SubagentSpec = {
  name: 'search',
  description: 'Search the public web (SearXNG) and read page content (Crawl4AI) for news, announcements, docs, or any topic the other tools cannot answer.',
  systemPrompt: 'You are a web research subagent. Use web_search to find sources, then crawl_page on the 1-2 most relevant URLs to read their content. Return a concise synthesized answer with source URLs as citations. Prefer recent results. Do not write files.',
  tools: 'none',
  middleware: ['search'],
}
```

`DEFAULT_PROFILE_DATA` itself is **unchanged**.

#### `src/profiles/middleware.ts`

Add `search?: SearchSpec` to `MwCtx` (mirror of `openshell?`). Add a `search` builder to `MIDDLEWARE_REGISTRY`:

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

#### `src/search/middleware.ts` (new)

`buildSearchMiddleware(spec: SearchSpec): AgentMiddleware` builds two `tool() + zod` tools with `spec` baked in and returns `{ name: 'search', tools: [webSearch, crawlPage] }`.

- **`web_search({ query: string })`** → `GET {searxngBaseUrl}/search?q=<query>&format=json&safesearch=1&pageno=1` with a 15s `AbortSignal.timeout`. Parse the JSON `results` array and return `JSON.stringify` of the top `maxResults` entries as `[{ title, url, snippet, engines }]`. Never throws; on fetch failure returns `JSON.stringify({ error: 'SearXNG not reachable at <url> — is it running?' })`, on non-2xx returns `{ status, error }`.
- **`crawl_page({ url: string })`** → `POST {crawl4aiBaseUrl}/crawl` with a minimal body `{ url, ...crawler_config }` and `AbortSignal.timeout(crawlTimeoutMs)`. Return the cleaned **markdown** (`result.markdown`), truncated to a sane cap (e.g. 20k chars with a `…[truncated]` marker). Never throws; same error-string contract. Validates the `url` input is an `http(s)://` URL before calling.
- Both tools follow the `apiCall` contract: return strings, never throw, so the subagent can reason over errors.

The exact Crawl4AI `/crawl` request body and response field names are pinned against current Crawl4AI server API docs during implementation (verify via Context7 / Crawl4AI docs when writing the tool).

#### `src/profiles/resolve.ts`

Thread `search` into both contexts, mirroring `openshell`:
- `parentCtx.search = data.middleware.includes('search') ? data.search : undefined`
- `subCtx.search = s.middleware.includes('search') ? data.search : undefined`

#### `src/profiles/loader.ts`

- `validateMerged`: when `data.middleware.includes('search')`, require a complete `SearchSpec` (all four fields present and correctly typed) — mirror of the openshell check.
- `applySearchOverride(profile, override)`:
  - `enabled: true` → `mergeProfiles(profile, { middleware: [...profile.middleware, 'search'], search: { searxngBaseUrl, crawl4aiBaseUrl, maxResults, crawlTimeoutMs }, subagents: [SEARCH_SUBAGENT] })` then `validateMerged`.
  - `enabled: false` → strip `'search'` from `middleware`, drop the `search` spec, filter out the `search` subagent from `subagents`, `validateMerged`. No-op if search wasn't present.

#### `src/profiles/schema.json`

Add a `search` object property mirroring `openshell`:
```jsonc
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
}
```
`middleware` is a free string array, so `'search'` needs no schema enum entry.

#### `src/agent.ts`

`buildAgent(cfg, openshellOverride?, searchOverride?)`. When `searchOverride` is present, `data = applySearchOverride(data, searchOverride)` after the openshell override. Re-export `SearchOverride` and `applySearchOverride` (mirror of the openshell re-exports).

#### `apps/deepagent/.env.example`

Add `SEARXNG_BASE_URL=http://localhost:8080` and `CRAWL4AI_BASE_URL=http://localhost:11235` as documented defaults. These are used as fallbacks by the api settings module defaults, **not** read by the tools (the tools use the spec).

### `apps/api` (Elysia)

#### `src/modules/agent/search.ts` (new)

Mirror `openshell.ts`:
- `SearchSettings { enabled, searxngBaseUrl, crawl4aiBaseUrl, maxResults, crawlTimeoutMs }`.
- `DEFAULT_SEARCH_SETTINGS`: `{ enabled: false, searxngBaseUrl: 'http://localhost:8080', crawl4aiBaseUrl: 'http://localhost:11235', maxResults: 5, crawlTimeoutMs: 60_000 }`.
- Atomic JSON read/write to `data/search-settings.json`, path overridable via `AGENT_SEARCH_SETTINGS_PATH`.
- `isValid` validator; `readSearchSettings(): SearchSettings | null`; `writeSearchSettings(s)`.

#### `src/modules/agent/index.ts`

Add routes mirroring the openshell routes:
- `GET /agent/search` → `readSearchSettings() ?? DEFAULT_SEARCH_SETTINGS`.
- `PUT /agent/search` → validate body with `t.Object({ enabled: t.Boolean(), searxngBaseUrl: t.String(), crawl4aiBaseUrl: t.String(), maxResults: t.Integer({ minimum: 1 }), crawlTimeoutMs: t.Integer({ minimum: 1 }) })`, `writeSearchSettings`.
- `POST /agent/search/test` → ping `GET {searxngBaseUrl}/search?q=test&format=json` and `GET {crawl4aiBaseUrl}/health`; return `{ ok, detail }`.

In `/agent/chat`: `readSearchSettings()`; if present and `enabled`, build `searchOverride` (undefined otherwise) and pass to `buildAgent(s, openshellOverride, searchOverride)`.

### `apps/web` (SvelteKit)

#### `src/lib/stores/agentSearch.ts` (new)

Mirror `agentOpenshell.ts`: `searchSettings` writable store + `searchSaving`/`searchTesting`/`searchTestResult`/`searchError` stores; `loadSearch()`, `saveSearch(payload)`, `testSearch()`.

#### `src/lib/components/agent/SearchForm.svelte` (new)

Mirror `OpenShellForm.svelte`: enable toggle, SearXNG URL field, Crawl4AI URL field, max results (number), crawl timeout (number, shown in seconds), Test + Save buttons, result/error display. Fields disabled when not enabled. Reuse the OpenShell form's CSS classes/variables.

#### `src/routes/settings/+page.svelte`

Add a "Web search" `<section class="card">` mounting `SearchForm`, and `await loadSearch()` in `onMount`.

## Data flow (a search turn)

1. User enables search in `/settings`, sets SearXNG/Crawl4AI URLs → `PUT /agent/search` → `writeSearchSettings` to `data/search-settings.json`.
2. User asks the main agent something needing web info → `POST /agent/chat`.
3. Chat handler reads `readSearchSettings()`; if `enabled`, builds `searchOverride` and calls `buildAgent(cfg, openshellOverride, searchOverride)`.
4. `buildAgent` → `loadProfile` → `applySearchOverride` splices in `'search'` middleware + `SearchSpec` + `SEARCH_SUBAGENT` → `resolveProfile` builds the `search` middleware (which builds `web_search`/`crawl_page` with the spec) and attaches it to the `search` subagent.
5. `createDeepAgent` advertises the `search` subagent to the main agent via the `task` tool. The main agent calls `task(subagent_type='search', ...)` when it needs web info.
6. The search subagent runs `web_search(query)` → picks top URLs → `crawl_page(url)` → synthesizes a cited answer → returns it to the main agent.

## Error handling

- **Tools never throw** — same contract as `apiCall`. SearXNG/Crawl4AI unreachable → `JSON.stringify({ error: 'SearXNG not reachable at <url> — is it running?' })`. Non-2xx → `{ status, error }`. The subagent reasons over these and can retry or report failure.
- **Timeouts**: `crawl_page` uses `AbortSignal.timeout(crawlTimeoutMs)`; `web_search` uses a fixed 15s timeout. A timeout surfaces as a tool error string, not an exception.
- **Search disabled at runtime**: `searchOverride` is `undefined` → no `search` subagent exists → the main agent has no `search` task target. Clean absence, no broken tool references.
- **Schema/validation**: an incomplete `SearchSpec` (e.g. a profile JSONC with `search` middleware but missing fields) throws `ProfileSchemaError` / `validateMerged` error at load — same fail-fast as openshell.
- **Settings JSON corruption**: `readSearchSettings` returns `null` on missing/invalid file → the chat handler treats search as off (no override); `GET /agent/search` returns `DEFAULT_SEARCH_SETTINGS`. Matches openshell behavior.

## Testing (`bun:test`, co-located `.test.ts`)

- **`src/search/middleware.test.ts`** — stub SearXNG + Crawl4AI with `Bun.serve` (pattern from `src/eval/stub-server.ts`): assert `web_search` builds the right URL/query, returns the top N parsed results, never throws on fetch failure (returns error JSON), respects `maxResults`. Assert `crawl_page` POSTs to `/crawl`, returns markdown, truncates, rejects non-`http(s)` URLs, never throws on timeout/unreachable.
- **`src/profiles/loader.test.ts`** (extend) — assert `applySearchOverride(enabled: true)` adds `'search'` middleware + `SearchSpec` + `search` subagent and re-validates; `enabled: false` strips all three. Assert the `search` subagent is absent from the default profile. Assert `validateMerged` throws on an incomplete `SearchSpec`.
- **`src/profiles/resolve.test.ts`** (extend) — assert a profile with `search` middleware resolves to a `search` subagent whose middleware contains the `search` middleware object exposing 2 tools.
- **`apps/api`** (extend agent module test) — `GET/PUT /agent/search` round-trip + `POST /agent/search/test` against a stub.
- **`apps/web`** — `agentSearch.test.ts` for the store's load/save/test fetch calls (mirror existing web store tests).
- **`blocks.test.ts`**: **no change** (deliberate — no new base block).
- **Loader baseline test** (`defaults.ts` == `default.jsonc`): stays green — both are unchanged.

## Crawl4AI setup (the missing piece)

SearXNG is already running on `:8080`. Crawl4AI is not set up yet. Add `docs/search-setup.md`:

- Run the Crawl4AI server via Docker:
  `docker run -d -p 11235:11235 --name crawl4ai unclecode/crawl4ai:basic`
  (exposes an HTTP API on `:11235` with `GET /health` and `POST /crawl`).
- Confirm:
  - `curl http://localhost:11235/health` → healthy.
  - `curl 'http://localhost:8080/search?q=test&format=json'` → JSON results (SearXNG already up).
- The Settings → Web search "Test" button hits both `/health` and a SearXNG `/search` ping, so misconfiguration is visible in the UI without a chat round-trip.
- The exact Crawl4AI `/crawl` request/response shape is pinned against current Crawl4AI docs during implementation.

## Build sequence (summary)

1. deepagent: `types.ts` → `defaults.ts` (`SEARCH_SUBAGENT`) → `search/middleware.ts` (tools) → `middleware.ts` (registry) → `resolve.ts` (thread spec) → `loader.ts` (`validateMerged` + `applySearchOverride`) → `schema.json` → `agent.ts` (third override param + re-exports) → `.env.example`. Tests alongside each.
2. api: `search.ts` settings module → `index.ts` routes + chat-handler wiring. Tests.
3. web: `agentSearch.ts` store → `SearchForm.svelte` → `+page.svelte` section. Tests.
4. docs: `docs/search-setup.md`.