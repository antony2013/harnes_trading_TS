import { test, expect, beforeEach } from 'bun:test'
import { ToolMessage } from '@langchain/core/messages'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildModel, resolveAgentConfig, workspaceDir, WORKSPACE_PERMISSIONS, buildBackend, buildAgent, PTC_ALLOWLIST, READ_ONLY_TOOLS, SUBAGENTS } from './agent'
import { buildInterpreterMiddleware, buildReadFileContinuationMiddleware } from './profiles/implementations'

beforeEach(() => {
  process.env.AGENT_SETTINGS_PATH = `/tmp/agent-settings-${Math.random().toString(36).slice(2)}.json`
  delete process.env.DEEPAGENT_MODEL
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
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

test('buildModel: openrouter -> ChatOpenAI', () => {
  const m = buildModel({ provider: 'openrouter', apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' })
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

test('resolveAgentConfig: env fallback parses provider:model for openrouter', () => {
  process.env.DEEPAGENT_MODEL = 'openrouter:deepseek/deepseek-chat'
  process.env.OPENROUTER_API_KEY = 'sk-or-test'
  const cfg = resolveAgentConfig()
  expect(cfg).toEqual({ provider: 'openrouter', model: 'deepseek/deepseek-chat', apiKey: 'sk-or-test', baseUrl: 'https://openrouter.ai/api/v1' })
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

test('buildAgent: constructs with interpreter middleware without throwing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'da-')) + '/mw'
  process.env.AGENT_WORKSPACE_DIR = root
  const agent = await buildAgent({ provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama3' })
  expect(agent).toBeTruthy()
  expect(existsSync(root)).toBe(true)
})

test('READ_ONLY_TOOLS: 10 read-only data tools from allTools, excludes sync_candles + call_api', () => {
  const names = READ_ONLY_TOOLS.map((t: any) => t.name)
  expect(names.sort()).toEqual([...PTC_ALLOWLIST].sort())
  expect(names).not.toContain('sync_candles')
  expect(names).not.toContain('call_api')
})

test('buildInterpreterMiddleware: { subagents: false } returns truthy without throwing', () => {
  const mw = buildInterpreterMiddleware({ subagents: false })
  expect(mw).toBeTruthy()
})

test('SUBAGENTS: exactly 3 named subagents, no duplicates, general-purpose present', () => {
  const names = SUBAGENTS.map((s: any) => s.name)
  expect(names).toHaveLength(3)
  expect(new Set(names).size).toBe(3)
  expect(names).toContain('general-purpose')
  expect(names).toContain('quant')
  expect(names).toContain('reporter')
})

test('SUBAGENTS: general-purpose + quant use READ_ONLY_TOOLS; reporter tools empty', () => {
  const byName = Object.fromEntries(SUBAGENTS.map((s: any) => [s.name, s]))
  expect(byName['general-purpose'].tools).toBe(READ_ONLY_TOOLS)
  expect(byName['quant'].tools).toBe(READ_ONLY_TOOLS)
  expect(byName['reporter'].tools).toEqual([])
})

test('SUBAGENTS: quant has middleware; general-purpose + reporter have none', () => {
  const byName = Object.fromEntries(SUBAGENTS.map((s: any) => [s.name, s]))
  expect(Array.isArray(byName['quant'].middleware)).toBe(true)
  expect(byName['quant'].middleware.length).toBeGreaterThan(0)
  expect(byName['general-purpose'].middleware).toBeUndefined()
  expect(byName['reporter'].middleware).toBeUndefined()
})

test('buildAgent: constructs with subagents without throwing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'da-')) + '/sub'
  process.env.AGENT_WORKSPACE_DIR = root
  const agent = await buildAgent({ provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama3' })
  expect(agent).toBeTruthy()
  expect(existsSync(root)).toBe(true)
})

// ReadFileContinuationNoticeMiddleware (ported from NVIDIA's Nemotron Ultra harness
// profile). Verifies the pagination-boundary notice: fires when read_file returns
// exactly `limit` line-numbered lines, silent below the limit, pass-through for
// non-read_file tools.
test('buildReadFileContinuationMiddleware: appends notice when read_file returns == limit line-numbered lines', async () => {
  const mw = buildReadFileContinuationMiddleware()
  const lines = Array.from({ length: 100 }, (_, i) => `${i + 1}\tline ${i + 1}`).join('\n')
  const handler = async () => new ToolMessage({ content: lines, tool_call_id: 'tc1', name: 'read_file' })
  const out: any = await mw.wrapToolCall({ toolCall: { name: 'read_file', args: { offset: 0, limit: 100 } } }, handler)
  expect(out.content).toContain('continues past this read window')
  expect(out.content).toContain('offset=100')
  expect(out.tool_call_id).toBe('tc1')
  expect(out.name).toBe('read_file')
})

test('buildReadFileContinuationMiddleware: silent when read_file returns < limit lines', async () => {
  const mw = buildReadFileContinuationMiddleware()
  const lines = Array.from({ length: 50 }, (_, i) => `${i + 1}\tline ${i + 1}`).join('\n')
  const handler = async () => new ToolMessage({ content: lines, tool_call_id: 'tc2', name: 'read_file' })
  const out: any = await mw.wrapToolCall({ toolCall: { name: 'read_file', args: { offset: 0, limit: 100 } } }, handler)
  expect(out.content).not.toContain('continues past this read window')
})

test('buildReadFileContinuationMiddleware: pass-through for non-read_file tools', async () => {
  const mw = buildReadFileContinuationMiddleware()
  const handler = async () => new ToolMessage({ content: 'ok', tool_call_id: 'tc3', name: 'get_ltp' })
  const out: any = await mw.wrapToolCall({ toolCall: { name: 'get_ltp', args: {} } }, handler)
  expect(out.content).toBe('ok')
})

test('buildReadFileContinuationMiddleware: returns truthy middleware object without throwing', () => {
  const mw = buildReadFileContinuationMiddleware()
  expect(mw).toBeTruthy()
  expect(typeof mw.wrapToolCall).toBe('function')
})
