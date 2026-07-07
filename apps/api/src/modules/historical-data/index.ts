import { Elysia, t } from 'elysia'
import { UpstoxClient } from '../../config/upstox'

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

const V2_INTERVAL = t.Union([
  t.Literal('1minute'),
  t.Literal('30minute'),
  t.Literal('day'),
  t.Literal('week'),
  t.Literal('month'),
])

const V3_UNIT = t.Union([
  t.Literal('minutes'),
  t.Literal('hours'),
  t.Literal('days'),
])

function upstoxError(err: any, label: string) {
  return {
    message: `Upstox ${label} failed`,
    error: err?.response?.body ?? err?.message ?? String(err),
  }
}

export const historicalData = new Elysia({ name: 'historical-data' })
  // ── v2: GET /v2/historical-candle/{instrumentKey}/{interval}/{to_date}[/{from_date}]
  // fromDate is optional via query. If provided → getHistoricalCandleData1 (explicit range);
  // if omitted → getHistoricalCandleData (Upstox default lookback window ending at toDate).
  .get(
    '/historical-data/v2/candles/:instrumentKey/:interval/:toDate',
    async ({ params, query, headers, status }) => {
      try {
        return toPlain(
          query.fromDate
            ? await call((cb) =>
                v2.getHistoricalCandleData1(
                  params.instrumentKey,
                  params.interval,
                  params.toDate,
                  query.fromDate as string,
                  headers['api-version'] ?? '2.0',
                  cb,
                ),
              )
            : await call((cb) =>
                v2.getHistoricalCandleData(
                  params.instrumentKey,
                  params.interval,
                  params.toDate,
                  headers['api-version'] ?? '2.0',
                  cb,
                ),
              ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'historical candle data (v2)'))
      }
    },
    {
      params: t.Object({
        instrumentKey: t.String({ minLength: 1 }),
        interval: V2_INTERVAL,
        toDate: t.String({ format: 'date' }),
      }),
      query: t.Object({
        fromDate: t.Optional(t.String({ format: 'date' })),
      }),
      headers: t.Object({
        'api-version': t.Optional(t.String()),
      }),
      detail: {
        summary: 'Historical candle data (v2)',
        description:
          'Omit fromDate for Upstox default lookback (1minute→1mo, 30minute/day→1yr, week/month→10yr, ending at toDate). Provide fromDate for an explicit range.',
        tags: ['Historical Data'],
      },
    },
  )
  // ── v2: GET /v2/historical-candle/intraday/{instrumentKey}/{interval}
  .get(
    '/historical-data/v2/intraday/:instrumentKey/:interval',
    async ({ params, headers, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            v2.getIntraDayCandleData(
              params.instrumentKey,
              params.interval,
              headers['api-version'] ?? '2.0',
              cb,
            ),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getIntraDayCandleData'))
      }
    },
    {
      params: t.Object({
        instrumentKey: t.String({ minLength: 1 }),
        interval: V2_INTERVAL,
      }),
      headers: t.Object({
        'api-version': t.Optional(t.String()),
      }),
      detail: {
        summary: 'Intraday candle data (v2)',
        tags: ['Historical Data'],
      },
    },
  )
  // ── v3: GET /v3/historical-candle/{instrumentKey}/{unit}/{interval}/{to_date}[/{from_date}]
  .get(
    '/historical-data/v3/candles/:instrumentKey/:unit/:interval/:toDate',
    async ({ params, query, status }) => {
      try {
        return toPlain(
          query.fromDate
            ? await call((cb) =>
                v3.getHistoricalCandleData1(
                  params.instrumentKey,
                  params.unit,
                  params.interval,
                  params.toDate,
                  query.fromDate as string,
                  cb,
                ),
              )
            : await call((cb) =>
                v3.getHistoricalCandleData(
                  params.instrumentKey,
                  params.unit,
                  params.interval,
                  params.toDate,
                  cb,
                ),
              ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'historical candle data (v3)'))
      }
    },
    {
      params: t.Object({
        instrumentKey: t.String({ minLength: 1 }),
        unit: V3_UNIT,
        interval: t.String({ pattern: '^[0-9]+$' }),
        toDate: t.String({ format: 'date' }),
      }),
      query: t.Object({
        fromDate: t.Optional(t.String({ format: 'date' })),
      }),
      detail: {
        summary: 'Historical candle data (v3)',
        description:
          'unit ∈ minutes|hours|days; interval is a positive integer. Omit fromDate for Upstox default lookback ending at toDate; provide fromDate for an explicit range.',
        tags: ['Historical Data'],
      },
    },
  )
  // ── v3: GET /v3/historical-candle/intraday/{instrumentKey}/{unit}/{interval}
  .get(
    '/historical-data/v3/intraday/:instrumentKey/:unit/:interval',
    async ({ params, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            v3.getIntraDayCandleData(
              params.instrumentKey,
              params.unit,
              params.interval,
              cb,
            ),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getIntraDayCandleData (v3)'))
      }
    },
    {
      params: t.Object({
        instrumentKey: t.String({ minLength: 1 }),
        unit: V3_UNIT,
        interval: t.String({ pattern: '^[0-9]+$' }),
      }),
      detail: {
        summary: 'Intraday candle data (v3)',
        tags: ['Historical Data'],
      },
    },
  )