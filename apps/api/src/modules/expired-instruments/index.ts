import { Elysia, t } from 'elysia'
import { UpstoxClient } from '../../config/upstox'

const api = new UpstoxClient.ExpiredInstrumentApi()

/** Promisify an SDK callback-style call. */
function call<T>(fn: (cb: (err: any, data: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) =>
    fn((err, data) => (err ? reject(err) : resolve(data))),
  )
}

// SDK responses are class instances; Elysia only serializes plain objects (see memory).
const toPlain = <T>(v: T): T => JSON.parse(JSON.stringify(v))

const INTERVAL = t.Union([
  t.Literal('1minute'),
  t.Literal('30minute'),
  t.Literal('day'),
  t.Literal('week'),
  t.Literal('month'),
])

export const expiredInstruments = new Elysia({ name: 'expired-instruments' })
  // GET /v2/expired-instruments/expiries
  .get(
    '/expired-instruments/expiries',
    async ({ query, status }) => {
      try {
        return toPlain(await call((cb) => api.getExpiries(query.instrumentKey, cb)))
      } catch (err: any) {
        return status(502, {
          message: 'Upstox getExpiries failed',
          error: err?.response?.body ?? err?.message ?? String(err),
        })
      }
    },
    {
      query: t.Object({
        instrumentKey: t.String({ minLength: 1 }),
      }),
      detail: {
        summary: 'Expired instruments — get expiry dates for an instrument',
        tags: ['Expired Instruments'],
      },
    },
  )
  // GET /v2/expired-instruments/future/contract
  .get(
    '/expired-instruments/future-contracts',
    async ({ query, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            api.getExpiredFutureContracts(query.instrumentKey, query.expiryDate, cb),
          ),
        )
      } catch (err: any) {
        return status(502, {
          message: 'Upstox getExpiredFutureContracts failed',
          error: err?.response?.body ?? err?.message ?? String(err),
        })
      }
    },
    {
      query: t.Object({
        instrumentKey: t.String({ minLength: 1 }),
        expiryDate: t.String({ format: 'date' }),
      }),
      detail: {
        summary: 'Expired instruments — get expired future contracts',
        tags: ['Expired Instruments'],
      },
    },
  )
  // GET /v2/expired-instruments/option/contract
  .get(
    '/expired-instruments/option-contracts',
    async ({ query, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            api.getExpiredOptionContracts(query.instrumentKey, query.expiryDate, cb),
          ),
        )
      } catch (err: any) {
        return status(502, {
          message: 'Upstox getExpiredOptionContracts failed',
          error: err?.response?.body ?? err?.message ?? String(err),
        })
      }
    },
    {
      query: t.Object({
        instrumentKey: t.String({ minLength: 1 }),
        expiryDate: t.String({ format: 'date' }),
      }),
      detail: {
        summary: 'Expired instruments — get expired option contracts',
        tags: ['Expired Instruments'],
      },
    },
  )
  // GET /v2/expired-instruments/historical-candle/{expired_instrument_key}/{interval}/{to_date}/{from_date}
  .get(
    '/expired-instruments/historical-candles/:expiredInstrumentKey/:interval/:toDate/:fromDate',
    async ({ params, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            api.getExpiredHistoricalCandleData(
              params.expiredInstrumentKey,
              params.interval,
              params.toDate,
              params.fromDate,
              cb,
            ),
          ),
        )
      } catch (err: any) {
        return status(502, {
          message: 'Upstox getExpiredHistoricalCandleData failed',
          error: err?.response?.body ?? err?.message ?? String(err),
        })
      }
    },
    {
      params: t.Object({
        expiredInstrumentKey: t.String({ minLength: 1 }),
        interval: INTERVAL,
        toDate: t.String({ format: 'date' }),
        fromDate: t.String({ format: 'date' }),
      }),
      detail: {
        summary: 'Expired instruments — expired historical candle (OHLC) data',
        description:
          'Intervals: 1minute (last 1 month), 30minute/day (last 1 year), week/month (last 10 years), all relative to toDate.',
        tags: ['Expired Instruments'],
      },
    },
  )