import { test, expect, beforeEach } from 'bun:test'
import { readSettings, writeSettings, toView, maskKey } from './settings'

beforeEach(() => {
  process.env.AGENT_SETTINGS_PATH = `/tmp/agent-settings-${Math.random().toString(36).slice(2)}.json`
})

test('maskKey: long key -> prefix...suffix', () => {
  expect(maskKey('sk-abcdefghijklmnop')).toBe('sk-...mnop')
})

test('maskKey: empty -> empty', () => {
  expect(maskKey('')).toBe('')
})

test('maskKey: short key -> ****', () => {
  expect(maskKey('ab')).toBe('****')
})

test('readSettings: null when no file', () => {
  expect(readSettings()).toBeNull()
})

test('write then read round-trips', () => {
  writeSettings({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '' })
  expect(readSettings()).toEqual({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '' })
})

test('toView masks key + sets hasKey', () => {
  const v = toView({ provider: 'anthropic', baseUrl: '', model: 'claude', apiKey: 'sk-abcdefghijklmnop' })
  expect(v.apiKey).toBe('sk-...mnop')
  expect(v.hasKey).toBe(true)
})