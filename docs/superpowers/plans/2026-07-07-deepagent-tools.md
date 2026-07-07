# DeepAgents Tools for the Trading API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `apps/api` Elysia endpoints into LangChain DeepAgents JS tools (HTTP-call to the running API) plus a minimal runnable CLI agent in `apps/deepagent`.

**Architecture:** Each tool calls the running API over HTTP via one shared `apiCall()` helper that returns a JSON string and never throws. 11 curated named tools cover common trading actions; one generic `call_api` tool covers the remaining ~34 endpoints. A CLI REPL (`src/index.ts`) builds the agent from `DEEPAGENT_MODEL` env and invokes it per input line.

**Tech Stack:** Bun 1.3.14, TypeScript, `deepagents@1.10.5`, `langchain@1.5.2`, `@langchain/core@1.2.1`, `zod`. Turborepo workspace `apps/deepagent`.

## Global Constraints

- Runtime: **bun 1.3.14**. Run scripts from `apps/deepagent` unless noted.
- Dependencies: add via **`bun add` only** — never hand-write deps in `package.json`. `deepagents`, `langchain`, `@langchain/core` are already installed; `zod` is added in Task 2.
- The trading API (`apps/api`) must be running on `http://localhost:3000` with `UPSTOX_ACCESS_TOKEN` set in `apps/api/.env` for tool verification. Start it with `bun run dev` in `apps/api`.
- No test runner is configured. Verification is **manual runtime checks** via `bun -e` (invoking a tool against the running API) or booting the agent — each task's verify step gives the exact command and expected output.
- `.env` files are gitignored (root `.gitignore` covers `.env` / `.env.*` with `!.env.example` at any depth). Commit `.env.example`; never commit `.env` or `UPSTOX_ACCESS_TOKEN`.
- Tools **never throw** — they catch errors and return a JSON error string (`{"status":N,"error":...}` on non-2xx, `{"error":"API not reachable..."}` on fetch failure).
- Tool names are `snake_case`; every zod field has `.describe()`; schemas are flat; enums where the API constrains values.
- Branch: `feat/deepagent-tools` (already created). Commit per task with `feat(deepagent): ...` / `chore(deepagent): ...`.

---

### Task 1: `tools/http.ts` — shared `apiCall` helper

**Files:**
- Create: `apps/deepagent/src/tools/http.ts`

**Interfaces:**
- Produces: `apiCall(method: 'GET'|'POST', path: string, query?: Record<string, string|number|undefined>, body?: unknown): Promise<string>` and `API_BASE_URL` (string). All later tools import `apiCall` from `./http`.

- [ ] **Step 1: Create `apps/deepagent/src/tools/http.ts`**

```ts
// Shared HTTP helper for all deepagent tools: calls the running trading API
// (apps/api on port 3000 by default) and returns the response body as a string.
// Tools never throw — they return a JSON error string so the agent can reason.

const API_BASE_URL =
  (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')

export type ApiMethod = 'GET' | 'POST'

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * Call the trading API. Returns the response body as a string.
 * - 2xx  -> the raw body string (usually JSON).
 * - non-2xx -> JSON.stringify({ status, error }).
 * - fetch failure (API not running) -> JSON.stringify({ error: 'API not reachable ...' }).
 */
export async function apiCall(
  method: ApiMethod,
  path: string,
  query?: Record<string, string | number | undefined>,
  body?: unknown,
): Promise<string> {
  const url = new URL(API_BASE_URL + path)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
  }
  try {
    const res = await fetch(url.toString(), {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (res.ok) return text
    return JSON.stringify({ status: res.status, error: tryParse(text) ?? text })
  } catch (err: any) {
    return JSON.stringify({
      error: `API not reachable at ${API_BASE_URL} — is apps/api running? (${err?.message ?? String(err)})`,
    })
  }
}
```

- [ ] **Step 2: Verify against the running API**

Start the API (in a separate terminal): `cd apps/api && bun run dev`. Then from `apps/deepagent`:

```bash
bun -e 'import("./src/tools/http").then(async m => console.log(await m.apiCall("GET","/market-info/holidays")))'
```
Expected: a JSON array of holiday objects (or `[]`). Then:

```bash
bun -e 'import("./src/tools/http").then(async m => console.log(await m.apiCall("GET","/no-such-path")))'
```
Expected: `{"status":404,"error":"..."}` (a JSON string, NOT a thrown error).

- [ ] **Step 3: Commit**

