# Backtest Historical-Candle Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist Upstox historical candles into the local SQLite DB (deduped) and expose read endpoints so backtests consume local data instead of calling Upstox each run.

**Architecture:** A new `candles` Drizzle table with a unique index on `(instrumentKey, timeframe, ts)` powers idempotent upserts. A new `backtest-data` Elysia module provides `POST /backtest/data/sync` (fetches from Upstox with date-range chunking, normalizes, bulk-upserts) and `GET /backtest/data/candles/:instrumentKey/:timeframe` (reads from local DB). Pure helpers live in a co-located `lib.ts` with no side-effecting imports so they can be verified in isolation.

**Tech Stack:** Elysia, Drizzle ORM + Drizzle Kit (SQLite / bun:sqlite), upstox-js-sdk, TypeBox, Bun.

## Global Constraints

- **Language/runtime:** Bun 1.3.14. Run all `bun` commands from `apps/api` (the package scripts and `./sqlite.db` path are relative to it).
- **DB:** SQLite at `apps/api/sqlite.db`, managed by Drizzle Kit. Schema source of truth: `apps/api/src/db/schema.ts`. Apply changes with `bun db:push`.
- **Dependencies:** Add any new deps with `bun add` (never hand-edit `package.json`). This plan adds **no** new dependencies — `drizzle-orm`, `elysia`, `upstox-js-sdk` are already present.
- **Upstox auth:** Requires `UPSTOX_ACCESS_TOKEN` env var (see `apps/api/src/config/upstox.ts`). Live verification of the sync endpoint needs a valid token; without it, sync returns 502.
- **No git:** This repo is not a git repository. Skip all commit steps — replace each "Commit" step with a verification checkpoint (already reflected below).
- **No test runner:** The spec scoped out `bun:test`. Verification is manual via `bun -e` checks (pure functions) and `curl` against a running server (endpoints).
- **Existing patterns:** Follow the existing module pattern in `apps/api/src/modules/historical-data/index.ts` (promisified `call()`, `toPlain()`, `upstoxError()`). Do **not** modify the working `historical-data` routes.
- **TypeBox gotcha (from project memory):** Never use boolean `exclusiveMinimum` on TypeBox schemas — it crashes route compile. Not used here, but keep in mind.

## File Structure

- **Modify:** `apps/api/src/db/schema.ts` — add `candles` table + `Candle`/`NewCandle` types.
- **Create:** `apps/api/src/modules/backtest-data/lib.ts` — pure helpers (no DB/Upstox imports): `timeframeLabel`, `toEpochMs`, `toDateString`, `chunkSizeMs`, `chunkRange`, `normalizeCandles`, and the `NewCandleRow` type.
- **Create:** `apps/api/src/modules/backtest-data/index.ts` — Elysia module `backtestData` with `POST /backtest/data/sync` and `GET /backtest/data/candles/:instrumentKey/:timeframe`. Imports `lib.ts`, `db`, `schema`, `UpstoxClient`.
- **Modify:** `apps/api/src/index.ts` — register `.use(backtestData)`.

---

## Task 1: Add `candles` table to the schema and apply the migration

**Files:**
- Modify: `apps/api/src/db/schema.ts` (append after the `users` table)

**Interfaces:**
- Produces: `candles` table object, `Candle` (select) and `NewCandle` (insert) types, and a unique index `candles_inst_tf_ts_idx` on `(instrumentKey, timeframe, ts)`.

- [ ] **Step 1: Append the `candles` table to `schema.ts`**

Add this import (replace the existing first line) and the table + types at the end of `apps/api/src/db/schema.ts`:

```ts
import { sqliteTable, text, integer, real, uniqueIndex } from 'drizzle-orm/sqlite-core'
```

Append after the `users` block:

