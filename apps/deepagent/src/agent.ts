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
import { loadProfile, resolveProfile, applyOpenShellOverride, applySearchOverride } from './profiles'
import type { OpenShellOverride, SearchOverride } from './profiles/types'
import { assembleSystemPrompt } from './profiles/prompt'

export type { OpenShellOverride, SearchOverride } from './profiles/types'
export { applyOpenShellOverride, applySearchOverride } from './profiles'

export type Provider = 'anthropic' | 'openai' | 'openrouter' | 'ollama' | 'custom'

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
export function workspaceDir(workspaceId?: string): string {
  const root = process.env.AGENT_WORKSPACE_DIR || defaultWorkspacePath()
  return workspaceId ? join(root, workspaceId) : root
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

export function buildModel(cfg: AgentConfig): BaseLanguageModel {
  switch (cfg.provider) {
    case 'anthropic':
      return new ChatAnthropic({ model: cfg.model, apiKey: cfg.apiKey })
    case 'openai':
      return new ChatOpenAI({ model: cfg.model, apiKey: cfg.apiKey })
    case 'openrouter':
      return new ChatOpenAI({
        model: cfg.model,
        apiKey: cfg.apiKey,
        configuration: {
          baseURL: cfg.baseUrl || 'https://openrouter.ai/api/v1',
          defaultHeaders: {
            'HTTP-Referer': 'https://github.com/harnesh-trading-ts',
            'X-Title': 'Harnesh Trading Agent'
          }
        }
      })
    case 'ollama':
      return new ChatOllama({ model: cfg.model, baseUrl: cfg.baseUrl || OLLAMA_DEFAULT })
    case 'custom':
      return new ChatOpenAI({ model: cfg.model, apiKey: cfg.apiKey, configuration: { baseURL: cfg.baseUrl } })
  }
}

/** Today's date as YYYY-MM-DD in IST (UTC+5:30) — the Indian market calendar.
 *  Injected into the system prompt so the agent knows the real current date
 *  (LLMs otherwise guess from tool-example dates). Computed at build time;
 *  buildAgent runs per chat request, so it's fresh each turn. */
function todayIST(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export async function buildAgent(cfg: AgentConfig, openshellOverride?: OpenShellOverride, searchOverride?: SearchOverride) {
  if (!cfg.model) throw new Error('Agent config missing model')
  const model = buildModel(cfg)
  const root = workspaceDir()
  mkdirSync(root, { recursive: true })
  let data = loadProfile(cfg.provider, cfg.model)
  if (openshellOverride) data = applyOpenShellOverride(data, openshellOverride)
  if (searchOverride) data = applySearchOverride(data, searchOverride)
  const profile = resolveProfile(data)
  const systemPrompt = assembleSystemPrompt(profile, todayIST())
  return createDeepAgent({
    model,
    tools: allTools,
    systemPrompt,
    backend: buildBackend(root),
    permissions: WORKSPACE_PERMISSIONS,
    // profiles layer stays import-free of deepagents types; cast at this seam
    middleware: profile.parentMiddleware as any,
    subagents: profile.subagents as any,
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
      provider === 'openai' ? process.env.OPENAI_API_KEY || '' :
      provider === 'openrouter' ? process.env.OPENROUTER_API_KEY || '' : ''
    return {
      provider,
      model,
      apiKey,
      baseUrl:
        provider === 'ollama' ? OLLAMA_DEFAULT :
        provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : ''
    }
  }
  return null
}