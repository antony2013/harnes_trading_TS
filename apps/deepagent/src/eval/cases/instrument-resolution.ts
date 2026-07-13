// apps/deepagent/src/eval/cases/instrument-resolution.ts
import type { EvalCase } from '../types'

export const instrumentResolutionCases: EvalCase[] = [
  {
    id: 'ir-1',
    category: 'instrument-resolution',
    prompt: 'Get the last traded price of Tata Consultancy Services.',
    stubRoutes: [
      {
        method: 'GET',
        path: '/instruments/search',
        body: { data: [{ instrument_key: 'NSE_EQ|INE002A01018', name: 'Tata Consultancy Services', trading_symbol: 'TCS' }] },
      },
      {
        method: 'GET',
        path: '/market-quote/v3/ltp',
        body: { data: { 'NSE_EQ|INE002A01018': { last_price: 3850.5 } } },
      },
    ],
    assertions: [
      { kind: 'order', sequence: ['search_instruments', 'get_ltp'] },
      { kind: 'calls', tool: 'get_ltp', min: 1 },
    ],
  },
  {
    id: 'ir-2',
    category: 'instrument-resolution',
    prompt: "What's the last traded price of NSE_EQ|INE002A01018?",
    stubRoutes: [
      { method: 'GET', path: '/market-quote/v3/ltp', body: { data: { 'NSE_EQ|INE002A01018': { last_price: 3850.5 } } } },
    ],
    assertions: [
      { kind: 'not_called', tool: 'search_instruments' },
      { kind: 'first_is', tool: 'get_ltp' },
      { kind: 'arg_in', tool: 'get_ltp', arg: 'instrument_keys', values: ['NSE_EQ|INE002A01018'] },
    ],
  },
]