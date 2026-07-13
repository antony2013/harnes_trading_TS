// apps/deepagent/src/profiles/blocks.test.ts
import { test, expect } from 'bun:test'
import { BLOCKS, BASE_BLOCK_ORDER, assembleBase } from './blocks'
import { assembleSystemPrompt } from './prompt'
import type { ResolvedProfile } from './types'

// Today's exact SYSTEM_PROMPT (agent.ts:14-25). The byte-for-byte contract.
const BASELINE = [
  'You are a trading assistant for the Indian stock market, backed by the local Upstox trading API.',
  'Use the provided tools to answer the user\'s question.',
  '- Instrument keys look like "NSE_EQ|INE002A01018" or "NSE_INDEX|Nifty 50". Use search_instruments if you don\'t know the key.',
  '- Timeframes are canonical labels: v2 raw (1minute, 30minute, day, week, month) or v3 {interval}{unit} (e.g. 5minutes, 1days).',
  '- Dates are YYYY-MM-DD.',
  '- To store candles for a backtest, use sync_candles (source=v2|v3) or sync_expired_candles for EXPIRED instruments (interval 1minute|3minute|5minute|15minute|30minute|day — no week/month, no unit); to read stored candles, use read_candles (timeframe=interval, e.g. "3minute" or "day" for expired).',
  '- If a tool returns an error object, read it and retry with corrected parameters.',
  '- If the API is unreachable, tell the user to start apps/api (bun run dev in apps/api).',
  'Be concise. Prefer tools over guessing.',
  'You have a virtual filesystem (ls, read_file, write_file, edit_file, glob, grep) rooted at a workspace directory. Use it to persist analysis, notes, and intermediate results across the conversation. Prefer write_file for new artifacts and edit_file for small changes.',
  'You have an `eval` tool that runs JavaScript in a sandboxed QuickJS interpreter (no filesystem, network, or shell access). The read-only market-data tools are available inside `eval` as `tools.*` (e.g. `tools.get_ltp`, `tools.historical_candles`, `tools.search_instruments`). Use `eval` for loops, parallel/batched fetches, and deterministic transforms (indicators, aggregation, filtering) instead of one tool call per turn. For multi-step data work, write a workflow in `eval`.',
  'You can delegate to specialist subagents with the `task` tool, or from inside `eval` via the `task()` global: `task({ description, subagentType, responseSchema })` runs a full agentic loop on a subagent and resolves to its result. Subagents: `general-purpose` (research/fetch market data), `quant` (fetch candles + compute indicators in its own eval), `reporter` (write reports/artifacts to the workspace filesystem). Use `Promise.all` in `eval` to fan out across instruments, then synthesize. Prefer `task()` orchestration for multi-step, multi-symbol analysis instead of doing it all yourself turn-by-turn.',
].join('\n')

function fakeProfile(over: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    profileVersion: 1,
    systemPromptSuffix: '',
    ptcAllowlist: [],
    interpreter: { executionTimeoutMs: 30000, subagents: true },
    parentMiddleware: [],
    subagents: [],
    flags: { injectTodayDate: true },
    ...over,
  } as ResolvedProfile
}

test('blocks: every BASE_BLOCK_ORDER entry exists in BLOCKS', () => {
  for (const b of BASE_BLOCK_ORDER) expect(BLOCKS[b]).toBeTypeOf('string')
})

test('blocks: BASE_BLOCK_ORDER has no duplicates', () => {
  expect(new Set(BASE_BLOCK_ORDER).size).toBe(BASE_BLOCK_ORDER.length)
})

test('blocks: assembleBase reproduces today\'s SYSTEM_PROMPT byte-for-byte', () => {
  expect(assembleBase()).toBe(BASELINE)
})

test('prompt: assembleSystemPrompt with injectTodayDate + empty suffix = date prefix + base', () => {
  const out = assembleSystemPrompt(fakeProfile(), '2026-07-13')
  expect(out.startsWith('Today\'s date is 2026-07-13 (IST, Indian market calendar).')).toBe(true)
  expect(out).toContain(BASELINE)
  expect(out).toBe(`Today's date is 2026-07-13 (IST, Indian market calendar). Treat this as the real current date for "current date"/"today" questions and as the default toDate for recent data.\n\n${BASELINE}`)
})

test('prompt: injectTodayDate=false omits the date prefix', () => {
  const out = assembleSystemPrompt(fakeProfile({ flags: { injectTodayDate: false } }), '2026-07-13')
  expect(out.startsWith(BASELINE)).toBe(true)
  expect(out).not.toContain('Today\'s date is')
})

test('prompt: non-empty suffix appended after base', () => {
  const out = assembleSystemPrompt(fakeProfile({ systemPromptSuffix: 'Prefer tools.' }), '2026-07-13')
  expect(out.endsWith(BASELINE + '\n\nPrefer tools.')).toBe(true)
})