import { createDeepAgent, FilesystemBackend } from 'deepagents'
import type { FilesystemPermission } from 'deepagents'
import { createCodeInterpreterMiddleware } from '@langchain/quickjs'
import type { BaseLanguageModel } from '@langchain/core/language_models/base'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import { ChatOllama } from '@langchain/ollama'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { allTools } from './tools'

export const SYSTEM_PROMPT = `You are a trading assistant for the Indian stock market, backed by the local Upstox trading API.
Use the provided tools to answer the user's question.
- Instrument keys look like "NSE_EQ|INE002A01018" or "NSE_INDEX|Nifty 50". Use search_instruments if you don't know the key.
- Timeframes are canonical labels: v2 raw (1minute, 30minute, day, week, month) or v3 {interval}{unit} (e.g. 5minutes, 1days).
- Dates are YYYY-MM-DD.
- To store candles for a backtest, use sync_candles; to read stored candles, use read_candles.
- If a tool returns an error object, read it and retry with corrected parameters.
- If the API is unreachable, tell the user to start apps/api (bun run dev in apps/api).
Be concise. Prefer tools over guessing.
You have a virtual filesystem (ls, read_file, write_file, edit_file, glob, grep) rooted at a workspace directory. Use it to persist analysis, notes, and intermediate results across the conversation. Prefer write_file for new artifacts and edit_file for small changes.
You have an \`eval\` tool that runs JavaScript in a sandboxed QuickJS interpreter (no filesystem, network, or shell access). The read-only market-data tools are available inside \`eval\` as \`tools.*\` (e.g. \`tools.get_ltp\`, \`tools.historical_candles\`, \`tools.search_instruments\`). Use \`eval\` for loops, parallel/batched fetches, and deterministic transforms (indicators, aggregation, filtering) instead of one tool call per turn. For multi-step data work, write a workflow in \`eval\`.
You can delegate to specialist subagents with the \`task\` tool, or from inside \`eval\` via the \`task()\` global: \`task({ description, subagentType, responseSchema })\` runs a full agentic loop on a subagent and resolves to its result. Subagents: \`general-purpose\` (research/fetch market data), \`quant\` (fetch candles + compute indicators in its own eval), \`reporter\` (write reports/artifacts to the workspace filesystem). Use \`Promise.all\` in \`eval\` to fan out across instruments, then synthesize. Prefer \`task()\` orchestration for multi-step, multi-symbol analysis instead of doing it all yourself turn-by-turn.`

export type Provider = 'anthropic' | 'openai' | 'ollama' | 'custom'

export interface AgentConfig {
  provider: Provider
  apiKey: string
  baseUrl: string
  model: string
}

const OLLAMA_DEFAULT = 'http://localhost:11434'

/** Default workspace root: apps/api/data/agent-workspace (mirrors settingsPath()). */
function defaultWorkspacePath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../api/data/agent-workspace')
}

/** Resolve the agent workspace dir: AGENT_WORKSPACE_DIR env, else the default. */
export function workspaceDir(): string {
  return process.env.AGENT_WORKSPACE_DIR || defaultWorkspacePath()
}

/** Allow-all within the workspace. virtualMode already confines paths to rootDir;
 *  this explicit rule documents intent and makes future deny rules a one-liner. */
export const WORKSPACE_PERMISSIONS: FilesystemPermission[] = [
  { operations: ['read', 'write'], paths: ['/**'], mode: 'allow' },
]

/** Build the sandboxed filesystem backend rooted at `root`. */
export function buildBackend(root: string): FilesystemBackend {
  return new FilesystemBackend({ rootDir: root, virtualMode: true })
}

/** PTC allowlist: read-only market-data tools exposed inside the eval interpreter.
 *  Excludes sync_candles (server-side SQLite writes) and call_api (arbitrary endpoint
 *  passthrough) — this list is the interpreter's permission boundary. */
export const PTC_ALLOWLIST: string[] = [
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
]

/** Read-only market-data tools = allTools filtered to the PTC_ALLOWLIST names.
 *  Reuses the Phase A boundary as the single source of truth (no name drift).
 *  Excludes sync_candles + call_api — subagents never get the write/passthrough tools. */
export const READ_ONLY_TOOLS = allTools.filter((t: any) => PTC_ALLOWLIST.includes(t.name))

/** Build the code-interpreter middleware. opts.subagents === false disables the
 *  dynamic task() global (used for the quant subagent to bound recursion); the
 *  default (no arg) preserves the Phase A parent behavior (task() enabled). */
