# DeepAgents Tools for the Trading API — Design

**Date:** 2026-07-07
**Status:** Approved (brainstorm)
**Scope:** Turn the existing `apps/api` Elysia endpoints into LangChain DeepAgents JS
tools, plus a minimal runnable CLI agent that uses them. The agent calls the **running
API over HTTP**; it does not import `apps/api` internals.

## Goal

Give a DeepAgents agent the ability to read and act on the trading API — instruments,
quotes, historical/intraday candles, option chain, market info, fundamentals, news, and
the backtest candle store — so a user can ask natural-language questions and the agent
calls the right endpoint(s). Designed so **even a small model** can pick and call tools
correctly.

## Non-goals

- Live feed / WebSocket / SSE streaming as tools (the two streaming routes are skipped).
- Strategy engine / backtest runner (separate spec).
- Frontend / web UI for the agent.
- Refactoring the existing `apps/api` routes.
- Tests via a test runner (none configured; verification is manual end-to-end).

## Background

- Monorepo: bun 1.3.14 + turbo, workspaces `apps/*`. Existing apps: `apps/api`
  (Elysia + Upstox + backtest candle store), `apps/deepagent` (scaffold with
  `deepagents@1.10.5`, `langchain@1.5.2`, `@langchain/core@1.2.1` installed, placeholder
  `src/index.ts`).
- DeepAgents JS: `createDeepAgent({ model, tools, systemPrompt })` →
  `agent.invoke({ messages })`. Tools are `tool(async (args) => result, { name,
  description, schema: z.object({...}) })` from `langchain` + `zod`.
- API has **45 non-streaming endpoints** across 9 modules (instruments,
  expired-instruments, historical-data, market-quote, option-chain, market-info,
  fundamentals, news, stream control) + backtest-data. Two streaming routes
  (`/stream/market-data-sse`, `/stream/market-data`) are skipped.

## Architecture

Each tool calls the running API over HTTP through one shared helper:

```ts
apiCall(method: 'GET' | 'POST', path: string, query?: Record<string, string | number>,
        body?: unknown): Promise<string>
```

- Base URL from `process.env.API_BASE_URL ?? 'http://localhost:3000'`.
- Builds the URL with query params, `fetch`es, returns the response body as a **string**.
- On HTTP non-2xx: returns `JSON.stringify({ status, error: <body> })`.
- On fetch failure (API not running): returns
  `JSON.stringify({ error: 'API not reachable at <url> — is apps/api running?' })`.
- Tools **never throw** — they catch and return the error string so the agent can reason.

A **small curated set of named tools** covers common trading-assistant actions; one
generic **`call_api`** tool covers the remaining endpoints. All 45 endpoints are
reachable (named + generic), satisfying "ella apiyum venum".

## Curated named tools (11)

All params are flat zod fields with `.describe()`. Date fields use `YYYY-MM-DD`.
`instrument_keys` / `symbol` are comma-separated lists where the API expects them.

| # | Tool name | API call | Key params |
|---|-----------|----------|------------|
| 1 | `search_instruments` | GET /instruments/search | `q` (req), `exchanges?`, `segments?`, `instrument_types?` |
| 2 | `get_ltp` | GET /market-quote/v3/ltp | `instrument_keys` (req, comma list) |
| 3 | `get_ohlc_quote` | GET /market-quote/v3/ohlc | `instrument_keys` (req), `interval` (req) |
| 4 | `historical_candles` | v2: GET /historical-data/v2/candles/:instrumentKey/:interval/:toDate  ·  v3: GET /historical-data/v3/candles/:instrumentKey/:unit/:interval/:toDate | `instrument_key` (req), `source` (req, `v2`\|`v3`), `interval` (req), `unit?` (req when v3, `minutes`\|`hours`\|`days`), `to_date` (req), `from_date?` |
| 5 | `intraday_candles` | v2: GET /historical-data/v2/intraday/:instrumentKey/:interval  ·  v3: GET /historical-data/v3/intraday/:instrumentKey/:unit/:interval | `instrument_key` (req), `source` (req), `interval` (req), `unit?` (req when v3) |
| 6 | `sync_candles` | POST /backtest/data/sync | `instrument_key` (req), `source` (req), `interval` (req), `unit?`, `from_date` (req), `to_date` (req) |
| 7 | `read_candles` | GET /backtest/data/candles/:instrumentKey/:timeframe | `instrument_key` (req), `timeframe` (req, canonical e.g. `5minutes`/`day`), `from_date` (req), `to_date` (req) |
| 8 | `option_chain` | GET /option-chain/chain | `instrument_key` (req), `expiry_date` (req) |
| 9 | `market_status` | GET /market-info/status/:exchange | `exchange` (req) |
| 10 | `company_profile` | GET /fundamentals/profile/:isin | `isin` (req) |
| 11 | `news` | GET /news | `category` (req, `instrument_keys`\|`positions`\|`holdings`), `instrument_keys?` (req when category=instrument_keys) |

### `historical_candles` / `intraday_candles` v2 vs v3 routing

