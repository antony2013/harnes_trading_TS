import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export interface OpenShellSettings {
  enabled: boolean
  image: string
  idleTimeoutMs: number
  bridgePort: number
  executionTimeoutMs: number
}

export const DEFAULT_OPENSHELL_IMAGE = 'harnesh/agent-sandbox:ubuntu-lts'

export const DEFAULT_OPENSHELL_SETTINGS: OpenShellSettings = {
  enabled: false,
  image: DEFAULT_OPENSHELL_IMAGE,
  idleTimeoutMs: 1_800_000, // 30 min
  bridgePort: 7777,
  executionTimeoutMs: 120_000, // 2 min
}

function defaultSettingsPath(): string {
  // apps/api/src/modules/agent/openshell.ts -> ../../../data/openshell-settings.json
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../../data/openshell-settings.json')
}

function settingsPath(): string {
  return process.env.AGENT_OPENSHELL_SETTINGS_PATH || defaultSettingsPath()
}

function isValid(raw: any): raw is OpenShellSettings {
  return !!raw
    && typeof raw.enabled === 'boolean'
    && typeof raw.image === 'string' && raw.image.length > 0
    && typeof raw.idleTimeoutMs === 'number'
    && typeof raw.bridgePort === 'number'
    && typeof raw.executionTimeoutMs === 'number'
}

export function readOpenShellSettings(): OpenShellSettings | null {
  const path = settingsPath()
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!isValid(raw)) return null
    return raw
  } catch {
    return null
  }
}

export function writeOpenShellSettings(s: OpenShellSettings): void {
  const path = settingsPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n')
  renameSync(tmp, path) // atomic
}