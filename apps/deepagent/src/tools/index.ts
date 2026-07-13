import {
  searchInstruments,
  getLtp,
  getOhlcQuote,
  historicalCandles,
  intradayCandles,
  optionChain,
  marketStatus,
  syncCandles,
  syncExpiredCandles,
  readCandles,
  companyProfile,
  news,
} from './named'
import { callApiTool } from './call-api'

// 12 curated named tools + 1 generic call_api = 13 tools total.
export const allTools = [
  searchInstruments,
  getLtp,
  getOhlcQuote,
  historicalCandles,
  intradayCandles,
  optionChain,
  marketStatus,
  syncCandles,
  syncExpiredCandles,
  readCandles,
  companyProfile,
  news,
  callApiTool,
]