```bash
git add apps/deepagent/src/tools/http.ts
git commit -m "feat(deepagent): shared apiCall HTTP helper for tools"
```

---

### Task 2: `tools/named.ts` — market-data named tools (7)

**Files:**
- Create: `apps/deepagent/src/tools/named.ts`

**Interfaces:**
- Consumes: `apiCall` from `./http`.
- Produces: named exports `searchInstruments`, `getLtp`, `getOhlcQuote`, `historicalCandles`, `intradayCandles`, `optionChain`, `marketStatus` (LangChain `Tool` objects). Task 3 appends 4 more exports to this same file.

- [ ] **Step 1: Add `zod` dependency**

```bash
cd apps/deepagent && bun add zod
```

- [ ] **Step 2: Create `apps/deepagent/src/tools/named.ts` with the 7 market-data tools**

```ts
import { tool } from 'langchain'
import { z } from 'zod'
import { apiCall } from './http'

const enc = encodeURIComponent

// 1) Search Upstox instruments by natural-language query.
export const searchInstruments = tool(
  async ({ q, exchanges, segments, instrument_types }) =>
    apiCall('GET', '/instruments/search', {
      q,
      exchanges,
      segments,
      instrumentTypes: instrument_types,
    }),
  {
    name: 'search_instruments',
    description:
      'Search Upstox instruments by a natural-language query. USE THIS FIRST to find an instrument_key (e.g. "NIFTY 50", "TCS") before calling quote or candle tools. Returns an array of instrument objects. Example: q="NIFTY 50".',
    schema: z.object({
      q: z.string().min(1).describe('Natural-language search text, e.g. "NIFTY 50" or "TCS"'),
      exchanges: z.string().optional().describe('Comma-separated exchange filter, e.g. "NSE" (optional)'),
      segments: z.string().optional().describe('Comma-separated segment filter, e.g. "EQ" (optional)'),
      instrument_types: z.string().optional().describe('Comma-separated instrument type filter (optional)'),
    }),
  },
)

// 2) Last traded price (v3, by instrument key).
export const getLtp = tool(
  async ({ instrument_keys }) =>
    apiCall('GET', '/market-quote/v3/ltp', { instrumentKey: instrument_keys }),
  {
    name: 'get_ltp',
    description:
      'Get the last traded price (LTP) for one or more instruments. Returns LTP quote objects. Example: instrument_keys="NSE_EQ|INE002A01018".',
    schema: z.object({
      instrument_keys: z
        .string()
        .min(1)
        .describe('Comma-separated Upstox instrument keys, e.g. "NSE_EQ|INE002A01018" (up to 500)'),
    }),
  },
)

// 3) OHLC quote (v3).
export const getOhlcQuote = tool(
  async ({ instrument_keys, interval }) =>
    apiCall('GET', '/market-quote/v3/ohlc', { instrumentKey: instrument_keys, interval }),
  {
    name: 'get_ohlc_quote',
    description:
      'Get OHLC (open/high/low/close) quotes for one or more instruments. Returns OHLC quote objects. Example: instrument_keys="NSE_EQ|INE002A01018", interval="1d".',
    schema: z.object({
      instrument_keys: z.string().min(1).describe('Comma-separated instrument keys (up to 500)'),
      interval: z.string().min(1).describe('OHLC interval, e.g. "1d"'),
    }),
  },
)

// 4) Historical candles (v2 or v3).
export const historicalCandles = tool(
  async ({ instrument_key, source, interval, unit, to_date, from_date }) => {
    if (source === 'v3' && !unit) {
      return JSON.stringify({ error: 'unit is required when source=v3 (minutes|hours|days)' })
    }
    const path =
      source === 'v2'
        ? `/historical-data/v2/candles/${enc(instrument_key)}/${enc(interval)}/${to_date}`
        : `/historical-data/v3/candles/${enc(instrument_key)}/${unit}/${enc(interval)}/${to_date}`
    return apiCall('GET', path, from_date ? { fromDate: from_date } : undefined)
  },
  {
    name: 'historical_candles',
    description:
      'Fetch historical OHLC candles from Upstox (NOT stored — use sync_candles to store). source=v2 interval is 1minute|30minute|day|week|month (no unit). source=v3 needs unit minutes|hours|days + a numeric interval string. to_date is required; from_date optional (omit for default lookback). Example: instrument_key="NSE_INDEX|Nifty 50", source="v3", interval="5", unit="minutes", to_date="2026-06-10", from_date="2026-06-01".',
    schema: z.object({
      instrument_key: z.string().min(1).describe('Upstox instrument key, e.g. "NSE_EQ|INE002A01018"'),
      source: z.enum(['v2', 'v3']).describe('Upstox historical API version'),
      interval: z
        .string()
        .min(1)
        .describe('v2: 1minute|30minute|day|week|month. v3: positive integer string e.g. "5"'),
      unit: z
        .enum(['minutes', 'hours', 'days'])
        .optional()
        .describe('Required when source=v3'),
      to_date: z.string().describe('End date, YYYY-MM-DD'),
      from_date: z.string().optional().describe('Start date, YYYY-MM-DD. Omit for default lookback.'),
    }),
  },
)

// 5) Intraday candles (v2 or v3).
export const intradayCandles = tool(
  async ({ instrument_key, source, interval, unit }) => {
    if (source === 'v3' && !unit) {
      return JSON.stringify({ error: 'unit is required when source=v3 (minutes|hours|days)' })
    }
    const path =
      source === 'v2'
        ? `/historical-data/v2/intraday/${enc(instrument_key)}/${enc(interval)}`
        : `/historical-data/v3/intraday/${enc(instrument_key)}/${unit}/${enc(interval)}`
    return apiCall('GET', path)
  },
  {
    name: 'intraday_candles',
    description:
      'Fetch intraday OHLC candles for the current trading day (NOT stored). source=v2 interval 1minute|30minute|day|week|month (no unit); source=v3 needs unit minutes|hours|days + numeric interval. Example: instrument_key="NSE_EQ|INE002A01018", source="v2", interval="30minute".',
    schema: z.object({
      instrument_key: z.string().min(1).describe('Upstox instrument key'),
      source: z.enum(['v2', 'v3']).describe('Upstox historical API version'),
      interval: z.string().min(1).describe('v2: 1minute|30minute|day|week|month. v3: numeric string e.g. "5"'),
      unit: z.enum(['minutes', 'hours', 'days']).optional().describe('Required when source=v3'),
    }),
  },
)

// 6) Option chain.
export const optionChain = tool(
  async ({ instrument_key, expiry_date }) =>
    apiCall('GET', '/option-chain/chain', { instrumentKey: instrument_key, expiryDate: expiry_date }),
  {
    name: 'option_chain',
    description:
      'Get the put/call option chain for an underlying instrument + expiry. Example: instrument_key="NSE_INDEX|Nifty 50", expiry_date="2026-06-26".',
    schema: z.object({
      instrument_key: z.string().min(1).describe('Underlying instrument key, e.g. "NSE_INDEX|Nifty 50"'),
      expiry_date: z.string().describe('Expiry date, YYYY-MM-DD'),
    }),
  },
)

// 7) Market status for an exchange.
export const marketStatus = tool(
  async ({ exchange }) => apiCall('GET', `/market-info/status/${enc(exchange)}`),
  {
    name: 'market_status',
    description:
      'Get the current market status (open/closed) for an exchange. Example: exchange="NSE".',
    schema: z.object({
      exchange: z.string().min(1).describe('Exchange code, e.g. "NSE"'),
    }),
  },
)
```

