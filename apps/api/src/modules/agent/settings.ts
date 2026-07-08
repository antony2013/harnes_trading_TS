import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export type Provider = 'anthropic' | 'openai' | 'ollama' | 'custom'

export interface AgentSettings {
  provider: Provider
  baseUrl: string
  model: string
  apiKey: string
}

export interface AgentSettingsView {
  provider: Provider
  baseUrl: string
  model: string
  apiKey: string // masked, e.g. "sk-...mnop" or ""
  hasKey: boolean
}

const OLLAMA_DEFAULT = 'http://localhost:11434'

function defaultSettingsPath(): string {
  // apps/api/src/modules/agent/settings.ts -> ../../../data/agent-settings.json
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../../data/agent-settings.json')
}

function settingsPath(): string {
  return process.env.AGENT_SETTINGS_PATH || defaultSettingsPath()
}

export function readSettings(): AgentSettings | null {
  const path = settingsPath()
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!raw || !raw.provider || !raw.model) return null
    return {
      provider: raw.provider as Provider,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
      model: raw.model,
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    }
  } catch {
    return null
  }
}

export function writeSettings(s: AgentSettings): void {
  const path = settingsPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n')
  renameSync(tmp, path) // atomic
}

export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return key.slice(0, 3) + '...' + key.slice(-4)
}

export function toView(s: AgentSettings): AgentSettingsView {
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    apiKey: maskKey(s.apiKey),
    hasKey: !!s.apiKey,
  }
}

export { OLLAMA_DEFAULT }