- `source=v2`: path uses `:interval` (enum `1minute`\|`30minute`\|`day`\|`week`\|`month`), no unit.
- `source=v3`: path uses `:unit`/`:interval` (unit `minutes`\|`hours`\|`days`, interval numeric string).
The tool builds the correct path from `source`; `unit` is required when `source=v3` (validated
in the tool, returning an error string if missing — mirroring the API's 422).

## `call_api` (generic tool)

```ts
call_api({ method, path, query?, body? })
```
- `method`: `GET`\|`POST`. `path`: full path beginning with `/`, **without** query string
  (e.g. `/market-info/pcr`). `query`: object of query params. `body`: object (POST only).
- The tool description embeds the **full list of the other ~34 paths** so the model knows
  what else it can call: full quote (`/market-quote/v2/full`), option greeks
  (`/market-quote/v3/option-greek`), option contracts (`/option-chain/contracts`), all
  market-info (change-oi, dii, fii, oi, max-pain, pcr, smartlist/futures, smartlist/mtf,
  smartlist/options, timings/:date, holidays, holidays/:date), all fundamentals
  (balance-sheet, cash-flow, competitors, corporate-actions, income-statement, key-ratios,
  share-holdings), expired-instruments (expiries, future-contracts, option-contracts,
  historical-candles), and stream control (authorize endpoints, subscriptions GET/POST).
- The list notes each path's required params at a high level (the model can call `call_api`
  and, if it gets a 400/422, read the error and retry with the right params).

## Small-model usability rules (every tool)

1. `snake_case` names; action-oriented `description` with **when-to-use + a concrete
   example invocation**.
2. **Flat** zod schemas — no nested objects.
3. `.describe()` on **every** field: what it means + example value + format.
4. **Enums** wherever the API constrains values (`source`, `unit`, `category`, `interval`
   for v2, etc.).
5. Required vs optional explicit; optionals get sensible defaults.
6. Return a JSON string (so the model reads structured data). Never throw.
7. Cross-field requirements (e.g. `unit` required when `source=v3`; `instrument_keys`
   required when `category=instrument_keys`) are validated in the tool body, returning an
   error string (not a thrown schema error) so the model gets a readable message.

## File structure (`apps/deepagent/src/`)

- `tools/http.ts` — `apiCall()` helper + `API_BASE_URL` config.
- `tools/named.ts` — the 11 named tools.
- `tools/call-api.ts` — `call_api` tool + embedded path list constant.
- `tools/index.ts` — exports `const allTools = [...namedTools, callApiTool]`.
- `agent.ts` — `createDeepAgent({ model: process.env.DEEPAGENT_MODEL, tools: allTools,
  systemPrompt })`; exports `agent` (async factory) and the system prompt.
- `index.ts` — CLI REPL: prompt stdin → `agent.invoke({ messages: [{role:'user',
  content: line}] })` → print `result.content` / final message → loop until empty line or
  `exit`. Conversation history is **not** persisted across turns (single-turn per line for
  simplicity; YAGNI — multi-turn memory can come later).

### System prompt (agent.ts)

Concise: "You are a trading assistant for the Indian stock market via the local Upstox-backed
API. Use the provided tools to answer. Instrument keys look like `NSE_EQ|INE002A01018`;
timeframes are canonical labels (`5minutes`, `1days`, `day`). Dates are `YYYY-MM-DD`. If a
tool returns an error, read it and retry with corrected params. If the API is unreachable,
tell the user to start apps/api."

## Env (`apps/deepagent/.env` — gitignored; add `.env.example`)

- `DEEPAGENT_MODEL` — provider-prefixed model string, e.g.
  `anthropic:claude-sonnet-4-6` or `openai:gpt-4o-mini`.
- `ANTHROPIC_API_KEY` **or** `OPENAI_API_KEY` — whichever matches the model prefix.
- `API_BASE_URL` — default `http://localhost:3000`.

`apps/deepagent/.env.example` documents these (committed). `.env` is gitignored (already
covered by the root `.gitignore` `.env` / `.env.*` rules).

## Error handling

- Tool-level: catch all fetch/parse errors → return `{"error":"..."}` string.
- HTTP non-2xx → return `{"status":N,"error":<body>}` string.
- Missing `DEEPAGENT_MODEL` at agent boot → `agent.ts` throws a clear startup error
  ("Set DEEPAGENT_MODEL in apps/deepagent/.env"). Missing API key → LangChain/provider
  error surfaces at first invoke (acceptable; documented in `.env.example`).

## Verification (manual end-to-end)

1. Start `apps/api` (`bun run dev` in apps/api → port 3000).
2. Set `apps/deepagent/.env` (`DEEPAGENT_MODEL`, the matching key, optionally
   `API_BASE_URL`).
3. `bun run src/index.ts` in apps/deepagent.
4. "What's the LTP of NSE_EQ|INE002A01018?" → expect `get_ltp` called, LTP returned.
5. "Fetch Nifty 5min candles for 2026-06-01 to 2026-06-30 and store them" → `sync_candles`
   returns `{stored, chunks, file}`.
6. "Read the stored Nifty 5minutes candles for 2026-06-05 to 2026-06-10" → `read_candles`
   returns candles.
7. "Is the market open on NSE?" → `market_status`.
8. "What's the max pain for NIFTY expiring 2026-06-26 on 2026-06-10?" → `call_api` hits
   `/market-info/max-pain` (obscure endpoint → generic tool).
9. Confirm a missing-model env error and an API-not-running error both produce clear
   messages.

## Open items / future specs

- Multi-turn conversation memory (persist messages across REPL turns).
- Exposing the streaming WS/SSE feed as a tool (would need an async/iterator bridge).
- Strategy engine + backtest runner consuming `read_candles`.
- Auto-generating the `call_api` path list from the API's OpenAPI/Swagger instead of a
  hand-maintained constant.

## Notes

- `call_api`'s embedded path list is hand-maintained from the 2026-07-07 endpoint
  inventory (45 endpoints). If endpoints change, update the list. A future spec may
  auto-generate it from `/swagger`'s OpenAPI document.