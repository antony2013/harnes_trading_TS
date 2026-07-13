// apps/deepagent/src/eval/cases/candle-sync.ts
import type { EvalCase } from '../types'

export const candleSyncCases: EvalCase[] = [
  {
    id: 'cs-1',
    category: 'candle-sync',
    prompt: 'Store daily candles for the expired NIFTY 26JUN60000 call option.',
    stubRoutes: [
      { method: 'POST', path: '/backtest/data/sync-expired', body: { stored: 30, chunks: 1, file: 'x.sqlite' } },
    ],
    assertions: [
      { kind: 'calls', tool: 'sync_expired_candles', min: 1 },
      { kind: 'arg_in', tool: 'sync_expired_candles', arg: 'interval', values: ['1minute', '3minute', '5minute', '15minute', '30minute', 'day'] },
      { kind: 'arg_not_in', tool: 'sync_expired_candles', arg: 'interval', values: ['week', 'month'] },
      { kind: 'not_called', tool: 'sync_candles' },
    ],
  },
  {
    id: 'cs-2',
    category: 'candle-sync',
    prompt: 'Sync 5-minute candles for NIFTY 50 (live) and store them locally.',
    stubRoutes: [
      { method: 'POST', path: '/backtest/data/sync', body: { stored: 100, chunks: 1, file: 'y.sqlite' } },
    ],
    assertions: [
      { kind: 'calls', tool: 'sync_candles', min: 1 },
      { kind: 'arg_in', tool: 'sync_candles', arg: 'source', values: ['v3'] },
      { kind: 'arg_in', tool: 'sync_candles', arg: 'unit', values: ['minutes'] },
      { kind: 'arg_matches', tool: 'sync_candles', arg: 'interval', regex: '^5$' },
    ],
  },
  {
    id: 'cs-3',
    category: 'candle-sync',
    prompt: 'Read back the daily candles I synced for the expired instrument NSE_FO|54452|24-04-2025.',
    stubRoutes: [
      {
        method: 'GET',
        path: '/backtest/data/candles/NSE_FO|54452|24-04-2025/day',
        body: [{ ts: 1, open: 100, high: 101, low: 99, close: 100.5, volume: 1000, oi: 50 }],
      },
    ],
    assertions: [
      { kind: 'calls', tool: 'read_candles', min: 1 },
      { kind: 'arg_in', tool: 'read_candles', arg: 'timeframe', values: ['day'] },
      { kind: 'arg_not_in', tool: 'read_candles', arg: 'timeframe', values: ['week', 'month'] },
    ],
  },
]