- [ ] **Step 3: Verify the tools load and one works**

Ensure `apps/api` is running on 3000. From `apps/deepagent`:

```bash
bun -e 'import("./src/tools/named").then(async m => console.log("tools:", [m.searchInstruments.name,m.getLtp.name,m.getOhlcQuote.name,m.historicalCandles.name,m.intradayCandles.name,m.optionChain.name,m.marketStatus.name].join(",")))'
```
Expected: `tools: search_instruments,get_ltp,get_ohlc_quote,historical_candles,intraday_candles,option_chain,market_status`

Then invoke one (light call):

```bash
bun -e 'import("./src/tools/named").then(async m => console.log(await m.searchInstruments.invoke({q:"NIFTY"})) )'
```
Expected: a JSON string with an array of instrument objects (or a `{"status":...,"error":...}` string — either is fine; it must NOT throw).

- [ ] **Step 4: Commit**

```bash
git add apps/deepagent/package.json bun.lock apps/deepagent/src/tools/named.ts
git commit -m "feat(deepagent): 7 market-data named tools"
```

---

### Task 3: append backtest + fundamentals + news named tools (4) to `tools/named.ts`

**Files:**
- Modify: `apps/deepagent/src/tools/named.ts` (append 4 tools + export them)

**Interfaces:**
- Consumes: `apiCall` from `./http`, `tool`/`z` already imported in the file.
- Produces: additional named exports `syncCandles`, `readCandles`, `companyProfile`, `news`.

