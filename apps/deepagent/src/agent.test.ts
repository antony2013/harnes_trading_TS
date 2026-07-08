import { test, expect, beforeEach } from 'bun:test'
import { buildModel, resolveAgentConfig, workspaceDir, WORKSPACE_PERMISSIONS } from './agent'

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