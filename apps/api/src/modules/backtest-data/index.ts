import { Elysia, t } from 'elysia'
import { asc } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { mkdir, unlink, access } from 'node:fs/promises'
import { candles } from '../../db/schema'
import { UpstoxClient } from '../../config/upstox'
import {
  timeframeLabel,
  toDateString,
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

// ── Per-fetch SQLite file storage ──────────────────────────────────────────
// Each sync writes a fresh SQLite file under apps/api/data/ named by the
// request params, so each fetched dataset is a self-contained file. Reads open
// the file matching the exact params (no Upstox call at read time).
//
// apps/api/src/modules/backtest-data/index.ts -> ../../../data/ = apps/api/data/
const dataDir = fileURLToPath(new URL('../../../data/', import.meta.url))

// DDL for the per-file candles table. Must match the `candles` definition in
// ../../db/schema.ts. No unique index: each file is fresh per fetch (no dedup).
const CREATE_TABLE_CANDLES = `
CREATE TABLE IF NOT EXISTS candles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument_key TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume INTEGER,
  created_at INTEGER NOT NULL
)
`

/** Replace characters illegal in Windows filenames with `_`. */
function sanitizeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_')
}

/** Deterministic file name for a fetch's params (used by both sync and read). */
function candleFileName(
  instrumentKey: string,
  timeframe: string,
  fromDate: string,
  toDate: string,
): string {
  return `${sanitizeFileName(instrumentKey)}-${timeframe}-${fromDate}-${toDate}.sqlite`
}

/** Create a fresh candles file at filePath (deleting any existing one), return a drizzle instance + the raw handle. */
async function createCandlesFile(filePath: string) {
  await mkdir(dirname(filePath), { recursive: true })
  await unlink(filePath).catch(() => {}) // "new DB each fetch" — replace any prior file
  const sqlite = new Database(filePath)
  sqlite.run(CREATE_TABLE_CANDLES)
  return { sqlite, fileDb: drizzle(sqlite, { schema: { candles } }) }
}

/** Batch inserts to stay under SQLite's variable limit (100 rows x 9 cols = 900 < 999). */
async function insertBatched(fileDb: ReturnType<typeof createCandlesFile>['fileDb'], rows: any[]) {
  const BATCH = 100
  for (let i = 0; i < rows.length; i += BATCH) {
    await fileDb.insert(candles).values(rows.slice(i, i + BATCH))
  }
}

export const backtestData = new Elysia({ name: 'backtest-data' })
  // ── GET /backtest/data/candles/:instrumentKey/:timeframe
  // Open the file matching the exact params and return its candles (backtests consume this).
  .get(
    '/backtest/data/candles/:instrumentKey/:timeframe',
    async ({ params, query, status }) => {
      const fileName = candleFileName(
        params.instrumentKey,
        params.timeframe,
        query.fromDate,
        query.toDate,
      )
      const filePath = join(dataDir, fileName)
      try {
        await access(filePath)
      } catch {
        return status(404, {
          message: 'no stored data for these params — sync first',
          file: fileName,
        })
      }
      const sqlite = new Database(filePath)
      try {
        const fileDb = drizzle(sqlite, { schema: { candles } })
        const rows = await fileDb
          .select({
            ts: candles.ts,
            open: candles.open,
            high: candles.high,
            low: candles.low,
            close: candles.close,
            volume: candles.volume,
          })
          .from(candles)
          .orderBy(asc(candles.ts))
        return rows
      } finally {
        sqlite.close()
      }
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
          'Opens the SQLite file matching the exact instrument + timeframe + fromDate + toDate (created by a prior POST /backtest/data/sync) and returns all its candles ordered by ts. fromDate/toDate must EXACTLY match a prior sync request — they are the file key, not a sub-range filter. Returns 404 if no file matches (sync first). `timeframe` is the canonical label: v2 raw (1minute/30minute/day/week/month) or v3 `{interval}{unit}` (e.g. 1minutes, 1days).',
        tags: ['Backtest Data'],
      },
    },
  )
  // ── POST /backtest/data/sync
  // Fetch historical candles from Upstox for an instrument + timeframe + range,
  // chunk the range to respect Upstox per-call lookback limits, normalize, and
  // write them to a fresh per-fetch SQLite file under apps/api/data/.
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

      // Fetch ALL chunks first; only create the file once every Upstox call has
      // succeeded (avoids leaving a partial file on a 502).
      const allRows: any[] = []
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
                  v3.getHistoricalCandleData1(instrumentKey, unit!, interval, toStr, fromStr, cb),
                )
        } catch (err: any) {
          return status(502, upstoxError(err, 'historical candle sync'))
        }
        allRows.push(...normalizeCandles(toPlain(raw), instrumentKey, tf))
      }

      const fileName = candleFileName(instrumentKey, tf, fromDate, toDate)
      const filePath = join(dataDir, fileName)
      const { sqlite, fileDb } = await createCandlesFile(filePath)
      try {
        if (allRows.length) await insertBatched(fileDb, allRows)
      } finally {
        sqlite.close()
      }

      return { stored: allRows.length, chunks: chunks.length, file: fileName }
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
        summary: 'Fetch + store historical candles (Upstox -> per-fetch SQLite file)',
        description:
          'Fetches candles from Upstox for the given instrument + timeframe + date range, chunks the range to respect Upstox lookback limits, and writes them to a FRESH SQLite file under apps/api/data/ named `<instrument>-<timeframe>-<fromDate>-<toDate>.sqlite` (replacing any existing file with the same name — "new DB each fetch"). `source` selects v2 or v3 Upstox API; for v3, `unit` is required. Returns `stored` (rows written), `chunks` (number of Upstox calls), and `file` (the file name written).',
        tags: ['Backtest Data'],
      },
    },
  )