```ts
// Local historical-candle store for backtesting. Populated by the
// backtest-data module's /backtest/data/sync endpoint (fetched from Upstox).
// The unique index on (instrumentKey, timeframe, ts) makes re-syncing an
// overlapping range idempotent (onConflictDoNothing upserts).
export const candles = sqliteTable(
  'candles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    instrumentKey: text('instrument_key').notNull(),
    // v2: raw Upstox interval ('1minute','30minute','day','week','month').
    // v3: composed as '{interval}{unit}' e.g. '1minutes', '1days'.
    timeframe: text('timeframe').notNull(),
    ts: integer('ts').notNull(), // candle open time, epoch ms
    open: real('open').notNull(),
    high: real('high').notNull(),
    low: real('low').notNull(),
    close: real('close').notNull(),
    volume: integer('volume'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    instTfTsIdx: uniqueIndex('candles_inst_tf_ts_idx').on(t.instrumentKey, t.timeframe, t.ts),
  }),
)

export type Candle = typeof candles.$inferSelect
export type NewCandle = typeof candles.$inferInsert
```

- [ ] **Step 2: Apply the schema to the SQLite DB**

Run:
```bash
cd apps/api && bun db:push
```
Expected: Drizzle Kit prints a plan that adds the `candles` table + the `candles_inst_tf_ts_idx` unique index, then `Done` / no error. It should not prompt (adding a new table is non-destructive).

- [ ] **Step 3: Verify the table exists in SQLite**

Run:
```bash
cd apps/api && bun -e "import{Database}from'bun:sqlite';const db=new Database('./sqlite.db');console.log(db.query(\"select name from sqlite_master where type='index' and tbl_name='candles'\").all());console.log(db.query('pragma table_info(candles)').all())"
```
Expected: prints the `candles_inst_tf_ts_idx` index row and the 9 columns (`id`, `instrument_key`, `timeframe`, `ts`, `open`, `high`, `low`, `close`, `volume`, `created_at`).

- [ ] **Checkpoint:** Table + unique index confirmed in `sqlite.db`. (No git commit — repo is not under version control.)

---

## Task 2: Pure helpers — timeframe labeling + date utilities + chunker

**Files:**
- Create: `apps/api/src/modules/backtest-data/lib.ts`

**Interfaces:**
- Produces (all exported from `lib.ts`):
  - `timeframeLabel(source: 'v2' | 'v3', interval: string, unit?: string): string`
  - `toEpochMs(v: string | number): number`
  - `toDateString(ms: number): string` — `YYYY-MM-DD` (UTC) for Upstox date params
  - `chunkSizeMs(timeframe: string): number`
  - `chunkRange(fromMs: number, toMs: number, sizeMs: number): Array<[number, number]>`
- No imports from `db` or `upstox` — pure module, safe to import for verification.

- [ ] **Step 1: Create `lib.ts` with the date/timeframe helpers and chunker**

Create `apps/api/src/modules/backtest-data/lib.ts`:

```ts
// Pure helpers for the backtest-data module. No DB / Upstox imports so this
// module is safe to import for unit verification without side effects.

const DAY = 86_400_000 // ms

/** Canonical timeframe label stored in the candles table. */
export function timeframeLabel(
  source: 'v2' | 'v3',
  interval: string,
  unit?: string,
): string {
  // v2: raw interval string ('1minute','30minute','day','week','month').
  // v3: composed as '{interval}{unit}' ('1minutes','1days', ...).
  if (source === 'v2') return interval
  return `${interval}${unit}`
}

/** Coerce an Upstox candle timestamp (ISO string or epoch number) to epoch ms. */
export function toEpochMs(v: string | number): number {
  if (typeof v === 'number') {
    // Upstox sometimes returns seconds; anything below year-2001 in ms is seconds.
    return v > 1e12 ? v : v * 1000
  }
  return new Date(v).getTime()
}

/** Epoch ms -> 'YYYY-MM-DD' (UTC) for Upstox from_date / to_date params. */
export function toDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Chunk size (ms) for a timeframe, matching Upstox per-call lookback limits. */
export function chunkSizeMs(timeframe: string): number {
  // minute-level -> 1 month
  if (timeframe === '1minute') return 30 * DAY
  const minuteMatch = /^(\d+)minutes$/.exec(timeframe)
  if (minuteMatch && Number(minuteMatch[1]) <= 60) return 30 * DAY
  // 30min / hour / day -> 1 year
  if (
    timeframe === '30minute' ||
    timeframe === 'day' ||
    /hours$/.test(timeframe) ||
    /days$/.test(timeframe)
  ) {
    return 365 * DAY
  }
  // week / month -> 10 years
  if (timeframe === 'week' || timeframe === 'month') return 10 * 365 * DAY
  // unknown -> safe default 1 year
  return 365 * DAY
}

/** Split [fromMs, toMs] into contiguous chunks of <= sizeMs. */
export function chunkRange(
  fromMs: number,
  toMs: number,
  sizeMs: number,
): Array<[number, number]> {
  if (toMs < fromMs) return []
  const chunks: Array<[number, number]> = []
  let cur = fromMs
  while (cur <= toMs) {
    const end = Math.min(cur + sizeMs, toMs)
    chunks.push([cur, end])
    if (end === toMs) break
    cur = end + 1
  }
  return chunks
}
```

