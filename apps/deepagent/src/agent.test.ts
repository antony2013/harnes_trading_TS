import { test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildModel, resolveAgentConfig, workspaceDir, WORKSPACE_PERMISSIONS, buildBackend, buildAgent, PTC_ALLOWLIST, buildInterpreterMiddleware } from './agent'

beforeEach(() => {
  process.env.AGENT_SETTINGS_PATH = `/tmp/agent-settings-${Math.random().toString(36).slice(2)}.json`
  delete process.env.DEEPAGENT_MODEL
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.AGENT_WORKSPACE_DIR
})

test('buildModel: ollama -> ChatOllama', () => {
  const m = buildModel({ provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama3' })
  expect(m.constructor.name).toBe('ChatOllama')
})

test('buildModel: custom -> ChatOpenAI', () => {
  const m = buildModel({ provider: 'custom', apiKey: 'k', baseUrl: 'http://x/v1', model: 'gpt' })
  expect(m.constructor.name).toBe('ChatOpenAI')
})

test('buildModel: anthropic -> ChatAnthropic', () => {
  const m = buildModel({ provider: 'anthropic', apiKey: 'k', baseUrl: '', model: 'claude' })
  expect(m.constructor.name).toBe('ChatAnthropic')
})

test('resolveAgentConfig: env fallback parses provider:model', () => {
  process.env.DEEPAGENT_MODEL = 'openai:gpt-4o-mini'
  process.env.OPENAI_API_KEY = 'sk-test'
  const cfg = resolveAgentConfig()
  expect(cfg).toEqual({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test', baseUrl: '' })
})

test('resolveAgentConfig: null when no settings + no env', () => {
  expect(resolveAgentConfig()).toBeNull()
})

test('workspaceDir: honors AGENT_WORKSPACE_DIR', () => {
  process.env.AGENT_WORKSPACE_DIR = '/tmp/ws-x'
  expect(workspaceDir()).toBe('/tmp/ws-x')
})

test('workspaceDir: default ends with api/data/agent-workspace', () => {
  expect(workspaceDir().replace(/\\/g, '/')).toMatch(/\/api\/data\/agent-workspace$/)
})

test('WORKSPACE_PERMISSIONS: single allow-all rule', () => {
  expect(WORKSPACE_PERMISSIONS).toEqual([
    { operations: ['read', 'write'], paths: ['/**'], mode: 'allow' },
  ])
})

test('buildBackend: write/read round-trips through rootDir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'da-'))
  const b = buildBackend(root)
  await b.write('notes.txt', 'hello')
  const r: any = await b.read('notes.txt')
  expect(r.content).toBe('hello')
})

test('buildAgent: creates workspace dir if missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'da-')) + '/missing'
  process.env.AGENT_WORKSPACE_DIR = root
  await buildAgent({ provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama3' })
  expect(existsSync(root)).toBe(true)
})

// Security invariant: virtualMode must confine the agent to rootDir.
// A '..' escape returns an error result (never content), guarding the
// sensitive sibling files in apps/api/data/ (e.g. agent-settings.json).
test('buildBackend: rejects path traversal outside rootDir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'da-'))
  const b = buildBackend(root)
  const r: any = await b.read('../escape.txt')
  expect(r.error).toMatch(/Path traversal not allowed/)
  expect(r.content).toBeUndefined()
})

test('PTC_ALLOWLIST: 10 read-only data tools, excludes sync_candles + call_api', () => {
  expect(PTC_ALLOWLIST).toEqual([
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
  ])
  expect(PTC_ALLOWLIST).not.toContain('sync_candles')
  expect(PTC_ALLOWLIST).not.toContain('call_api')
})

test('buildInterpreterMiddleware: returns a truthy middleware object without throwing', () => {
  const mw = buildInterpreterMiddleware()
  expect(mw).toBeTruthy()
})