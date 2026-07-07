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