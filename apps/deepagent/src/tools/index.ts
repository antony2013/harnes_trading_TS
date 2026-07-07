import {
  searchInstruments,
  getLtp,
  getOhlcQuote,
  historicalCandles,
  intradayCandles,
  optionChain,
  marketStatus,
  syncCandles,
  readCandles,
  companyProfile,
  news,
} from './named'
import { callApiTool } from './call-api'

// 11 curated named tools + 1 generic call_api = 12 tools total.
export const allTools = [
  searchInstruments,
  getLtp,
  getOhlcQuote,
  historicalCandles,
  intradayCandles,
  optionChain,
  marketStatus,
  syncCandles,
  readCandles,
  companyProfile,
  news,
  callApiTool,
]