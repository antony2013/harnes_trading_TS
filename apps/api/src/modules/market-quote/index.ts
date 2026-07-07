import { Elysia, t } from 'elysia'
import { UpstoxClient } from '../../config/upstox'

const v2 = new UpstoxClient.MarketQuoteApi()
const v3 = new UpstoxClient.MarketQuoteV3Api()

/** Promisify an SDK callback-style call. */
function call<T>(fn: (cb: (err: any, data: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) =>
    fn((err, data) => (err ? reject(err) : resolve(data))),
  )
}

// SDK responses are class instances; Elysia only serializes plain objects.
const toPlain = <T>(v: T): T => JSON.parse(JSON.stringify(v))

const symbolField = t.String({ minLength: 1 })
const instrumentKeyField = t.String({ minLength: 1 })

function upstoxError(err: any, label: string) {
  return {
    message: `Upstox ${label} failed`,
    error: err?.response?.body ?? err?.message ?? String(err),
  }
}

export const marketQuote = new Elysia({ name: 'market-quote' })
  // ── v2: GET /v2/market-quote/quotes  (full market quote)
  .get(
    '/market-quote/v2/full',
    async ({ query, headers, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            v2.getFullMarketQuote(query.symbol, headers['api-version'] ?? '2.0', cb),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getFullMarketQuote'))
      }
    },
    {
      query: t.Object({ symbol: symbolField }),
      headers: t.Object({ 'api-version': t.Optional(t.String()) }),
      detail: {
        summary: 'Full market quotes (v2)',
        description: 'Comma-separated `symbol` list (up to 500 instruments).',
        tags: ['Market Quote'],
      },
    },
  )
  // ── v2: GET /v2/market-quote/ohlc
  .get(
    '/market-quote/v2/ohlc',
    async ({ query, headers, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            v2.getMarketQuoteOHLC(query.symbol, query.interval, headers['api-version'] ?? '2.0', cb),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getMarketQuoteOHLC'))
      }
    },
    {
      query: t.Object({
        symbol: symbolField,
        interval: t.String({ minLength: 1 }),
      }),
      headers: t.Object({ 'api-version': t.Optional(t.String()) }),
      detail: {
        summary: 'OHLC market quotes (v2)',
        description: 'Comma-separated `symbol` list (up to 1000 instruments).',
        tags: ['Market Quote'],
      },
    },
  )
  // ── v2: GET /v2/market-quote/ltp
  .get(
    '/market-quote/v2/ltp',
    async ({ query, headers, status }) => {
      try {
        return toPlain(
          await call((cb) => v2.ltp(query.symbol, headers['api-version'] ?? '2.0', cb)),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'ltp'))
      }
    },
    {
      query: t.Object({ symbol: symbolField }),
      headers: t.Object({ 'api-version': t.Optional(t.String()) }),
      detail: {
        summary: 'LTP quotes (v2)',
        description: 'Comma-separated `symbol` list (up to 1000 instruments).',
        tags: ['Market Quote'],
      },
    },
  )
  // ── v3: GET /v3/market-quote/ltp
  .get(
    '/market-quote/v3/ltp',
    async ({ query, status }) => {
      try {
        return toPlain(
          await call((cb) => v3.getLtp({ instrumentKey: query.instrumentKey }, cb)),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getLtp (v3)'))
      }
    },
    {
      query: t.Object({ instrumentKey: instrumentKeyField }),
      detail: {
        summary: 'LTP quotes (v3)',
        description: 'Comma-separated `instrumentKey` list (up to 500 instruments).',
        tags: ['Market Quote'],
      },
    },
  )
  // ── v3: GET /v3/market-quote/ohlc
  .get(
    '/market-quote/v3/ohlc',
    async ({ query, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            v3.getMarketQuoteOHLC(query.interval, { instrumentKey: query.instrumentKey }, cb),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getMarketQuoteOHLC (v3)'))
      }
    },
    {
      query: t.Object({
        instrumentKey: instrumentKeyField,
        interval: t.String({ minLength: 1 }),
      }),
      detail: {
        summary: 'OHLC market quotes (v3)',
        description: 'Comma-separated `instrumentKey` list (up to 500 instruments).',
        tags: ['Market Quote'],
      },
    },
  )
  // ── v3: GET /v3/market-quote/option-greek
  .get(
    '/market-quote/v3/option-greek',
    async ({ query, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            v3.getMarketQuoteOptionGreek({ instrumentKey: query.instrumentKey }, cb),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getMarketQuoteOptionGreek'))
      }
    },
    {
      query: t.Object({ instrumentKey: instrumentKeyField }),
      detail: {
        summary: 'Option Greek (v3)',
        description: 'Comma-separated `instrumentKey` list (up to 500 instruments).',
        tags: ['Market Quote'],
      },
    },
  )