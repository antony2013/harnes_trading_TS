import { Elysia, t } from 'elysia'
import { UpstoxClient } from '../../config/upstox'

const api = new UpstoxClient.NewsApi()

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

const CATEGORY = t.Union([
  t.Literal('instrument_keys'),
  t.Literal('positions'),
  t.Literal('holdings'),
])

export const news = new Elysia({ name: 'news' })
  // ── GET /v2/news
  .get(
    '/news',
    async ({ query, status }) => {
      if (query.category === 'instrument_keys' && !query.instrumentKeys) {
        return status(400, {
          message: 'instrumentKeys is required when category is instrument_keys',
        })
      }
      try {
        return toPlain(
          await call((cb) =>
            api.getNews(
              query.category,
              {
                instrumentKeys: query.instrumentKeys,
                pageNumber: query.pageNumber,
                pageSize: query.pageSize,
              },
              cb,
            ),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getNews'))
      }
    },
    {
      query: t.Object({
        category: CATEGORY,
        instrumentKeys: t.Optional(t.String({ minLength: 1 })),
        pageNumber: t.Optional(t.Number({ minimum: 1 })),
        pageSize: t.Optional(t.Number({ minimum: 1 })),
      }),
      detail: {
        summary: 'News articles',
        description:
          'category ∈ instrument_keys|positions|holdings. `instrumentKeys` (comma-separated) is required when category is instrument_keys.',
        tags: ['News'],
      },
    },
  )