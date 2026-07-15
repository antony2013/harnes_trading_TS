// apps/deepagent/src/profiles/defaults.ts
import type { ProfileData, SubagentSpec } from './types'

/** Compiled-in floor (layer 1 of the 4-level resolution chain). Seeded verbatim
 *  from today's hardcoded agent.ts values; identical to profiles/default.jsonc
 *  (locked by a loader test). The system loads even if profiles/ is wiped. */
export const DEFAULT_PROFILE_DATA: ProfileData = {
  profileVersion: 1,
  systemPromptSuffix: '',
  ptcAllowlist: [
    'search_instruments',
    'get_ltp',
    'get_ohlc_quote',
    'historical_candles',
    'intraday_candles',
    'option_chain',
    'market_status',
    'read_candles',
    'company_profile',
    'news',
  ],
  interpreter: { executionTimeoutMs: 30_000, subagents: true },
  middleware: ['interpreter', 'coerceToolContent', 'readFileContinuation'],
  subagents: [
    {
      name: 'general-purpose',
      description: 'Research/fetch market data: instrument search, LTP, quotes, option chain, news, company profile.',
      systemPrompt: 'You are a general-purpose research subagent for the Indian stock market. Use the market-data tools to search instruments, fetch LTP/OHLC/quotes, option chain, market status, company profile, and news. Summarize what you find concisely. Do not write files.',
      tools: 'readOnly',
      middleware: [],
    },
    {
      name: 'quant',
      description: 'Fetch candles and compute indicators/aggregations in eval (RSI, MACD, returns, vol).',
      systemPrompt: 'You are a quant analyst for the Indian stock market. Fetch candles with the market-data tools and compute indicators / aggregations in eval (RSI, MACD, moving averages, returns, vol). Return concise numeric results. Do not write files.',
      tools: 'readOnly',
      middleware: ['interpreter', 'coerceToolContent', 'readFileContinuation'],
    },
    {
      name: 'reporter',
      description: 'Write a markdown report/artifact to the workspace from provided analysis.',
      systemPrompt: 'You are a report writer. Given analysis results, write a clean markdown report to the workspace using write_file/edit_file. You have no market-data tools — work from what the caller provides.',
      tools: 'none',
      middleware: [],
    },
  ],
  flags: { injectTodayDate: true },
}

/** The search subagent, spliced into a profile by applySearchOverride when
 *  enabled. NOT part of DEFAULT_PROFILE_DATA — search is opt-in (off by default),
 *  mirroring OpenShell. tools:'none' because web_search/crawl_page are delivered
 *  via the 'search' middleware, not the static allTools registry. */
export const SEARCH_SUBAGENT: SubagentSpec = {
  name: 'search',
  description:
    'Search the public web (SearXNG) and read page content (Crawl4AI) for news, announcements, docs, or any topic the other tools cannot answer.',
  systemPrompt:
    'You are a web research subagent. Use web_search to find sources, then crawl_page on the 1-2 most relevant URLs to read their content. Return a concise synthesized answer with source URLs as citations. Prefer recent results. Do not write files.',
  tools: 'none',
  middleware: ['search'],
}