- [ ] **Step 2: Verify the helpers with `bun -e`**

Run:
```bash
cd apps/api && bun -e "import{timeframeLabel,toDateString,chunkSizeMs,chunkRange}from'./src/modules/backtest-data/lib.ts';console.log(timeframeLabel('v2','1minute'));console.log(timeframeLabel('v3','1','days'));console.log(toDateString(Date.UTC(2026,5,1)));console.log(chunkSizeMs('1minute'),chunkSizeMs('day'),chunkSizeMs('week'));console.log(chunkRange(Date.UTC(2026,0,1),Date.UTC(2026,11,31),chunkSizeMs('day')).length)"
```
Expected output:
```
1minute
1days
2026-06-01
2592000000 31536000000 315360000000
1
```
(1-month chunk for `1minute` covers all of 2026 in one chunk for `day`; `chunkRange` returns 1 chunk because a 1-year chunk spans the whole year.)

- [ ] **Checkpoint:** All five helpers behave as specified.

---

## Task 3: Normalizer — observe Upstox shape, then write `normalizeCandles`

**Files:**
- Modify: `apps/api/src/modules/backtest-data/lib.ts` (append `normalizeCandles` + `NewCandleRow` type)

**Interfaces:**
- Produces:
  - `NewCandleRow` type: `{ instrumentKey: string; timeframe: string; ts: number; open: number; high: number; low: number; close: number; volume: number | null }`
  - `normalizeCandles(raw: unknown, instrumentKey: string, timeframe: string): NewCandleRow[]`

- [ ] **Step 1: Observe the real Upstox candle response shape**

The existing `historical-data` module already proxies Upstox unchanged. Inspect its output for one instrument so the normalizer matches reality.

Run (requires `UPSTOX_ACCESS_TOKEN` set; if unset, rely on the documented array shape used in Step 2):
```bash
cd apps/api && UPSTOX_ACCESS_TOKEN="$UPSTOX_ACCESS_TOKEN" bun src/index.ts &
sleep 2
curl -s "http://localhost:3000/historical-data/v2/candles/NSE_EQ%7CINE002A01018/day/2026-06-30?fromDate=2026-06-01" | head -c 600
kill %1
```
Expected: JSON with a `data.candles` array. Each entry is an array like `["2026-06-01T09:15:00+05:30", 123.4, 124.0, 123.0, 123.7, 1000]` (v2). Note the actual element shape for use in Step 2.

- [ ] **Step 2: Append `normalizeCandles` to `lib.ts`**

Append to `apps/api/src/modules/backtest-data/lib.ts`:

```ts
export type NewCandleRow = {
  instrumentKey: string
  timeframe: string
  ts: number
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

/**
 * Normalize an Upstox historical-candle response into DB insert rows.
 * Handles both the array shape (v2 and v3: [timestamp, o, h, l, c, volume])
 * and an object shape (defensive). `raw` is the full parsed response.
 */
export function normalizeCandles(
  raw: unknown,
  instrumentKey: string,
  timeframe: string,
): NewCandleRow[] {
  const list = (raw as any)?.data?.candles
  if (!Array.isArray(list)) return []
  const rows: NewCandleRow[] = []
  for (const c of list) {
    let ts: number
    let o: number, h: number, l: number, cl: number
    let v: number | null
    if (Array.isArray(c)) {
      ts = toEpochMs(c[0])
      o = +c[1]
      h = +c[2]
      l = +c[3]
      cl = +c[4]
      v = c[5] == null ? null : +c[5]
    } else {
      ts = toEpochMs((c as any).timestamp ?? (c as any).ts)
      o = +(c as any).open
      h = +(c as any).high
      l = +(c as any).low
      cl = +(c as any).close
      v = (c as any).volume == null ? null : +(c as any).volume
    }
    rows.push({ instrumentKey, timeframe, ts, open: o, high: h, low: l, close: cl, volume: v })
  }
  return rows
}
```

- [ ] **Step 3: Verify `normalizeCandles` with `bun -e`**

Run:
```bash
cd apps/api && bun -e "import{normalizeCandles}from'./src/modules/backtest-data/lib.ts';const r=normalizeCandles({data:{candles:[['2026-06-01T09:15:00+05:30',123.4,124,123,123.7,1000],['2026-06-02T09:15:00+05:30',124,125,123.5,124.5,2000]]}},'NSE_EQ|INE002A01018','day');console.log(r.length);console.log(r[0].ts>0,r[0].open,r[0].close,r[0].volume);console.log(r[1].volume)"
```
Expected output:
```
2
true 123.4 123.7 1000
2000
```

- [ ] **Checkpoint:** Normalizer turns a sample Upstox response into 2 correct `NewCandleRow` objects with positive epoch-ms timestamps and numeric OHLCV.

---

## Task 4: `backtest-data` module scaffold + read endpoint + register in app

**Files:**
- Create: `apps/api/src/modules/backtest-data/index.ts`
- Modify: `apps/api/src/index.ts` (register the module)

**Interfaces:**
- Consumes: `candles` table + `Candle`/`NewCandle` from `apps/api/src/db/schema.ts`; `db` from `apps/api/src/db/index.ts`; `UpstoxClient` from `apps/api/src/config/upstox.ts`; all helpers from `./lib.ts`.
- Produces: an Elysia instance named `'backtest-data'` exporting `backtestData`, with route `GET /backtest/data/candles/:instrumentKey/:timeframe`.

- [ ] **Step 1: Create the module file with helpers + the read endpoint**

Create `apps/api/src/modules/backtest-data/index.ts`:

