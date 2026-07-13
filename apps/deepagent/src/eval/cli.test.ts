// apps/deepagent/src/eval/cli.test.ts
import { test, expect } from 'bun:test'
import { parseArgs } from './cli'

test('parseArgs: model + provider + json + out', () => {
  const a = parseArgs(['--provider', 'ollama', '--model', 'llama3', '--json', '--out', 'r.json'])
  expect(a).toMatchObject({ provider: 'ollama', model: 'llama3', json: true, out: 'r.json' })
})

test('parseArgs: repeatable --category', () => {
  const a = parseArgs(['--category', 'candle-sync', '--category', 'orchestration'])
  expect(a.categories).toEqual(['candle-sync', 'orchestration'])
})

test('parseArgs: --case selects one id', () => {
  const a = parseArgs(['--case', 'cs-1'])
  expect(a.caseId).toBe('cs-1')
})

test('parseArgs: --from-settings flag', () => {
  expect(parseArgs(['--from-settings']).fromSettings).toBe(true)
})