# Backtest Historical-Candle Store — Design

**Date:** 2026-07-07
**Status:** Approved (brainstorm)
**Scope:** Local historical-candle storage for backtesting. Live-feed recording and
live paper-trading are explicitly out of scope and will be separate specs.

## Goal

Give backtests a fast, replayable local source of market data by fetching
historical candles from Upstox once and persisting them to the local SQLite DB,
deduped, then reading them back without hitting Upstox during backtest runs.

## Background

The API already wraps Upstox historical endpoints (`apps/api/src/modules/historical-data`),
exposing v2 and v3 candle APIs. The DB (`apps/api/src/db/schema.ts`) currently holds
only a `users` table. Backtests currently have no local data store and would need to
call Upstox repeatedly — slow and rate-limited.

## Non-goals

- Strategy engine / backtest runner (strategy source TBD in a later spec).
- Live feed recording (tick persistence).
- Live paper-trading.
- Refactoring the existing working `historical-data` routes (optional shared-helper
  extraction noted, not required).

## Architecture

A new `backtest-data` Elysia module registered in `apps/api/src/index.ts`, with one
new Drizzle table `candles`. Two endpoints:

1. **Ingestion** — `POST /backtest/data/sync`: server fetches candles from Upstox for
   a given instrument + timeframe + date range, chunks the range to respect Upstox
   lookback limits, normalizes, and bulk-upserts into `candles`. Idempotent on re-sync.
2. **Read** — `GET /backtest/data/candles/:instrumentKey/:timeframe`: returns stored
   candles from local DB for a date range. This is what backtests consume.

The ingestion path duplicates the small Upstox `call()`/`toPlain()` fetch pattern already
present in `historical-data/index.ts` (~10 lines). A shared-helper extraction is a
possible later cleanup but is intentionally NOT done now to avoid touching working code.

## DB schema

New table `candles` in `apps/api/src/db/schema.ts`:

| column        | type                          | notes                                                      |
|---------------|-------------------------------|------------------------------------------------------------|
| `id`          | integer pk autoincrement      |                                                            |
| `instrumentKey` | text notNull                | Upstox instrument key                                      |
| `timeframe`   | text notNull                  | canonical label (see below)                                |
| `ts`          | integer notNull               | candle open time, epoch ms (indexed, range-query friendly) |
| `open`        | real notNull                  | coerced to number                                          |
| `high`        | real notNull                  | coerced to number                                          |
| `low`         | real notNull                  | coerced to number                                          |
| `close`       | real notNull                  | coerced to number                                          |
| `volume`      | integer                       | nullable                                                   |
| `createdAt`   | timestamp                     | `.$defaultFn(() => new Date())`                            |

**Unique index** on `(instrumentKey, timeframe, ts)` → powers idempotent upsert
(re-syncing an overlapping range does not duplicate rows).

**`timeframe` canonical labeling:**
- v2: the raw Upstox interval string — `'1minute'`, `'30minute'`, `'day'`, `'week'`, `'month'`.
- v3: composed as `'{interval}{unit}'` — e.g. unit=`minutes` interval=`1` → `'1minutes'`;
  unit=`days` interval=`1` → `'1days'`.

A single `timeframe` text column (rather than separate `unit`) keeps queries uniform
across v2/v3 and the read endpoint keyed by one value.

After editing the schema, run `bun db:generate` then `bun db:push` (Drizzle Kit, SQLite).

## Endpoints

### `POST /backtest/data/sync`

**Body (TypeBox-validated):**

```ts
{
  instrumentKey:   t.String({ minLength: 1 }),
  source:          t.Union([t.Literal('v2'), t.Literal('v3')]),
  interval:        t.String({ minLength: 1 }),   // v2: '1minute'|'30minute'|'day'|... ; v3: integer string e.g. '1'
  unit:           t.Optional(t.Union([          // v3 only
                    t.Literal('minutes'), t.Literal('hours'), t.Literal('days')
                  ])),
  fromDate:       t.String({ format: 'date' }),
  toDate:         t.String({ format: 'date' }),
  upstoxApiVersion: t.Optional(t.String()),      // default '2.0'
}
```