```ts
import { Elysia, t } from 'elysia'
import { and, eq, between, asc } from 'drizzle-orm'
import { db } from '../../db'
import { candles } from '../../db/schema'
import { UpstoxClient } from '../../config/upstox'
import {
  timeframeLabel,
  toDateString,
  toEpochMs,
  chunkSizeMs,
  chunkRange,
  normalizeCandles,
} from './lib'

const v2 = new UpstoxClient.HistoryApi()
const v3 = new UpstoxClient.HistoryV3Api()

/** Promisify an SDK callback-style call. */
function call<T>(fn: (cb: (err: any, data: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) =>
    fn((err, data) => (err ? reject(err) : resolve(data))),
  )
}

// SDK responses are class instances; Elysia only serializes plain objects.
const toPlain = <T>(v: T): T => JSON.parse(JSON.stringify(v))

function upstoxError(err: any, label: string) {
  return {
    message: `Upstox ${label} failed`,
    error: err?.response?.body ?? err?.message ?? String(err),
  }
}

export const backtestData = new Elysia({ name: 'backtest-data' })
  // ── GET /backtest/data/candles/:instrumentKey/:timeframe
  // Read locally stored candles for a date range (backtests consume this).
  .get(
    '/backtest/data/candles/:instrumentKey/:timeframe',
    async ({ params, query, status }) => {
      const fromMs = new Date(query.fromDate).getTime()
      const toMs = new Date(query.toDate).getTime()
      if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
        return status(400, { message: 'fromDate / toDate must be valid YYYY-MM-DD' })
      }
      if (toMs < fromMs) {
        return status(400, { message: 'toDate must be >= fromDate' })
      }
      const rows = await db
        .select({
          ts: candles.ts,
          open: candles.open,
          high: candles.high,
          low: candles.low,
          close: candles.close,
          volume: candles.volume,
        })
        .from(candles)
        .where(
          and(
            eq(candles.instrumentKey, params.instrumentKey),
            eq(candles.timeframe, params.timeframe),
            between(candles.ts, fromMs, toMs),
          ),
        )
        .orderBy(asc(candles.ts))
      return rows
    },
    {
      params: t.Object({
        instrumentKey: t.String({ minLength: 1 }),
        timeframe: t.String({ minLength: 1 }),
      }),
      query: t.Object({
        fromDate: t.String({ format: 'date' }),
        toDate: t.String({ format: 'date' }),
      }),
      detail: {
        summary: 'Read stored historical candles (for backtests)',
        description:
          'Returns candles previously persisted by POST /backtest/data/sync. Reads only from the local DB (no Upstox call). `timeframe` is the canonical label: v2 raw (1minute/30minute/day/week/month) or v3 `{interval}{unit}` (e.g. 1minutes, 1days).',
        tags: ['Backtest Data'],
      },
    },
  )
```

Note: this intermediate file imports only what the read route uses (`and`, `eq`, `between`, `asc`). Task 5 adds `sql` to the `drizzle-orm` import when the sync route needs `count(*)`.

- [ ] **Step 2: Register the module in the app**

In `apps/api/src/index.ts`, add the import (after the `stream` import, line 11):

```ts
import { backtestData } from './modules/backtest-data'
```

And add `.use(backtestData)` in the chain (after `.use(stream)`, before `.get('/', ...)`):

```ts
  .use(stream)
  .use(backtestData)
  .get('/', () => 'Hello from Harnesh Trading API')
```

- [ ] **Step 3: Start the server and verify the read endpoint returns `[]`**

Start the API (run in a separate terminal, or background it):
```bash
cd apps/api && bun src/index.ts
```
In another terminal:
```bash
curl -s "http://localhost:3000/backtest/data/candles/NSE_EQ%7CINE002A01018/day?fromDate=2026-01-01&toDate=2026-12-31"
```
Expected: `[]` (table is empty). Also confirm `http://localhost:3000/swagger` shows a `Backtest Data` tag with the read endpoint.

Stop the server (`Ctrl+C` or `kill %1`).

- [ ] **Checkpoint:** Module wired in; read route registered and returns `200 []` from the local DB.

---

## Task 5: Sync endpoint — fetch from Upstox, chunk, upsert, and verify end-to-end

**Files:**
- Modify: `apps/api/src/modules/backtest-data/index.ts` (add `POST /backtest/data/sync`, remove the `void sql` placeholder)

**Interfaces:**
- Consumes: all `lib.ts` helpers; `db.insert(candles).values(...).onConflictDoNothing(...)`; `sql` for `count(*)`.
- Produces: route `POST /backtest/data/sync` returning `{ stored, chunks, totalCandles }`.

- [ ] **Step 1: Add `sql` to the drizzle-orm import**

In `apps/api/src/modules/backtest-data/index.ts`, change the drizzle-orm import line from:
```ts
import { and, eq, between, asc } from 'drizzle-orm'
```
to:
```ts
import { and, eq, between, asc, sql } from 'drizzle-orm'
```

- [ ] **Step 2: Add the sync route**

Append the `.post(...)` chain to the `backtestData` Elysia instance in `apps/api/src/modules/backtest-data/index.ts` (after the `.get(...)` read route, before the closing — keep it as a chained call):

