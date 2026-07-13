import { Elysia, t } from 'elysia'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { mkdir, unlink, readdir } from 'node:fs/promises'
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
const expiredApi = new UpstoxClient.ExpiredInstrumentApi()

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
  oi INTEGER,
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Find the per-fetch file that COVERS the requested [reqFromDate, reqToDate] for the
 * given instrument + timeframe. Filenames are `<instrument>-<timeframe>-<fromDate>-<toDate>.sqlite`
 * with YYYY-MM-DD dates, so coverage is a plain string comparison. If several files cover
 * the request, return the one with the SMALLEST range (tightest fit — cheapest read).
 * Returns null if the data dir is missing or no file covers the request.
 */
async function findCoveringFile(
  instrumentKey: string,
  timeframe: string,
  reqFromDate: string,
  reqToDate: string,
): Promise<string | null> {
  const prefix = `${sanitizeFileName(instrumentKey)}-${timeframe}-`
  let entries: string[]
  try {
    entries = await readdir(dataDir)
  } catch {
    return null // data dir doesn't exist yet — nothing synced
  }
  const covering: { file: string; rangeMs: number }[] = []
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.sqlite')) continue
    const base = name.slice(0, -'.sqlite'.length) // <prefix><fromDate>-<toDate>
    const toDateStr = base.slice(-10)
    const fromDateStr = base.slice(-21, -11) // 10 chars + leading '-'
    if (!DATE_RE.test(fromDateStr) || !DATE_RE.test(toDateStr)) continue
    // Coverage: file's [fromDate, toDate] must contain the requested [fromDate, toDate].
    // String compare is valid for YYYY-MM-DD.
    if (fromDateStr > reqFromDate || toDateStr < reqToDate) continue
    const rangeMs =
      new Date(toDateStr + 'T00:00:00.000Z').getTime() -
      new Date(fromDateStr + 'T00:00:00.000Z').getTime()
    covering.push({ file: join(dataDir, name), rangeMs })
  }
  if (!covering.length) return null
  covering.sort((a, b) => a.rangeMs - b.rangeMs)
  return covering[0].file
}

export const backtestData = new Elysia({ name: 'backtest-data' })
  // ── GET /backtest/data/candles/:instrumentKey/:timeframe
  // Find the per-fetch file whose synced range COVERS the requested [fromDate, toDate]
  // (matched by instrument + timeframe only), then return the candles within that
  // sub-range ordered by ts. Backtests consume this — sync once, read any sub-range.
  .get(
    '/backtest/data/candles/:instrumentKey/:timeframe',
    async ({ params, query, status }) => {
      if (query.toDate < query.fromDate) {
        return status(400, { message: 'toDate must be >= fromDate' })
      }
      const filePath = await findCoveringFile(
        params.instrumentKey,
        params.timeframe,
        query.fromDate,
        query.toDate,
      )
      if (!filePath) {
        return status(404, {
          message:
            'no stored data covers this instrument + timeframe + range — sync a covering range first',
          instrumentKey: params.instrumentKey,
          timeframe: params.timeframe,
          requestedRange: `${query.fromDate}..${query.toDate}`,
        })
      }
      // Anchor both bounds to IST: Upstox timestamps a candle at its open time in
      // IST, so a daily candle for date D has ts = D 00:00 IST = (D-1) 18:30 UTC.
      // fromMs at UTC midnight would be LATER than that and drop the fromDate daily
      // candle; toDate end-of-day IST captures every candle timestamped on toDate.
      const fromMs = new Date(`${query.fromDate}T00:00:00.000+05:30`).getTime()
      const toMs = new Date(`${query.toDate}T23:59:59.999+05:30`).getTime()
      const sqlite = new Database(filePath)
      try {
        // Raw SELECT * (not drizzle) so reads stay compatible with per-fetch files
        // written before the `oi` column existed — those files simply lack the
        // column and `r.oi` is undefined (mapped to null below). Mapping by name
        // means column order doesn't matter.
        const rows = sqlite.all(
          'SELECT * FROM candles WHERE ts BETWEEN ? AND ? ORDER BY ts ASC',
          [fromMs, toMs],
        ) as Array<Record<string, any>>
        return rows.map((r) => ({
          ts: r.ts,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
          oi: r.oi ?? null,
        }))
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
        summary: 'Read stored historical candles (sub-range; for backtests)',
        description:
          'Finds the per-fetch SQLite file (created by a prior POST /backtest/data/sync) whose synced range COVERS the requested [fromDate, toDate], matched by instrument + timeframe only, and returns the candles within that sub-range ordered by ts. So you can sync a wide range once and read any sub-range. 404 if no synced file covers the requested range (sync a covering range first). `timeframe` MUST be the canonical label: v2 raw (1minute/30minute/day/week/month) or v3 `{interval}{unit}` (e.g. 5minutes, 1days) — the v3 raw interval alone (5) will NOT match.',
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
  // ── POST /backtest/data/sync-expired
  // Same as /backtest/data/sync but for EXPIRED instruments — fetches via the Upstox
  // expired-instrument historical-candle API. interval is the fixed set
  // (1minute/3minute/5minute/15minute/30minute/day); chunkSizeMs already matches the
  // expired lookback limits (1minute/3minute/5minute/15minute=1 month,
  // 30minute/day=1 year, all relative to toDate). Writes to the SAME per-fetch
  // SQLite layout, so the read endpoint (matched by instrumentKey + timeframe)
  // works unchanged — read back with timeframe = interval.
  .post(
    '/backtest/data/sync-expired',
    async ({ body, status }) => {
      const { instrumentKey, interval, fromDate, toDate } = body
      const fromMs = new Date(fromDate).getTime()
      const toMs = new Date(toDate).getTime()
      if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
        return status(400, { message: 'fromDate / toDate must be valid YYYY-MM-DD' })
      }
      if (toMs < fromMs) {
        return status(400, { message: 'toDate must be >= fromDate' })
      }

      // Expired intervals are already the canonical v2-style labels, so tf == interval.
      const tf = interval
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
          raw = await call((cb) =>
            expiredApi.getExpiredHistoricalCandleData(instrumentKey, interval, toStr, fromStr, cb),
          )
        } catch (err: any) {
          return status(502, upstoxError(err, 'expired historical candle sync'))
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
        interval: t.Union([
          t.Literal('1minute'),
          t.Literal('3minute'),
          t.Literal('5minute'),
          t.Literal('15minute'),
          t.Literal('30minute'),
          t.Literal('day'),
        ]),
        fromDate: t.String({ format: 'date' }),
        toDate: t.String({ format: 'date' }),
      }),
      detail: {
        summary:
          'Fetch + store historical candles for an EXPIRED instrument (Upstox -> per-fetch SQLite file)',
        description:
          'Like POST /backtest/data/sync but for EXPIRED instruments — fetches via the Upstox expired-instrument historical-candle API. `interval` is one of 1minute|3minute|5minute|15minute|30minute|day (no v3/custom intervals, no week/month — the expired endpoint does not support them). Lookback limits relative to toDate: 1minute/3minute/5minute/15minute=1 month, 30minute/day=1 year; the range is auto-chunked to respect them. Writes to the SAME per-fetch SQLite file layout as /backtest/data/sync, so GET /backtest/data/candles/:instrumentKey/:timeframe reads it back unchanged (use timeframe = interval, e.g. "day"). Returns `stored`, `chunks`, and `file`.',
        tags: ['Backtest Data'],
      },
    },
  )