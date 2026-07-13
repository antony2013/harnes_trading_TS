// apps/deepagent/src/eval/cases/orchestration.ts
import type { EvalCase } from '../types'

const candleBody = {
  data: { candles: Array.from({ length: 30 }, (_, i) => [i, 100, 101, 99, 100.5, 1000, 0]) },
}

export const orchestrationCases: EvalCase[] = [
  {
    id: 'or-1',
    category: 'orchestration',
    prompt: 'Compute the 14-day RSI for RELIANCE, TCS, INFY, HDFCBANK, and ITC. Return the five values.',
    stubRoutes: [
      { method: 'GET', path: '/historical-data/v2/candles', body: candleBody },
      { method: 'GET', path: '/instruments/search', body: { data: [{ instrument_key: 'NSE_EQ|RELIANCE', name: 'Reliance' }] } },
    ],
    assertions: [
      {
        kind: 'custom',
        label: 'delegated-or-batched',
        check: (t) => {
          const marketTools = new Set([
            'search_instruments', 'get_ltp', 'get_ohlc_quote', 'historical_candles',
            'intraday_candles', 'option_chain', 'market_status', 'read_candles',
            'company_profile', 'news', 'sync_candles', 'sync_expired_candles',
            'call_api',
          ])
          const direct = t.filter((s) => marketTools.has(s.name) && s.scope === 'coordinator').length
          return direct >= 5
            ? { passed: false, detail: `${direct} direct coordinator market-data calls — should delegate/batch via task/eval` }
            : { passed: true }
        },
      },
    ],
  },
]