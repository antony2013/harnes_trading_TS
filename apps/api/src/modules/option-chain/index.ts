import { Elysia, t } from 'elysia'
import { UpstoxClient } from '../../config/upstox'

const api = new UpstoxClient.OptionsApi()

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

export const optionChain = new Elysia({ name: 'option-chain' })
  // ── GET /v2/option/contract  (option contracts; expiryDate optional)
  .get(
    '/option-chain/contracts',
    async ({ query, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            api.getOptionContracts(
              query.instrumentKey,
              query.expiryDate ? { expiryDate: query.expiryDate } : {},
              cb,
            ),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getOptionContracts'))
      }
    },
    {
      query: t.Object({
        instrumentKey: t.String({ minLength: 1 }),
        expiryDate: t.Optional(t.String({ format: 'date' })),
      }),
      detail: {
        summary: 'Option contracts for an underlying',
        description:
          'Omit expiryDate to list all option contracts for the underlying; provide it to filter to a specific expiry (YYYY-MM-DD).',
        tags: ['Option Chain'],
      },
    },
  )
  // ── GET /v2/option/chain  (put/call option chain; expiryDate required)
  .get(
    '/option-chain/chain',
    async ({ query, status }) => {
      try {
        return toPlain(
          await call((cb) =>
            api.getPutCallOptionChain(query.instrumentKey, query.expiryDate, cb),
          ),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getPutCallOptionChain'))
      }
    },
    {
      query: t.Object({
        instrumentKey: t.String({ minLength: 1 }),
        expiryDate: t.String({ format: 'date' }),
      }),
      detail: {
        summary: 'Put/call option chain',
        description: 'Requires both instrumentKey and expiryDate (YYYY-MM-DD).',
        tags: ['Option Chain'],
      },
    },
  )