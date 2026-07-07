import { tool } from 'langchain'
import { z } from 'zod'
import { apiCall } from './http'

// Hand-maintained list of endpoints NOT covered by a named tool, so the model knows
// what else it can call via call_api. Update when apps/api routes change.
const AVAILABLE_PATHS = `
Endpoints reachable via call_api (method GET|POST, path starts with "/", no query string — pass params via query/body). Dates are YYYY-MM-DD.
- GET /market-quote/v2/full?symbol=<comma list> — full market quote (v2, up to 500 symbols)
- GET /market-quote/v3/option-greek?instrumentKey=<comma list> — option greeks (v3, up to 500)
- GET /option-chain/contracts?instrumentKey=<key>&expiryDate=<YYYY-MM-DD> — option contracts (expiryDate optional)
- GET /market-info/timings/<YYYY-MM-DD> — exchange timings for a date (no auth)
- GET /market-info/holidays — holiday list for current year (no auth)
- GET /market-info/holidays/<YYYY-MM-DD> — holiday detail for a date (no auth)
- GET /market-info/change-oi?instrumentKey=<key>&expiry=<YYYY-MM-DD>&date=<YYYY-MM-DD>&interval=<number-of-days> — change in open interest
- GET /market-info/dii?dataType=NSE_EQ&interval=1D|1M&from=<YYYY-MM-DD> — DII activity
- GET /market-info/fii?dataType=<NSE_FO|NSE_EQ|CASH|INDEX_FUTURES|STOCK_FUTURES|INDEX_OPTIONS|STOCK_OPTIONS>&interval=1D|1M&from=<YYYY-MM-DD> — FII activity
- GET /market-info/oi?instrumentKey=<key>&expiry=<YYYY-MM-DD>&date=<YYYY-MM-DD> — open interest
- GET /market-info/max-pain?instrumentKey=<key>&expiry=<YYYY-MM-DD>&date=<YYYY-MM-DD>&bucketInterval=<minutes> — max pain
- GET /market-info/pcr?instrumentKey=<key>&expiry=<YYYY-MM-DD>&date=<YYYY-MM-DD>&bucketInterval=<minutes> — put-call ratio
- GET /market-info/smartlist/futures?assetType=<INDEX|STOCK|COMMODITY>&category=<TOP_TRADED|MOST_ACTIVE|OI_GAINERS|OI_LOSERS|PRICE_GAINERS|PRICE_LOSERS|PREMIUM|DISCOUNT>&pageNumber=<n>&pageSize=<n> — smartlist futures
- GET /market-info/smartlist/options?assetType=<INDEX|STOCK|COMMODITY>&category=<TOP_TRADED|MOST_ACTIVE|OI_GAINERS|OI_LOSERS|PRICE_GAINERS|PRICE_LOSERS|IV_GAINERS|IV_LOSERS|UNDER_5000|UNDER_10000>&pageNumber=<n>&pageSize=<n> — smartlist options
- GET /market-info/smartlist/mtf?pageNumber=<n>&pageSize=<n> — smartlist MTF stocks
- GET /fundamentals/balance-sheet/<isin>?type=<consolidated|standalone>&fs=<true|false> — balance sheet (isin like INE002A01018)
- GET /fundamentals/cash-flow/<isin>?type=<consolidated|standalone>&fs=<true|false> — cash flow
- GET /fundamentals/income-statement/<isin>?type=<consolidated|standalone>&timePeriod=<yearly|quarterly>&fs=<true|false> — income statement
- GET /fundamentals/key-ratios/<isin> — key financial ratios
- GET /fundamentals/share-holdings/<isin> — shareholding pattern
- GET /fundamentals/competitors/<instrumentKey> — competitors
- GET /fundamentals/corporate-actions/<isin> — corporate actions
- GET /expired-instruments/expiries?instrumentKey=<key> — expiry dates for an expired instrument
- GET /expired-instruments/future-contracts?instrumentKey=<key>&expiryDate=<YYYY-MM-DD> — expired futures
- GET /expired-instruments/option-contracts?instrumentKey=<key>&expiryDate=<YYYY-MM-DD> — expired options
- GET /expired-instruments/historical-candles/<expiredInstrumentKey>/<interval>/<toDate>/<fromDate> — expired instrument candles (interval 1minute|30minute|day|week|month)
- GET /stream/market-data-feed/authorize — authorized wss URI for market-data feed
- GET /stream/portfolio-stream-feed/authorize (header api-version required) — authorized URI for portfolio feed
- GET /stream/subscriptions — current global subscription state
- POST /stream/subscriptions body {method:"sub"|"unsub", data:{mode:"ltp"|"full"|"option_greeks"|"full_d30", instrumentKeys:[...]}} — add/remove stream subscriptions
`.trim()

export const callApiTool = tool(
  async ({ method, path, query, body }) => {
    if (!path.startsWith('/')) {
      return JSON.stringify({ error: 'path must start with "/"' })
    }
    return apiCall(method, path, query, body)
  },
  {
    name: 'call_api',
    description:
      `Call any trading-API endpoint that has no dedicated tool. Pass method (GET|POST), path (starts with "/", NO query string), query (object of params), and body (object, POST only). If you get a 400/422, read the error and retry with the correct params. Available paths:\n${AVAILABLE_PATHS}`,
    schema: z.object({
      method: z.enum(['GET', 'POST']).describe('HTTP method'),
      path: z
        .string()
        .min(1)
        .describe('Full path starting with "/", without query string, e.g. "/market-info/pcr"'),
      query: z
        .record(z.union([z.string(), z.number()]))
        .optional()
        .describe('Query params as an object, e.g. {instrumentKey:"NSE_INDEX|Nifty 50", expiry:"2026-06-26", date:"2026-06-10", bucketInterval:15}'),
      body: z.record(z.unknown()).optional().describe('Request body object (POST only)'),
    }),
  },
)