- [ ] **Step 1: Append the 4 tools to the end of `apps/deepagent/src/tools/named.ts`**

```ts
// 8) Sync (fetch + store) historical candles to a per-fetch SQLite file.
export const syncCandles = tool(
  async ({ instrument_key, source, interval, unit, from_date, to_date }) => {
    if (source === 'v3' && !unit) {
      return JSON.stringify({ error: 'unit is required when source=v3 (minutes|hours|days)' })
    }
    return apiCall('POST', '/backtest/data/sync', undefined, {
      instrumentKey: instrument_key,
      source,
      interval,
      unit,
      fromDate: from_date,
      toDate: to_date,
    })
  },
  {
    name: 'sync_candles',
    description:
      'Fetch historical candles from Upstox and STORE them to a local SQLite file for later backtest reads. source=v2 interval 1minute|30minute|day|week|month (no unit); source=v3 needs unit minutes|hours|days + numeric interval. Returns {stored, chunks, file}. Example: instrument_key="NSE_INDEX|Nifty 50", source="v3", interval="5", unit="minutes", from_date="2026-06-01", to_date="2026-06-30".',
    schema: z.object({
      instrument_key: z.string().min(1).describe('Upstox instrument key, e.g. "NSE_INDEX|Nifty 50"'),
      source: z.enum(['v2', 'v3']).describe('Upstox API version'),
      interval: z.string().min(1).describe('v2: 1minute|30minute|day|week|month. v3: numeric string e.g. "5"'),
      unit: z.enum(['minutes', 'hours', 'days']).optional().describe('Required when source=v3'),
      from_date: z.string().describe('Start date YYYY-MM-DD'),
      to_date: z.string().describe('End date YYYY-MM-DD'),
    }),
  },
)

// 9) Read previously-STORED candles for a sub-range.
export const readCandles = tool(
  async ({ instrument_key, timeframe, from_date, to_date }) =>
    apiCall(
      'GET',
      `/backtest/data/candles/${enc(instrument_key)}/${enc(timeframe)}`,
      { fromDate: from_date, toDate: to_date },
    ),
  {
    name: 'read_candles',
    description:
      'Read previously-STORED historical candles (from a prior sync_candles) for a sub-range. timeframe is the canonical label: v2 raw (1minute|30minute|day|week|month) or v3 {interval}{unit} (e.g. 5minutes, 1days). Returns an array of {ts,open,high,low,close,volume}. 404 if no synced file covers the range. Example: instrument_key="NSE_INDEX|Nifty 50", timeframe="5minutes", from_date="2026-06-05", to_date="2026-06-10".',
    schema: z.object({
      instrument_key: z.string().min(1).describe('Upstox instrument key'),
      timeframe: z.string().min(1).describe('Canonical timeframe label, e.g. "5minutes", "1days", "day"'),
      from_date: z.string().describe('Start date YYYY-MM-DD'),
      to_date: z.string().describe('End date YYYY-MM-DD'),
    }),
  },
)

// 10) Company profile (fundamentals) by ISIN.
export const companyProfile = tool(
  async ({ isin }) => apiCall('GET', `/fundamentals/profile/${enc(isin)}`),
  {
    name: 'company_profile',
    description:
      'Get the company profile (fundamentals) for an ISIN. Example: isin="INE002A01018".',
    schema: z.object({
      isin: z.string().min(1).describe('ISIN code, e.g. "INE002A01018"'),
    }),
  },
)

// 11) Market news.
export const news = tool(
  async ({ category, instrument_keys }) => {
    if (category === 'instrument_keys' && !instrument_keys) {
      return JSON.stringify({ error: 'instrument_keys is required when category=instrument_keys' })
    }
    return apiCall('GET', '/news', { category, instrumentKeys: instrument_keys })
  },
  {
    name: 'news',
    description:
      'Get market news articles. category is instrument_keys|positions|holdings. When category=instrument_keys, pass instrument_keys (comma list). Example: category="instrument_keys", instrument_keys="NSE_EQ|INE002A01018".',
    schema: z.object({
      category: z.enum(['instrument_keys', 'positions', 'holdings']).describe('News category'),
      instrument_keys: z
        .string()
        .optional()
        .describe('Comma-separated instrument keys; required when category=instrument_keys'),
    }),
  },
)
```

