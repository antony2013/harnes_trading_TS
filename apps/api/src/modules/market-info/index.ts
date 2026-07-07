import { Elysia, t } from 'elysia'
import { UpstoxClient } from '../../config/upstox'

const market = new UpstoxClient.MarketApi()
const timings = new UpstoxClient.MarketHolidaysAndTimingsApi()

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

const INTERVAL_1D1M = t.Union([t.Literal('1D'), t.Literal('1M')])
const ASSET_TYPE = t.Union([
  t.Literal('INDEX'),
  t.Literal('STOCK'),
  t.Literal('COMMODITY'),
])
const FUTURES_CATEGORY = t.Union([
  t.Literal('TOP_TRADED'),
  t.Literal('MOST_ACTIVE'),
  t.Literal('OI_GAINERS'),
  t.Literal('OI_LOSERS'),
  t.Literal('PRICE_GAINERS'),
  t.Literal('PRICE_LOSERS'),
  t.Literal('PREMIUM'),
  t.Literal('DISCOUNT'),
])
const OPTIONS_CATEGORY = t.Union([
  t.Literal('TOP_TRADED'),
  t.Literal('MOST_ACTIVE'),
  t.Literal('OI_GAINERS'),
  t.Literal('OI_LOSERS'),
  t.Literal('PRICE_GAINERS'),
  t.Literal('PRICE_LOSERS'),
  t.Literal('IV_GAINERS'),
  t.Literal('IV_LOSERS'),
  t.Literal('UNDER_5000'),
  t.Literal('UNDER_10000'),
])
const FII_DATA_TYPE = t.Union([
  t.Literal('NSE_FO|INDEX_FUTURES'),
  t.Literal('NSE_FO|STOCK_FUTURES'),
  t.Literal('NSE_FO|INDEX_OPTIONS'),
  t.Literal('NSE_FO|STOCK_OPTIONS'),
  t.Literal('NSE_EQ|CASH'),
])