**Validation:** when `source === 'v3'`, `unit` is required (enforce in handler —
TypeBox `Optional` can't easily express cross-field requirement).

**Behavior:**
1. Determine the chunk size from the timeframe:
   - minute-level (v2 `'1minute'`; v3 `minutes` with `interval <= 60`) → **1 month** chunks.
   - 30-minute / hour / day (v2 `'30minute'`,`'day'`; v3 `hours`, `days`) → **1 year** chunks.
   - week / month (v2 `'week'`,`'month'`) → **10 year** chunks.
2. For each `[chunkFrom, chunkTo]`, call Upstox:
   - v2 → `v2.getHistoricalCandleData1(instrumentKey, interval, chunkTo, chunkFrom, upstoxApiVersion, cb)`
   - v3 → `v3.getHistoricalCandleData1(instrumentKey, unit, interval, chunkTo, chunkFrom, cb)`
   using the same `call()` (promisify callback) + `toPlain()` (instance→plain object)
   pattern as `historical-data/index.ts`.
3. Normalize each returned candle →
   `{ instrumentKey, timeframe, ts: epochMs(openTime), open: +o, high: +h, low: +l, close: +c, volume: v ? +v : null }`.
4. Bulk upsert per chunk:
   `db.insert(candles).values(rows).onConflictDoNothing({ target: uniqueIndex })`.
5. Return `{ stored, chunks, totalCandles }` where `stored` counts rows newly inserted
   (note: `onConflictDoNothing` makes exact inserted-count hard; `stored` = attempted
   rows minus existing — acceptable approximation; `totalCandles` = rows now in DB for
   this instrument+timeframe+range).

**Errors:**
- Upstox fetch failure → `502` with `{ message, error }` via the same `upstoxError(...)`
  helper shape used by existing modules.
- DB failure → `500`.
- Invalid v3-without-unit → `422` with a clear message.

### `GET /backtest/data/candles/:instrumentKey/:timeframe`

**Query:** `fromDate`, `toDate` (both `t.String({ format: 'date' })`).

**Behavior:** query local DB:
```ts
db.select().from(candles)
  .where(and(
    eq(candles.instrumentKey, params.instrumentKey),
    eq(candles.timeframe, params.timeframe),
    between(candles.ts, fromMs, toMs),
  ))
  .orderBy(asc(candles.ts))
```
Returns a JSON array of candles `{ ts, open, high, low, close, volume }[]`. Empty → `200 []`.

## Wiring

- New file: `apps/api/src/modules/backtest-data/index.ts` exporting `backtestData` Elysia instance (named `'backtest-data'`).
- Register in `apps/api/src/index.ts`: `.use(backtestData)` alongside the other modules.
- Swagger tag: `Backtest Data`.

## Testing

No test runner is configured in the project. Verification is manual via Swagger
(`/swagger`):

1. `POST /backtest/data/sync` a small range (e.g. one instrument, `'day'`, 1 month).
2. `GET /backtest/data/candles/...` for the same range → confirm rows returned, ordered.
3. Re-run the sync → confirm no duplicate rows (dedup via unique index).
4. Confirm v3 path (`source:'v3'`, `unit:'days'`, `interval:'1'`) ingests correctly.

Adding `bun:test` is out of scope for this spec.

## Open items / future specs

- Live feed recording (tick persistence from the `/stream/market-data` WS relay).
- Live paper-trading.
- Strategy engine + backtest runner that reads from this store.
- Optional: extract a shared `fetchHistoricalCandles(...)` helper and refactor the
  existing `historical-data` routes to use it (removes the small duplication).

## Notes

- The repo is not a git repository, so this spec is written to disk only — no commit step.