```ts
  // ── POST /backtest/data/sync
  // Fetch historical candles from Upstox for an instrument + timeframe + range,
  // chunk the range to respect Upstox per-call lookback limits, normalize, and
  // bulk-upsert into the local candles table (idempotent via the unique index).
  .post(
    '/backtest/data/sync',
    async ({ body, status }) => {
      const { instrumentKey, source, interval, unit, fromDate, toDate, upstoxApiVersion } = body
      if (source === 'v3' && !unit) {
        return status(422, { message: 'unit is required when source is v3' })
      }
      const fromMs = new Date(fromDate).getTime()
      const toMs = new Date(toDate).getTime()
      if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
        return status(400, { message: 'fromDate / toDate must be valid YYYY-MM-DD' })
      }
      if (toMs < fromMs) {
        return status(400, { message: 'toDate must be >= fromDate' })
      }

      const tf = timeframeLabel(source, interval, unit)
      const sizeMs = chunkSizeMs(tf)
      const chunks = chunkRange(fromMs, toMs, sizeMs)
      let attempted = 0

      try {
        for (const [cFrom, cTo] of chunks) {
          const toStr = toDateString(cTo)
          const fromStr = toDateString(cFrom)
          const raw =
            source === 'v2'
              ? await call((cb) =>
                  v2.getHistoricalCandleData1(
                    instrumentKey,
                    interval,
                    toStr,
                    fromStr,
                    upstoxApiVersion ?? '2.0',
                    cb,
                  ),
                )
              : await call((cb) =>
                  v3.getHistoricalCandleData1(
                    instrumentKey,
                    unit!,
                    interval,
                    toStr,
                    fromStr,
                    cb,
                  ),
                )
          const rows = normalizeCandles(toPlain(raw), instrumentKey, tf)
          if (rows.length) {
            await db
              .insert(candles)
              .values(rows)
              .onConflictDoNothing({
                target: [candles.instrumentKey, candles.timeframe, candles.ts],
              })
            attempted += rows.length
          }
        }

        // Authoritative count of rows now in DB for this instrument + timeframe + range.
        const [{ count }] = await db
          .select({ count: sql<number>`count(*)` })
          .from(candles)
          .where(
            and(
              eq(candles.instrumentKey, instrumentKey),
              eq(candles.timeframe, tf),
              between(candles.ts, fromMs, toMs),
            ),
          )

        return { stored: attempted, chunks: chunks.length, totalCandles: count }
      } catch (err: any) {
        return status(502, upstoxError(err, 'historical candle sync'))
      }
    },
    {
      body: t.Object({
        instrumentKey: t.String({ minLength: 1 }),
        source: t.Union([t.Literal('v2'), t.Literal('v3')]),
        interval: t.String({ minLength: 1 }),
        unit: t.Optional(
          t.Union([t.Literal('minutes'), t.Literal('hours'), t.Literal('days')]),
        ),
        fromDate: t.String({ format: 'date' }),
        toDate: t.String({ format: 'date' }),
        upstoxApiVersion: t.Optional(t.String()),
      }),
      detail: {
        summary: 'Fetch + store historical candles (Upstox -> DB)',
        description:
          'Fetches candles from Upstox for the given instrument + timeframe + date range, chunks the range to respect Upstox lookback limits, and upserts them into the local DB (idempotent — re-syncing an overlapping range does not duplicate rows). `source` selects v2 or v3 Upstox API; for v3, `unit` is required. Returns `stored` (rows attempted this call), `chunks` (number of Upstox calls), and `totalCandles` (rows now in DB for this range).',
        tags: ['Backtest Data'],
      },
    },
  )
```

- [ ] **Step 3: Typecheck**

Run:
```bash
cd apps/api && bunx tsc --noEmit
```
Expected: no errors. (If `bunx tsc` is unavailable, run `bun src/index.ts` and confirm it boots without a compile error, then stop it.)

- [ ] **Step 4: End-to-end verification — sync (v2), read back, re-sync (dedup)**

Start the server (needs `UPSTOX_ACCESS_TOKEN`):
```bash
cd apps/api && bun src/index.ts
```