export const marketInfo = new Elysia({ name: 'market-info' })
  // ── GET /v2/market/timings/{date}  (no auth)
  .get(
    '/market-info/timings/:date',
    async ({ params, status }) => {
      try {
        return toPlain(await call((cb) => timings.getExchangeTimings(params.date, cb)))
      } catch (err: any) {
        return status(502, upstoxError(err, 'getExchangeTimings'))
      }
    },
    {
      params: t.Object({ date: t.String({ format: 'date' }) }),
      detail: { summary: 'Exchange timings for a date', tags: ['Market Info — Status & Holidays'] },
    },
  )
  // ── GET /v2/market/holidays/{date}  (no auth)
  .get(
    '/market-info/holidays/:date',
    async ({ params, status }) => {
      try {
        return toPlain(await call((cb) => timings.getHoliday(params.date, cb)))
      } catch (err: any) {
        return status(502, upstoxError(err, 'getHoliday'))
      }
    },
    {
      params: t.Object({ date: t.String({ format: 'date' }) }),
      detail: { summary: 'Holiday for a specific date', tags: ['Market Info — Status & Holidays'] },
    },
  )
  // ── GET /v2/market/holidays  (no auth; current-year list)
  .get(
    '/market-info/holidays',
    async ({ status }) => {
      try {
        return toPlain(await call((cb) => timings.getHolidays(cb)))
      } catch (err: any) {
        return status(502, upstoxError(err, 'getHolidays'))
      }
    },
    { detail: { summary: 'Holiday list for current year', tags: ['Market Info — Status & Holidays'] } },
  )
  // ── GET /v2/market/status/{exchange}  (OAuth2)
  .get(
    '/market-info/status/:exchange',
    async ({ params, status }) => {
      try {
        return toPlain(await call((cb) => timings.getMarketStatus(params.exchange, cb)))
      } catch (err: any) {
        return status(502, upstoxError(err, 'getMarketStatus'))
      }
    },
    {
      params: t.Object({ exchange: t.String({ minLength: 1 }) }),
      detail: { summary: 'Market status for an exchange', tags: ['Market Info — Status & Holidays'] },
    },
  )
  // ── GET /v2/market/change-oi  (OAuth2)
  .get(
    '/market-info/change-oi',
    async ({ query, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            market.getChangeOiData(query.instrumentKey, query.expiry, query.date, query.interval, cb),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getChangeOiData'))
      }
    },
    {
      query: t.Object({
        instrumentKey: t.String({ minLength: 1 }),
        expiry: t.String({ format: 'date' }),
        date: t.String({ format: 'date' }),
        interval: t.String({ pattern: '^[0-9]+$' }),
      }),
      detail: {
        summary: 'Change in Open Interest data',
        description: 'interval = number of days for the OI difference.',
        tags: ['Market Info — Analytics'],
      },
    },
  )
  // ── GET /v2/market/dii  (OAuth2)
  .get(
    '/market-info/dii',
    async ({ query, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            market.getDiiData(query.dataType, query.interval, { from: query.from }, cb),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getDiiData'))
      }
    },
    {
      query: t.Object({
        dataType: t.Literal('NSE_EQ|CASH'),
        interval: INTERVAL_1D1M,
        from: t.Optional(t.String({ format: 'date' })),
      }),
      detail: { summary: 'DII activity data', tags: ['Market Info — Analytics'] },
    },
  )
  // ── GET /v2/market/fii  (OAuth2)
  .get(
    '/market-info/fii',
    async ({ query, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            market.getFiiData(query.dataType, query.interval, { from: query.from }, cb),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getFiiData'))
      }
    },
    {
      query: t.Object({
        dataType: FII_DATA_TYPE,
        interval: INTERVAL_1D1M,
        from: t.Optional(t.String({ format: 'date' })),
      }),
      detail: { summary: 'FII activity data', tags: ['Market Info — Analytics'] },
    },
  )
  // ── GET /v2/market/oi  (OAuth2)
  .get(
    '/market-info/oi',
    async ({ query, status }) => {
      try {
        return toPlain(
          await call((cb) => market.getOiData(query.instrumentKey, query.expiry, query.date, cb)),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getOiData'))
      }
    },
    {
      query: t.Object({
        instrumentKey: t.String({ minLength: 1 }),
        expiry: t.String({ format: 'date' }),
        date: t.String({ format: 'date' }),
      }),
      detail: { summary: 'Open Interest data', tags: ['Market Info — Analytics'] },
    },
  )
  // ── GET /v2/market/max-pain  (OAuth2)
  .get(
    '/market-info/max-pain',
    async ({ query, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            market.getMaxPainData(
              query.instrumentKey,
              query.expiry,
              query.date,
              query.bucketInterval,
              cb,
            ),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getMaxPainData'))
      }
    },
    {
      query: t.Object({
        instrumentKey: t.String({ minLength: 1 }),
        expiry: t.String({ format: 'date' }),
        date: t.String({ format: 'date' }),
        bucketInterval: t.String({ pattern: '^[0-9]+$' }),
      }),
      detail: {
        summary: 'Max Pain data',
        description: 'bucketInterval = bucket interval in minutes.',
        tags: ['Market Info — Analytics'],
      },
    },
  )
  // ── GET /v2/market/pcr  (OAuth2)
  .get(
    '/market-info/pcr',
    async ({ query, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            market.getPcrData(
              query.instrumentKey,
              query.expiry,
              query.date,
              query.bucketInterval,
              cb,
            ),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getPcrData'))
      }
    },
    {
      query: t.Object({
        instrumentKey: t.String({ minLength: 1 }),
        expiry: t.String({ format: 'date' }),
        date: t.String({ format: 'date' }),
        bucketInterval: t.String({ pattern: '^[0-9]+$' }),
      }),
      detail: {
        summary: 'Put-Call Ratio (PCR) data',
        description: 'bucketInterval = bucket interval in minutes.',
        tags: ['Market Info — Analytics'],
      },
    },
  )
  // ── GET /v2/market/smartlist/futures  (OAuth2)
  .get(
    '/market-info/smartlist/futures',
    async ({ query, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            market.getSmartlistFutures(
              {
                assetType: query.assetType,
                category: query.category,
                pageNumber: query.pageNumber,
                pageSize: query.pageSize,
              },
              cb,
            ),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getSmartlistFutures'))
      }
    },
    {
      query: t.Object({
        assetType: ASSET_TYPE,
        category: FUTURES_CATEGORY,
        pageNumber: t.Optional(t.Number({ minimum: 1 })),
        pageSize: t.Optional(t.Number({ minimum: 1, maximum: 50 })),
      }),
      detail: { summary: 'Smartlist — futures', tags: ['Market Info — Smartlist'] },
    },
  )
  // ── GET /v2/market/smartlist/mtf  (OAuth2)
  .get(
    '/market-info/smartlist/mtf',
    async ({ query, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            market.getSmartlistMtf({ pageNumber: query.pageNumber, pageSize: query.pageSize }, cb),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getSmartlistMtf'))
      }
    },
    {
      query: t.Object({
        pageNumber: t.Optional(t.Number({ minimum: 1 })),
        pageSize: t.Optional(t.Number({ minimum: 1, maximum: 50 })),
      }),
      detail: { summary: 'Smartlist — MTF stocks', tags: ['Market Info — Smartlist'] },
    },
  )
  // ── GET /v2/market/smartlist/options  (OAuth2)
  .get(
    '/market-info/smartlist/options',
    async ({ query, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            market.getSmartlistOptions(
              {
                assetType: query.assetType,
                category: query.category,
                pageNumber: query.pageNumber,
                pageSize: query.pageSize,
              },
              cb,
            ),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getSmartlistOptions'))
      }
    },
    {
      query: t.Object({
        assetType: ASSET_TYPE,
        category: OPTIONS_CATEGORY,
        pageNumber: t.Optional(t.Number({ minimum: 1 })),
        pageSize: t.Optional(t.Number({ minimum: 1, maximum: 50 })),
      }),
      detail: { summary: 'Smartlist — options', tags: ['Market Info — Smartlist'] },
    },
  )