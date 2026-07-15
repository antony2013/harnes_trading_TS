// apps/api/src/modules/agent/search.ts
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export interface SearchSettings {
  enabled: boolean
  searxngBaseUrl: string
  crawl4aiBaseUrl: string
  maxResults: number
  crawlTimeoutMs: number
}

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  enabled: false,
  searxngBaseUrl: 'http://localhost:8080',
  crawl4aiBaseUrl: 'http://localhost:11235',
  maxResults: 5,
  crawlTimeoutMs: 60_000,
}

function defaultSettingsPath(): string {
  // apps/api/src/modules/agent/search.ts -> ../../../data/search-settings.json
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../../data/search-settings.json')
}

function settingsPath(): string {
  return process.env.AGENT_SEARCH_SETTINGS_PATH || defaultSettingsPath()
}

function isValid(raw: any): raw is SearchSettings {
  return !!raw
    && typeof raw.enabled === 'boolean'
    && typeof raw.searxngBaseUrl === 'string' && raw.searxngBaseUrl.length > 0
    && typeof raw.crawl4aiBaseUrl === 'string' && raw.crawl4aiBaseUrl.length > 0
    && typeof raw.maxResults === 'number'
    && typeof raw.crawlTimeoutMs === 'number'
}

export function readSearchSettings(): SearchSettings | null {
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

export function writeSearchSettings(s: SearchSettings): void {
  const path = settingsPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n')
  renameSync(tmp, path) // atomic
}

function base(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Verify SearXNG (/search?format=json) and Crawl4AI (/health) are reachable. */
export async function testSearch(s: SearchSettings): Promise<{ ok: boolean; detail: string }> {
  try {
    const sx = await fetch(`${base(s.searxngBaseUrl)}/search?q=test&format=json`, { signal: AbortSignal.timeout(8000) })
    if (!sx.ok) return { ok: false, detail: `SearXNG responded ${sx.status} at ${s.searxngBaseUrl}` }
    await sx.text()
  } catch (err: any) {
    return { ok: false, detail: `SearXNG not reachable at ${s.searxngBaseUrl} (${err?.message ?? err})` }
  }
  try {
    const c = await fetch(`${base(s.crawl4aiBaseUrl)}/health`, { signal: AbortSignal.timeout(8000) })
    if (!c.ok) return { ok: false, detail: `Crawl4AI responded ${c.status} at ${s.crawl4aiBaseUrl}` }
    await c.text()
  } catch (err: any) {
    return { ok: false, detail: `Crawl4AI not reachable at ${s.crawl4aiBaseUrl} (${err?.message ?? err})` }
  }
  return { ok: true, detail: 'SearXNG + Crawl4AI reachable.' }
}