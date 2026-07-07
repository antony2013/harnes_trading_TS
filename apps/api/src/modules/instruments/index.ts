import { Elysia, t } from 'elysia'
import { UpstoxClient } from '../../config/upstox'

const instrumentsApi = new UpstoxClient.InstrumentsApi()

/** Wrap the SDK's callback-style searchInstrument in a Promise. */
function searchInstruments(
  query: string,
  opts: {
    exchanges?: string
    segments?: string
    instrumentTypes?: string
    expiry?: string
    atmOffset?: number
    pageNumber?: number
    records?: number
  },
) {
  return new Promise((resolve, reject) => {
    instrumentsApi.searchInstrument(query, opts, (error, data) => {
      if (error) reject(error)
      else resolve(data)
    })
  })
}

export const instruments = new Elysia({ name: 'instruments' })
  .get(
    '/instruments/search',
    async ({ query, status }) => {
      try {
        const result = await searchInstruments(query.q, {
          exchanges: query.exchanges,
          segments: query.segments,
          instrumentTypes: query.instrumentTypes,
          expiry: query.expiry,
          atmOffset: query.atmOffset,
          pageNumber: query.pageNumber,
          records: query.records,
        })
        // SDK returns class instances; Elysia only JSON-serializes plain objects,
        // so round-trip through JSON to get a plain object.
        return JSON.parse(JSON.stringify(result))
      } catch (err: any) {
        return status(502, {
          message: 'Upstox instrument search failed',
          error: err?.response?.body ?? err?.message ?? String(err),
        })
      }
    },
    {
      query: t.Object({
        q: t.String({ minLength: 1 }),
        exchanges: t.Optional(t.String()),
        segments: t.Optional(t.String()),
        instrumentTypes: t.Optional(t.String()),
        expiry: t.Optional(t.String()),
        atmOffset: t.Optional(t.Number()),
        pageNumber: t.Optional(t.Number()),
        records: t.Optional(t.Number()),
      }),
      detail: {
        summary: 'Search Upstox instruments',
        description:
          'Retrieve instrument details for a natural-language search query (wraps Upstox GET /v2/instruments/search).',
        tags: ['Instruments'],
      },
    },
  )