- [ ] **Step 2: Verify the 4 new tools + a sync/read round-trip**

From `apps/deepagent` (API running on 3000):

```bash
bun -e 'import("./src/tools/named").then(async m => console.log([m.syncCandles.name,m.readCandles.name,m.companyProfile.name,m.news.name].join(",")))'
```
Expected: `sync_candles,read_candles,company_profile,news`

Sync a single day (light — 1 chunk) and read it back:

```bash
bun -e 'import("./src/tools/named").then(async m => { const s = await m.syncCandles.invoke({instrument_key:"NSE_INDEX|Nifty 50",source:"v3",interval:"5",unit:"minutes",from_date:"2026-06-09",to_date:"2026-06-09"}); console.log("sync:", s); const r = await m.readCandles.invoke({instrument_key:"NSE_INDEX|Nifty 50",timeframe:"5minutes",from_date:"2026-06-09",to_date:"2026-06-09"}); console.log("read:", r.slice(0,120)); })'
```
Expected: `sync: {"stored":...,"chunks":1,"file":"NSE_INDEX_Nifty 50-5minutes-2026-06-09-2026-06-09.sqlite"}` and `read: [{"ts":...},...]` (a JSON array). Must NOT throw.

- [ ] **Step 3: Commit**

```bash
git add apps/deepagent/src/tools/named.ts
git commit -m "feat(deepagent): backtest/fundamentals/news named tools (4)"
```

---

### Task 4: `tools/call-api.ts` — generic `call_api` tool + path list

**Files:**
- Create: `apps/deepagent/src/tools/call-api.ts`

**Interfaces:**
- Consumes: `apiCall` from `./http`, `tool` from `langchain`, `z` from `zod`.
- Produces: named export `callApiTool` (LangChain `Tool`).

- [ ] **Step 1: Create `apps/deepagent/src/tools/call-api.ts`**

