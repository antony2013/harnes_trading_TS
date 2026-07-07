import { Elysia, t } from 'elysia'
import { UpstoxClient } from '../../config/upstox'

const api = new UpstoxClient.FundamentalsApi()

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

const ISIN = t.String({ pattern: '^[A-Z]{2}[A-Z0-9]{9}[0-9]$' })
const REPORT_TYPE = t.Optional(t.Union([t.Literal('consolidated'), t.Literal('standalone')]))
const TIME_PERIOD = t.Optional(t.Union([t.Literal('yearly'), t.Literal('quarterly')]))
const FS = t.Optional(t.Boolean())

export const fundamentals = new Elysia({ name: 'fundamentals' })
  // ── GET /v2/fundamentals/{isin}/balance-sheet
  .get(
    '/fundamentals/balance-sheet/:isin',
    async ({ params, query, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            api.getBalanceSheet(params.isin, { type: query.type, fs: query.fs }, cb),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getBalanceSheet'))
      }
    },
    {
      params: t.Object({ isin: ISIN }),
      query: t.Object({ type: REPORT_TYPE, fs: FS }),
      detail: {
        summary: 'Balance sheet',
        description: '`type` ∈ consolidated|standalone; `fs` includes the full financial statement.',
        tags: ['Fundamentals'],
      },
    },
  )
  // ── GET /v2/fundamentals/{isin}/cash-flow
  .get(
    '/fundamentals/cash-flow/:isin',
    async ({ params, query, status }) => {
      try {
        return toPlain(
          await call((cb) => api.getCashFlow(params.isin, { type: query.type, fs: query.fs }, cb)),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getCashFlow'))
      }
    },
    {
      params: t.Object({ isin: ISIN }),
      query: t.Object({ type: REPORT_TYPE, fs: FS }),
      detail: {
        summary: 'Cash flow statement',
        tags: ['Fundamentals'],
      },
    },
  )
  // ── GET /v2/fundamentals/{isin}/profile
  .get(
    '/fundamentals/profile/:isin',
    async ({ params, status }) => {
      try {
        return toPlain(await call((cb) => api.getCompanyProfile(params.isin, cb)))
      } catch (err: any) {
        return status(502, upstoxError(err, 'getCompanyProfile'))
      }
    },
    {
      params: t.Object({ isin: ISIN }),
      detail: { summary: 'Company profile', tags: ['Fundamentals'] },
    },
  )
  // ── GET /v2/fundamentals/{instrument_key}/competitors
  .get(
    '/fundamentals/competitors/:instrumentKey',
    async ({ params, status }) => {
      try {
        return toPlain(await call((cb) => api.getCompetitors(params.instrumentKey, cb)))
      } catch (err: any) {
        return status(502, upstoxError(err, 'getCompetitors'))
      }
    },
    {
      params: t.Object({ instrumentKey: t.String({ minLength: 1 }) }),
      detail: { summary: 'Competitors for an instrument', tags: ['Fundamentals'] },
    },
  )
  // ── GET /v2/fundamentals/{isin}/corporate-actions
  .get(
    '/fundamentals/corporate-actions/:isin',
    async ({ params, status }) => {
      try {
        return toPlain(await call((cb) => api.getCorporateActions(params.isin, cb)))
      } catch (err: any) {
        return status(502, upstoxError(err, 'getCorporateActions'))
      }
    },
    {
      params: t.Object({ isin: ISIN }),
      detail: { summary: 'Corporate actions', tags: ['Fundamentals'] },
    },
  )
  // ── GET /v2/fundamentals/{isin}/income-statement
  .get(
    '/fundamentals/income-statement/:isin',
    async ({ params, query, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            api.getIncomeStatement(
              params.isin,
              { type: query.type, timePeriod: query.timePeriod, fs: query.fs },
              cb,
            ),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getIncomeStatement'))
      }
    },
    {
      params: t.Object({ isin: ISIN }),
      query: t.Object({ type: REPORT_TYPE, timePeriod: TIME_PERIOD, fs: FS }),
      detail: {
        summary: 'Income statement',
        description:
          '`type` ∈ consolidated|standalone; `timePeriod` ∈ yearly|quarterly; `fs` includes the full financial statement.',
        tags: ['Fundamentals'],
      },
    },
  )
  // ── GET /v2/fundamentals/{isin}/key-ratios
  .get(
    '/fundamentals/key-ratios/:isin',
    async ({ params, status }) => {
      try {
        return toPlain(await call((cb) => api.getKeyRatios(params.isin, cb)))
      } catch (err: any) {
        return status(502, upstoxError(err, 'getKeyRatios'))
      }
    },
    {
      params: t.Object({ isin: ISIN }),
      detail: { summary: 'Key financial ratios', tags: ['Fundamentals'] },
    },
  )
  // ── GET /v2/fundamentals/{isin}/share-holdings
  .get(
    '/fundamentals/share-holdings/:isin',
    async ({ params, status }) => {
      try {
        return toPlain(await call((cb) => api.getShareHoldings(params.isin, cb)))
      } catch (err: any) {
        return status(502, upstoxError(err, 'getShareHoldings'))
      }
    },
    {
      params: t.Object({ isin: ISIN }),
      detail: { summary: 'Shareholding pattern', tags: ['Fundamentals'] },
    },
  )