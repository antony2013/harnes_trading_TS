import { tool } from 'langchain'
import { z } from 'zod'
import { apiCall } from './http'

const enc = encodeURIComponent

// 1) Search Upstox instruments by natural-language query.
export const searchInstruments = tool(
  async ({ q, exchanges, segments, instrument_types }) =>
    apiCall('GET', '/instruments/search', {
      q,
      exchanges,
      segments,
      instrumentTypes: instrument_types,
    }),
  {
    name: 'search_instruments',
    description:
      'Search Upstox instruments by a natural-language query. USE THIS FIRST to find an instrument_key (e.g. "NIFTY 50", "TCS") before calling quote or candle tools. Returns an array of instrument objects. Example: q="NIFTY 50".',
    schema: z.object({
      q: z.string().min(1).describe('Natural-language search text, e.g. "NIFTY 50" or "TCS"'),
      exchanges: z.string().optional().describe('Comma-separated exchange filter, e.g. "NSE" (optional)'),
      segments: z.string().optional().describe('Comma-separated segment filter, e.g. "EQ" (optional)'),
      instrument_types: z.string().optional().describe('Comma-separated instrument type filter (optional)'),
    }),
  },
)

// 2) Last traded price (v3, by instrument key).
export const getLtp = tool(
  async ({ instrument_keys }) =>
    apiCall('GET', '/market-quote/v3/ltp', { instrumentKey: instrument_keys }),
  {
    name: 'get_ltp',
    description:
      'Get the last traded price (LTP) for one or more instruments. Returns LTP quote objects. Example: instrument_keys="NSE_EQ|INE002A01018".',
    schema: z.object({
      instrument_keys: z
        .string()
        .min(1)
        .describe('Comma-separated Upstox instrument keys, e.g. "NSE_EQ|INE002A01018" (up to 500)'),
    }),
  },
)

// 3) OHLC quote (v3).
export const getOhlcQuote = tool(
  async ({ instrument_keys, interval }) =>
    apiCall('GET', '/market-quote/v3/ohlc', { instrumentKey: instrument_keys, interval }),
  {
    name: 'get_ohlc_quote',
    description:
      'Get OHLC (open/high/low/close) quotes for one or more instruments. Returns OHLC quote objects. Example: instrument_keys="NSE_EQ|INE002A01018", interval="1d".',
    schema: z.object({
      instrument_keys: z.string().min(1).describe('Comma-separated instrument keys (up to 500)'),
      interval: z.string().min(1).describe('OHLC interval, e.g. "1d"'),
    }),
  },
)

// 4) Historical candles (v2 or v3).
export const historicalCandles = tool(
  async ({ instrument_key, source, interval, unit, to_date, from_date }) => {
    if (source === 'v3' && !unit) {
      return JSON.stringify({ error: 'unit is required when source=v3 (minutes|hours|days)' })
    }
    const path =
      source === 'v2'
        ? `/historical-data/v2/candles/${enc(instrument_key)}/${enc(interval)}/${to_date}`
        : `/historical-data/v3/candles/${enc(instrument_key)}/${unit}/${enc(interval)}/${to_date}`
    return apiCall('GET', path, from_date ? { fromDate: from_date } : undefined)
  },
  {
    name: 'historical_candles',
    description:
      'Fetch historical OHLC candles from Upstox (NOT stored — use sync_candles to store). source=v2 interval is 1minute|30minute|day|week|month (no unit). source=v3 needs unit minutes|hours|days + a numeric interval string. to_date is required; from_date optional (omit for default lookback). Example: instrument_key="NSE_INDEX|Nifty 50", source="v3", interval="5", unit="minutes", to_date="2026-06-10", from_date="2026-06-01".',
    schema: z.object({
      instrument_key: z.string().min(1).describe('Upstox instrument key, e.g. "NSE_EQ|INE002A01018"'),
      source: z.enum(['v2', 'v3']).describe('Upstox historical API version'),
      interval: z
        .string()
        .min(1)
        .describe('v2: 1minute|30minute|day|week|month. v3: positive integer string e.g. "5"'),
      unit: z
        .enum(['minutes', 'hours', 'days'])
        .optional()
        .describe('Required when source=v3'),
      to_date: z.string().describe('End date, YYYY-MM-DD'),
      from_date: z.string().optional().describe('Start date, YYYY-MM-DD. Omit for default lookback.'),
    }),
  },
)

// 5) Intraday candles (v2 or v3).
export const intradayCandles = tool(
  async ({ instrument_key, source, interval, unit }) => {
    if (source === 'v3' && !unit) {
      return JSON.stringify({ error: 'unit is required when source=v3 (minutes|hours|days)' })
    }
    const path =
      source === 'v2'
        ? `/historical-data/v2/intraday/${enc(instrument_key)}/${enc(interval)}`
        : `/historical-data/v3/intraday/${enc(instrument_key)}/${unit}/${enc(interval)}`
    return apiCall('GET', path)
  },
  {
    name: 'intraday_candles',
    description:
      'Fetch intraday OHLC candles for the current trading day (NOT stored). source=v2 interval 1minute|30minute|day|week|month (no unit); source=v3 needs unit minutes|hours|days + numeric interval. Example: instrument_key="NSE_EQ|INE002A01018", source="v2", interval="30minute".',
    schema: z.object({
      instrument_key: z.string().min(1).describe('Upstox instrument key'),
      source: z.enum(['v2', 'v3']).describe('Upstox historical API version'),
      interval: z.string().min(1).describe('v2: 1minute|30minute|day|week|month. v3: numeric string e.g. "5"'),
      unit: z.enum(['minutes', 'hours', 'days']).optional().describe('Required when source=v3'),
    }),
  },
)

// 6) Option chain.
export const optionChain = tool(
  async ({ instrument_key, expiry_date }) =>
    apiCall('GET', '/option-chain/chain', { instrumentKey: instrument_key, expiryDate: expiry_date }),
  {
    name: 'option_chain',
    description:
      'Get the put/call option chain for an underlying instrument + expiry. Example: instrument_key="NSE_INDEX|Nifty 50", expiry_date="2026-06-26".',
    schema: z.object({
      instrument_key: z.string().min(1).describe('Underlying instrument key, e.g. "NSE_INDEX|Nifty 50"'),
      expiry_date: z.string().describe('Expiry date, YYYY-MM-DD'),
    }),
  },
)

// 7) Market status for an exchange.
export const marketStatus = tool(
  async ({ exchange }) => apiCall('GET', `/market-info/status/${enc(exchange)}`),
  {
    name: 'market_status',
    description:
      'Get the current market status (open/closed) for an exchange. Example: exchange="NSE".',
    schema: z.object({
      exchange: z.string().min(1).describe('Exchange code, e.g. "NSE"'),
    }),
  },
)