```ts
import { tool } from 'langchain'
import { z } from 'zod'
import { apiCall } from './http'

// Hand-maintained list of endpoints NOT covered by a named tool, so the model knows
// what else it can call via call_api. Update when apps/api routes change.
const AVAILABLE_PATHS = `
Endpoints reachable via call_api (method GET|POST, path starts with "/", no query string — pass params via query/body). Dates are YYYY-MM-DD.
- GET /market-quote/v2/full?symbol=<comma list> — full market quote (v2, up to 500 symbols)
- GET /market-quote/v3/option-greek?instrumentKey=<comma list> — option greeks (v3, up to 500)
- GET /option-chain/contracts?instrumentKey=<key>&expiryDate=<YYYY-MM-DD> — option contracts (expiryDate optional)
- GET /market-info/timings/<YYYY-MM-DD> — exchange timings for a date (no auth)
- GET /market-info/holidays — holiday list for current year (no auth)
- GET /market-info/holidays/<YYYY-MM-DD> — holiday detail for a date (no auth)
- GET /market-info/change-oi?instrumentKey=<key>&expiry=<YYYY-MM-DD>&date=<YYYY-MM-DD>&interval=<number-of-days> — change in open interest
- GET /market-info/dii?dataType=NSE_EQ&interval=1D|1M&from=<YYYY-MM-DD> — DII activity
- GET /market-info/fii?dataType=<NSE_FO|NSE_EQ|CASH|INDEX_FUTURES|STOCK_FUTURES|INDEX_OPTIONS|STOCK_OPTIONS>&interval=1D|1M&from=<YYYY-MM-DD> — FII activity
- GET /market-info/oi?instrumentKey=<key>&expiry=<YYYY-MM-DD>&date=<YYYY-MM-DD> — open interest
- GET /market-info/max-pain?instrumentKey=<key>&expiry=<YYYY-MM-DD>&date=<YYYY-MM-DD>&bucketInterval=<minutes> — max pain
- GET /market-info/pcr?instrumentKey=<key>&expiry=<YYYY-MM-DD>&date=<YYYY-MM-DD>&bucketInterval=<minutes> — put-call ratio
- GET /market-info/smartlist/futures?assetType=<INDEX|STOCK|COMMODITY>&category=<TOP_TRADED|MOST_ACTIVE|OI_GAINERS|OI_LOSERS|PRICE_GAINERS|PRICE_LOSERS|PREMIUM|DISCOUNT>&pageNumber=<n>&pageSize=<n> — smartlist futures
- GET /market-info/smartlist/options?assetType=<INDEX|STOCK|COMMODITY>&category=<TOP_TRADED|MOST_ACTIVE|OI_GAINERS|OI_LOSERS|PRICE_GAINERS|PRICE_LOSERS|IV_GAINERS|IV_LOSERS|UNDER_5000|UNDER_10000>&pageNumber=<n>&pageSize=<n> — smartlist options
- GET /market-info/smartlist/mtf?pageNumber=<n>&pageSize=<n> — smartlist MTF stocks
- GET /fundamentals/balance-sheet/<isin>?type=<consolidated|standalone>&fs=<true|false> — balance sheet (isin like INE002A01018)
- GET /fundamentals/cash-flow/<isin>?type=<consolidated|standalone>&fs=<true|false> — cash flow
- GET /fundamentals/income-statement/<isin>?type=<consolidated|standalone>&timePeriod=<yearly|quarterly>&fs=<true|false> — income statement
- GET /fundamentals/key-ratios/<isin> — key financial ratios
- GET /fundamentals/share-holdings/<isin> — shareholding pattern
- GET /fundamentals/competitors/<instrumentKey> — competitors
- GET /fundamentals/corporate-actions/<isin> — corporate actions
- GET /expired-instruments/expiries?instrumentKey=<key> — expiry dates for an expired instrument
- GET /expired-instruments/future-contracts?instrumentKey=<key>&expiryDate=<YYYY-MM-DD> — expired futures
- GET /expired-instruments/option-contracts?instrumentKey=<key>&expiryDate=<YYYY-MM-DD> — expired options
- GET /expired-instruments/historical-candles/<expiredInstrumentKey>/<interval>/<toDate>/<fromDate> — expired instrument candles (interval 1minute|30minute|day|week|month)
- GET /stream/market-data-feed/authorize — authorized wss URI for market-data feed
- GET /stream/portfolio-stream-feed/authorize (header api-version required) — authorized URI for portfolio feed
- GET /stream/subscriptions — current global subscription state
- POST /stream/subscriptions body {method:"sub"|"unsub", data:{mode:"ltp"|"full"|"option_greeks"|"full_d30", instrumentKeys:[...]}} — add/remove stream subscriptions
`.trim()

export const callApiTool = tool(
  async ({ method, path, query, body }) => {
    if (!path.startsWith('/')) {
      return JSON.stringify({ error: 'path must start with "/"' })
    }
    return apiCall(method, path, query, body)
  },
  {
    name: 'call_api',
    description:
      `Call any trading-API endpoint that has no dedicated tool. Pass method (GET|POST), path (starts with "/", NO query string), query (object of params), and body (object, POST only). If you get a 400/422, read the error and retry with the correct params. Available paths:\n${AVAILABLE_PATHS}`,
    schema: z.object({
      method: z.enum(['GET', 'POST']).describe('HTTP method'),
      path: z
        .string()
        .min(1)
        .describe('Full path starting with "/", without query string, e.g. "/market-info/pcr"'),
      query: z
        .record(z.union([z.string(), z.number()]))
        .optional()
        .describe('Query params as an object, e.g. {instrumentKey:"NSE_INDEX|Nifty 50", expiry:"2026-06-26", date:"2026-06-10", bucketInterval:15}'),
      body: z.record(z.unknown()).optional().describe('Request body object (POST only)'),
    }),
  },
)
```

- [ ] **Step 2: Verify `call_api` against an obscure endpoint**

From `apps/deepagent` (API running):

```bash
bun -e 'import("./src/tools/call-api").then(async m => console.log(await m.callApiTool.invoke({method:"GET", path:"/market-info/holidays"})) )'
```
Expected: a JSON array of holidays (a string), NOT a thrown error. Also confirm a non-existent path returns an error string:

```bash
bun -e 'import("./src/tools/call-api").then(async m => console.log(await m.callApiTool.invoke({method:"GET", path:"/does-not-exist"})) )'
```
Expected: `{"status":404,"error":"..."}`.

- [ ] **Step 3: Commit**

```bash
git add apps/deepagent/src/tools/call-api.ts
git commit -m "feat(deepagent): generic call_api tool + endpoint path list"
```

---

### Task 5: `tools/index.ts` — export `allTools`

**Files:**
- Create: `apps/deepagent/src/tools/index.ts`