Sync one month of daily candles (v2):
```bash
curl -s -X POST http://localhost:3000/backtest/data/sync \
  -H 'Content-Type: application/json' \
  -d '{"instrumentKey":"NSE_EQ|INE002A01018","source":"v2","interval":"day","fromDate":"2026-05-01","toDate":"2026-05-31"}'
```
Expected: `{"stored":<N>,"chunks":1,"totalCandles":<N>}` where `N` is the number of trading days in May 2026 (~20). `stored` and `totalCandles` match on the first sync.

Read them back from the local DB (no Upstox call):
```bash
curl -s "http://localhost:3000/backtest/data/candles/NSE_EQ%7CINE002A01018/day?fromDate=2026-05-01&toDate=2026-05-31"
```
Expected: a JSON array of ~20 candle objects `{ ts, open, high, low, close, volume }`, ordered by `ts` ascending.

Re-sync the same range — dedup must hold:
```bash
curl -s -X POST http://localhost:3000/backtest/data/sync \
  -H 'Content-Type: application/json' \
  -d '{"instrumentKey":"NSE_EQ|INE002A01018","source":"v2","interval":"day","fromDate":"2026-05-01","toDate":"2026-05-31"}'
```
Expected: `{"stored":<N>,"chunks":1,"totalCandles":<N>}` — `totalCandles` is unchanged (no duplicate rows; the unique index + `onConflictDoNothing` upsert).

- [ ] **Step 5: Verify the v3 path**

Sync the same range via v3 (`unit: 'days'`, `interval: '1'`), which stores under timeframe `1days` (separate rows from the v2 `day` timeframe):
```bash
curl -s -X POST http://localhost:3000/backtest/data/sync \
  -H 'Content-Type: application/json' \
  -d '{"instrumentKey":"NSE_EQ|INE002A01018","source":"v3","interval":"1","unit":"days","fromDate":"2026-05-01","toDate":"2026-05-31"}'
```
Expected: `{"stored":<N>,"chunks":1,"totalCandles":<N>}`.

Read it back under the v3 timeframe label:
```bash
curl -s "http://localhost:3000/backtest/data/candles/NSE_EQ%7CINE002A01018/1days?fromDate=2026-05-01&toDate=2026-05-31"
```
Expected: a JSON array of ~20 candles, distinct from (and not deduped against) the v2 `day` rows because the `timeframe` column differs.

Verify the v3-without-unit guard:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/backtest/data/sync \
  -H 'Content-Type: application/json' \
  -d '{"instrumentKey":"NSE_EQ|INE002A01018","source":"v3","interval":"1","fromDate":"2026-05-01","toDate":"2026-05-31"}'
```
Expected: `422`.

Stop the server.

- [ ] **Checkpoint:** v2 sync stores + dedups; v3 sync stores under its own timeframe; read returns ordered local candles; v3-without-unit returns 422. Feature complete and verified end-to-end.

---

## Self-Review Notes (completed)

- **Spec coverage:** schema table + unique index (Task 1); timeframe labeling, normalization, chunker (Tasks 2–3); ingestion `POST /backtest/data/sync` with chunking, upsert, v2+v3, v3-without-unit guard, 502/422/400 errors (Task 5); read `GET /backtest/data/candles/:instrumentKey/:timeframe` (Task 4); wiring + Swagger tag (Task 4). All spec sections covered.
- **Placeholder scan:** none. Every code step contains full code; every verify step contains exact commands and expected output.
- **Type consistency:** `NewCandleRow` (lib.ts) matches the `candles` table insert shape; `timeframeLabel` output feeds both `normalizeCandles` and the sync/read `timeframe` param; `chunkRange` returns `[number, number]` consumed as epoch-ms in the sync loop; `toDateString` feeds Upstox `fromStr`/`toStr`. Names match across tasks.
- **Deviations from spec:** added `lib.ts` (pure helpers) alongside `index.ts` for isolated verification — within the spirit of the spec's single-module-entry note and improves testability. No other deviations.