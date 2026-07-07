import { Elysia, t } from 'elysia'
import { and, eq, between, asc, sql } from 'drizzle-orm'
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
      // Upstox timestamps are IST (+05:30). Use end of the toDate IST day so intraday
      // candles later on the toDate day are included (UTC-midnight would truncate them).
      const toMs = new Date(`${query.toDate}T23:59:59.999+05:30`).getTime()
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
      if (source === 'v3' && !/^[0-9]+$/.test(interval)) {
        return status(422, { message: 'interval must be a positive integer when source is v3' })
      }
      const fromMs = new Date(fromDate).getTime()
      // Upstox timestamps are IST (+05:30). Use end of the toDate IST day so intraday
      // candles later on the toDate day are included (UTC-midnight would truncate them).
      const toMs = new Date(`${toDate}T23:59:59.999+05:30`).getTime()
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

      for (const [cFrom, cTo] of chunks) {
        const toStr = toDateString(cTo)
        const fromStr = toDateString(cFrom)
        let raw: any
        try {
          raw =
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
        } catch (err: any) {
          return status(502, upstoxError(err, 'historical candle sync'))
        }
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