**Interfaces:**
- Consumes: the 11 named tools from `./named`, `callApiTool` from `./call-api`.
- Produces: `export const allTools: Tool[]` (length 12). Consumed by `agent.ts` in Task 6.

- [ ] **Step 1: Create `apps/deepagent/src/tools/index.ts`**

```ts
import {
  searchInstruments,
  getLtp,
  getOhlcQuote,
  historicalCandles,
  intradayCandles,
  optionChain,
  marketStatus,
  syncCandles,
  readCandles,
  companyProfile,
  news,
} from './named'
import { callApiTool } from './call-api'

// 11 curated named tools + 1 generic call_api = 12 tools total.
export const allTools = [
  searchInstruments,
  getLtp,
  getOhlcQuote,
  historicalCandles,
  intradayCandles,
  optionChain,
  marketStatus,
  syncCandles,
  readCandles,
  companyProfile,
  news,
  callApiTool,
]
```

- [ ] **Step 2: Verify the array length and names**

```bash
bun -e 'import("./src/tools").then(m => console.log(m.allTools.length, m.allTools.map(t => t.name).join(",")))'
```
Expected: `12 search_instruments,get_ltp,get_ohlc_quote,historical_candles,intraday_candles,option_chain,market_status,sync_candles,read_candles,company_profile,news,call_api`

- [ ] **Step 3: Commit**

```bash
git add apps/deepagent/src/tools/index.ts
git commit -m "feat(deepagent): export allTools (12)"
```

---

### Task 6: `agent.ts` + `.env.example` — agent factory + env docs

**Files:**
- Create: `apps/deepagent/src/agent.ts`
- Create: `apps/deepagent/.env.example`

**Interfaces:**
- Consumes: `allTools` from `./tools`, `createDeepAgent` from `deepagents`, `process.env.DEEPAGENT_MODEL`.
- Produces: `export async function buildAgent(): Promise<ReturnType<typeof createDeepAgent>>` and `export const SYSTEM_PROMPT: string`. Consumed by `src/index.ts` in Task 7.

- [ ] **Step 1: Create `apps/deepagent/src/agent.ts`**

```ts
import { createDeepAgent } from 'deepagents'
import { allTools } from './tools'

export const SYSTEM_PROMPT = `You are a trading assistant for the Indian stock market, backed by the local Upstox trading API.
Use the provided tools to answer the user's question.
- Instrument keys look like "NSE_EQ|INE002A01018" or "NSE_INDEX|Nifty 50". Use search_instruments if you don't know the key.
- Timeframes are canonical labels: v2 raw (1minute, 30minute, day, week, month) or v3 {interval}{unit} (e.g. 5minutes, 1days).
- Dates are YYYY-MM-DD.
- To store candles for a backtest, use sync_candles; to read stored candles, use read_candles.
- If a tool returns an error object, read it and retry with corrected parameters.
- If the API is unreachable, tell the user to start apps/api (bun run dev in apps/api).
Be concise. Prefer tools over guessing.`

export async function buildAgent() {
  const model = process.env.DEEPAGENT_MODEL
  if (!model) {
    throw new Error(
      'Set DEEPAGENT_MODEL in apps/deepagent/.env (e.g. "anthropic:claude-sonnet-4-6" or "openai:gpt-4o-mini")',
    )
  }
  return createDeepAgent({ model, tools: allTools, systemPrompt: SYSTEM_PROMPT })
}
```

- [ ] **Step 2: Create `apps/deepagent/.env.example`**

```
# LLM provider + model (provider-prefixed). Examples:
DEEPAGENT_MODEL=anthropic:claude-sonnet-4-6
# DEEPAGENT_MODEL=openai:gpt-4o-mini

# API key matching the model prefix above:
ANTHROPIC_API_KEY=
# OPENAI_API_KEY=

# Trading API base URL (default http://localhost:3000):
# API_BASE_URL=http://localhost:3000
```

- [ ] **Step 3: Verify `buildAgent` works with a model set (no LLM key needed yet — the key is checked at invoke, not at creation)**

From `apps/deepagent`:

```bash
DEEPAGENT_MODEL=anthropic:claude-sonnet-4-6 bun -e 'import("./src/agent").then(async m => { const a = await m.buildAgent(); console.log("agent built:", typeof a, "has invoke:", typeof a?.invoke) })'
```
Expected: `agent built: object has invoke: function`. (The provider key is NOT required for `createDeepAgent` — only at `invoke` time.)

Also verify the missing-model guard:

```bash
bun -e 'import("./src/agent").then(async m => { try { await m.buildAgent() } catch (e) { console.log("threw:", e.message) } })'
```
Expected: `threw: Set DEEPAGENT_MODEL in apps/deepagent/.env ...`

- [ ] **Step 4: Commit**

```bash
git add apps/deepagent/src/agent.ts apps/deepagent/.env.example
git commit -m "feat(deepagent): agent factory + system prompt + .env.example"
```

---

### Task 7: `index.ts` — CLI REPL + end-to-end verify

**Files:**
- Modify: `apps/deepagent/src/index.ts` (replace the placeholder)

**Interfaces:**
- Consumes: `buildAgent` from `./agent`, `node:readline/promises`, `node:process`.

- [ ] **Step 1: Replace `apps/deepagent/src/index.ts` with the CLI REPL**

```ts
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { buildAgent } from './agent'

async function main() {
  const agent = await buildAgent()
  console.log('deepagent ready. Type a question (empty line or "exit" to quit).')
  const rl = readline.createInterface({ input, output })
  while (true) {
    const line = (await rl.question('\n> ')).trim()
    if (!line || line.toLowerCase() === 'exit') break
    try {
      const result = await agent.invoke({
        messages: [{ role: 'user', content: line }],
      })
      const msgs = (result?.messages ?? []) as Array<{ content?: unknown }>
      const last = msgs[msgs.length - 1]
      const text =
        typeof last?.content === 'string'
          ? last.content
          : last?.content
            ? JSON.stringify(last.content)
            : '(no output)'
      console.log(text)
    } catch (err: any) {
      console.error('Agent error:', err?.message ?? String(err))
    }
  }
  rl.close()
}

main()
```

- [ ] **Step 2: Verify end-to-end with a real LLM key**

Set up `apps/deepagent/.env` with a valid `DEEPAGENT_MODEL` + the matching `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`). Ensure `apps/api` is running on 3000 (with `UPSTOX_ACCESS_TOKEN`).

Run:
```bash
cd apps/deepagent && bun run src/index.ts
```
At the `> ` prompt, type: `What's the LTP of NSE_EQ|INE002A01018?`
Expected: the agent calls `get_ltp` and prints the last traded price (a short natural-language answer citing the price).

Next: `Fetch Nifty 5min candles for 2026-06-01 to 2026-06-30 and store them.`
Expected: the agent calls `sync_candles` and reports `{stored, chunks, file}`.

Next: `Read the stored Nifty 5minutes candles for 2026-06-05 to 2026-06-10.`
Expected: the agent calls `read_candles` and summarizes the returned candles.

Next (obscure → should use `call_api`): `What's the max pain for NIFTY expiring 2026-06-26 on 2026-06-10?`
Expected: the agent calls `call_api` with `path:"/market-info/max-pain"` and the right query, and reports the result (or a clear error if no data).

Type `exit` to quit.

If no LLM key is available: skip the interactive end-to-end; instead verify the REPL boots and exits cleanly using a dummy model that will fail only on invoke:
```bash
DEEPAGENT_MODEL=anthropic:claude-sonnet-4-6 bun run src/index.ts
```
Type `hello` → expect `Agent error: ...` (provider key error, NOT a crash/throw that kills the process). Type `exit` → quits cleanly. This confirms the REPL loop and error handling work without a key.

- [ ] **Step 3: Commit**

```bash
git add apps/deepagent/src/index.ts
git commit -m "feat(deepagent): CLI REPL agent entrypoint + e2e verify"
```

---

## Notes for the implementer

- All `bun -e` verify commands assume the shell cwd is `apps/deepagent`. Run `cd apps/deepagent` first, or use absolute paths.
- The API must be running (`cd apps/api && bun run dev`, port 3000) with `UPSTOX_ACCESS_TOKEN` set for any tool verify that hits Upstox-backed routes. `/market-info/holidays` and `/instruments/search` are light and good first checks.
- `encodeURIComponent` is used on every path param so instrument keys containing `|` or spaces (`NSE_INDEX|Nifty 50`) are safely URL-encoded; Elysia decodes them back.
- Tools return **strings**, not objects — the agent reads the JSON. Never return a thrown error.
- If `createDeepAgent`'s result shape differs (no `messages` array), adjust the final-message extraction in `index.ts` Task 7 — but only after observing the actual `result` shape during verify; print `JSON.stringify(Object.keys(result))` to inspect if needed.