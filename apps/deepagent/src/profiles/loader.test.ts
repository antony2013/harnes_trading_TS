// apps/deepagent/src/profiles/loader.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProfile, mergeProfiles } from './loader'
import { DEFAULT_PROFILE_DATA } from './defaults'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prof-'))
  process.env.AGENT_PROFILES_DIR = dir
})
afterEach(() => {
  delete process.env.AGENT_PROFILES_DIR
  rmSync(dir, { recursive: true, force: true })
})
function write(name: string, content: string) { writeFileSync(join(dir, name), content) }

test('loadProfile: default.jsonc == DEFAULT_PROFILE_DATA (no drift)', () => {
  write('default.jsonc', JSON.stringify(DEFAULT_PROFILE_DATA, null, 2))
  const p = loadProfile('ollama', 'llama3')
  expect(p).toEqual(DEFAULT_PROFILE_DATA)
})

test('loadProfile: no files at all -> built-in floor (complete, valid)', () => {
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
  const p = loadProfile('ollama', 'llama3')
  expect(p).toEqual(DEFAULT_PROFILE_DATA)
})

test('mergeProfiles: arrays replace (ptcAllowlist)', () => {
  const lower = DEFAULT_PROFILE_DATA
  const merged = mergeProfiles(lower, { ...DEFAULT_PROFILE_DATA, ptcAllowlist: ['get_ltp'] })
  expect(merged.ptcAllowlist).toEqual(['get_ltp'])
})

test('mergeProfiles: subagents merge by name (patch + keep + append)', () => {
  const lower = DEFAULT_PROFILE_DATA
  const higher: any = {
    subagents: [
      { name: 'quant', systemPrompt: 'NEW quant prompt' },
      { name: 'analyst', description: 'd', systemPrompt: 's', tools: 'readOnly', middleware: [] },
    ],
  }
  const merged = mergeProfiles(lower, higher)
  const byName = Object.fromEntries(merged.subagents.map((s) => [s.name, s]))
  expect(merged.subagents.map((s) => s.name)).toEqual(['general-purpose', 'quant', 'reporter', 'analyst'])
  expect(byName['quant'].systemPrompt).toBe('NEW quant prompt')
  expect(byName['quant'].tools).toBe('readOnly')            // kept from lower (patch omitted tools)
  expect(byName['general-purpose'].systemPrompt).toBe(DEFAULT_PROFILE_DATA.subagents[0].systemPrompt) // kept
  expect(byName['analyst'].systemPrompt).toBe('s')          // appended
})

test('loadProfile: 4-level chain order (model > provider > global > built-in)', () => {
  write('default.jsonc', JSON.stringify({ ...DEFAULT_PROFILE_DATA, systemPromptSuffix: 'G' }))
  write('anthropic__default.jsonc', JSON.stringify({ systemPromptSuffix: 'P', interpreter: { executionTimeoutMs: 45000, subagents: true } }))
  write('anthropic__claude-opus-4-8.jsonc', JSON.stringify({ systemPromptSuffix: 'M' }))
  const p = loadProfile('anthropic', 'claude-opus-4-8')
  expect(p.systemPromptSuffix).toBe('M')                       // model wins
  expect(p.interpreter.executionTimeoutMs).toBe(45000)         // provider default wins (model omits)
  expect(p.ptcAllowlist).toEqual(DEFAULT_PROFILE_DATA.ptcAllowlist) // global (model+provider omit) = global value
  expect(p.subagents.map((s) => s.name).sort()).toEqual(['general-purpose', 'quant', 'reporter']) // from global
})

test('loadProfile: provider default inherited by a model that omits the field', () => {
  write('default.jsonc', JSON.stringify(DEFAULT_PROFILE_DATA))
  write('openrouter__default.jsonc', JSON.stringify({ systemPromptSuffix: 'provider-suffix' }))
  write('openrouter__anthropic_claude-3.5-sonnet.jsonc', JSON.stringify({}))  // sanitize: '/' -> '_'
  const p = loadProfile('openrouter', 'anthropic/claude-3.5-sonnet')
  expect(p.systemPromptSuffix).toBe('provider-suffix')
})

test('loadProfile: schema rejects unknown field', () => {
  write('default.jsonc', JSON.stringify(DEFAULT_PROFILE_DATA))
  write('ollama__llama3.jsonc', '{ "oops": 1 }')
  expect(() => loadProfile('ollama', 'llama3')).toThrow(/schema/i)
})

test('loadProfile: reference validation rejects unknown middleware', () => {
  write('default.jsonc', JSON.stringify(DEFAULT_PROFILE_DATA))
  write('ollama__llama3.jsonc', JSON.stringify({ middleware: ['nope'] }))
  expect(() => loadProfile('ollama', 'llama3')).toThrow(/unknown middleware: "nope"/)
})

test('loadProfile: reference validation rejects unknown tool in ptcAllowlist', () => {
  write('default.jsonc', JSON.stringify(DEFAULT_PROFILE_DATA))
  write('ollama__llama3.jsonc', JSON.stringify({ ptcAllowlist: ['nope'] }))
  expect(() => loadProfile('ollama', 'llama3')).toThrow(/unknown tool: "nope"/)
})

test('loadProfile: rejects profileVersion != 1', () => {
  write('default.jsonc', JSON.stringify({ ...DEFAULT_PROFILE_DATA, profileVersion: 2 }))
  expect(() => loadProfile('ollama', 'llama3')).toThrow(/profileVersion|version/i)
})

test('loadProfile: rejects duplicate subagent name in merged result', () => {
  write('default.jsonc', JSON.stringify(DEFAULT_PROFILE_DATA))
  write('ollama__llama3.jsonc', JSON.stringify({ subagents: [
    { name: 'reporter', description: 'dup', systemPrompt: 's', tools: 'none', middleware: [] },
    { name: 'reporter', description: 'dup2', systemPrompt: 's2', tools: 'none', middleware: [] },
  ] }))
  expect(() => loadProfile('ollama', 'llama3')).toThrow(/duplicate subagent name: "reporter"/)
})