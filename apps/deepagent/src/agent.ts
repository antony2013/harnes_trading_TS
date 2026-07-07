import { createDeepAgent } from 'deepagents'
import { allTools } from './tools'

export const SYSTEM_PROMPT = `You are a trading assistant for the Indian stock market, backed by the local Upstox trading API.
Use the provided tools to answer the user's question.
- Instrument keys look like "NSE_EQ|INE002A01018" or "NSE_INDEX|Nifty 50". Use search_instruments if you don't know the key.
- Timeframes are canonical labels: v2 raw (1minute, 30minute, day, week, month) or v3 {interval}{unit} (e.g. 5minutes, 1days).
- Dates are YYYY-MM-DD.
- To store candles for a backtest, use sync_candles; to read stored candles, use read_candles.
- If a tool returns an error object, read it and retry with corrected parameters.
- If the API is unreachable, tell the user to start apps/api (bun run dev in apps/api).
Be concise. Prefer tools over guessing.`

export async function buildAgent() {
  const model = process.env.DEEPAGENT_MODEL
  if (!model) {
    throw new Error(
      'Set DEEPAGENT_MODEL in apps/deepagent/.env (e.g. "anthropic:claude-sonnet-4-6" or "openai:gpt-4o-mini")',
    )
  }
  return createDeepAgent({ model, tools: allTools, systemPrompt: SYSTEM_PROMPT })
}