export function buildInterpreterMiddleware(opts?: { subagents?: boolean }) {
  return createCodeInterpreterMiddleware({
    ptc: PTC_ALLOWLIST,
    executionTimeoutMs: 30_000,
    ...(opts?.subagents === false ? { subagents: false } : {}),
  })
}

const QUANT_PROMPT = `You are a quant analyst for the Indian stock market. Fetch candles with the market-data tools and compute indicators / aggregations in eval (RSI, MACD, moving averages, returns, vol). Return concise numeric results. Do not write files.`

const GENERAL_PURPOSE_PROMPT = `You are a general-purpose research subagent for the Indian stock market. Use the market-data tools to search instruments, fetch LTP/OHLC/quotes, option chain, market status, company profile, and news. Summarize what you find concisely. Do not write files.`

const REPORTER_PROMPT = `You are a report writer. Given analysis results, write a clean markdown report to the workspace using write_file/edit_file. You have no market-data tools — work from what the caller provides.`

/** Subagents the parent can delegate to via the task tool or the eval task() global.
 *  general-purpose is defined here (named) to suppress the framework's auto
 *  general-purpose, which would inherit sync_candles + call_api. */
export const SUBAGENTS = [
  { name: 'general-purpose', description: 'Research/fetch market data: instrument search, LTP, quotes, option chain, news, company profile.', systemPrompt: GENERAL_PURPOSE_PROMPT, tools: READ_ONLY_TOOLS },
  { name: 'quant', description: 'Fetch candles and compute indicators/aggregations in eval (RSI, MACD, returns, vol).', systemPrompt: QUANT_PROMPT, tools: READ_ONLY_TOOLS, middleware: [buildInterpreterMiddleware({ subagents: false })] },
  { name: 'reporter', description: 'Write a markdown report/artifact to the workspace from provided analysis.', systemPrompt: REPORTER_PROMPT, tools: [] },
]

export function buildModel(cfg: AgentConfig): BaseLanguageModel {
  switch (cfg.provider) {
    case 'anthropic':
      return new ChatAnthropic({ model: cfg.model, apiKey: cfg.apiKey })
    case 'openai':
      return new ChatOpenAI({ model: cfg.model, apiKey: cfg.apiKey })
    case 'ollama':
      return new ChatOllama({ model: cfg.model, baseUrl: cfg.baseUrl || OLLAMA_DEFAULT })
    case 'custom':
      return new ChatOpenAI({ model: cfg.model, apiKey: cfg.apiKey, configuration: { baseURL: cfg.baseUrl } })
  }
}

export async function buildAgent(cfg: AgentConfig) {
  if (!cfg.model) {
    throw new Error('Agent config missing model')
  }
  const model = buildModel(cfg)

  const root = workspaceDir()
  mkdirSync(root, { recursive: true })

  return createDeepAgent({
    model,
    tools: allTools,
    systemPrompt: SYSTEM_PROMPT,
    backend: buildBackend(root),
    permissions: WORKSPACE_PERMISSIONS,
    middleware: [buildInterpreterMiddleware()],
    subagents: SUBAGENTS,
  })
}

function defaultSettingsPath(): string {
  // apps/deepagent/src/agent.ts -> ../../api/data/agent-settings.json
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../api/data/agent-settings.json')
}

function settingsPath(): string {
  return process.env.AGENT_SETTINGS_PATH || defaultSettingsPath()
}

export function resolveAgentConfig(): AgentConfig | null {
  // 1. settings file
  const path = settingsPath()
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      if (raw && raw.provider && raw.model) {
        return {
          provider: raw.provider as Provider,
          apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
          baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
          model: raw.model,
        }
      }
    } catch {
      /* fall through to env */
    }
  }
  // 2. env fallback (legacy CLI): DEEPAGENT_MODEL = "provider:model"
  const envModel = process.env.DEEPAGENT_MODEL
  if (envModel && envModel.includes(':')) {
    const idx = envModel.indexOf(':')
    const provider = envModel.slice(0, idx) as Provider
    const model = envModel.slice(idx + 1)
    const apiKey =
      provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY || '' :
      provider === 'openai' ? process.env.OPENAI_API_KEY || '' : ''
    return { provider, model, apiKey, baseUrl: provider === 'ollama' ? OLLAMA_DEFAULT : '' }
  }
  return null
}