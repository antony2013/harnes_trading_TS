import { createDeepAgent, FilesystemBackend } from 'deepagents'
import type { FilesystemPermission } from 'deepagents'
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
You have a virtual filesystem (ls, read_file, write_file, edit_file, glob, grep) rooted at a workspace directory. Use it to persist analysis, notes, and intermediate results across the conversation. Prefer write_file for new artifacts and edit_file for small changes.`

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