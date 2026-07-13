// apps/deepagent/src/profiles/schema.test.ts
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'

const here = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(join(here, 'schema.json'), 'utf8'))
const ajv = new Ajv2020({ allErrors: true })
const validate = ajv.compile(schema)

function ok(data: unknown) { return validate(data) === true }
function errs() { return (validate.errors ?? []).map((e: any) => `${e.instancePath} ${e.keyword} ${e.message}`).join('; ') }

test('schema: a complete valid profile passes', () => {
  expect(ok({
    profileVersion: 1,
    systemPromptSuffix: 'Be concise.',
    ptcAllowlist: ['get_ltp', 'news'],
    interpreter: { executionTimeoutMs: 30000, subagents: true },
    middleware: ['interpreter', 'coerceToolContent'],
    subagents: [{ name: 'quant', description: 'd', systemPrompt: 's', tools: 'readOnly', middleware: ['interpreter'] }],
    flags: { injectTodayDate: true },
  })).toBe(true)
})

test('schema: a partial override (only systemPromptSuffix) passes', () => {
  expect(ok({ systemPromptSuffix: 'x' })).toBe(true)
})

test('schema: unknown top-level field rejected (additionalProperties false)', () => {
  expect(ok({ oops: 1 })).toBe(false)
  expect(errs()).toContain('additionalProperties')
})

test('schema: profileVersion must be const 1', () => {
  expect(ok({ profileVersion: 2 })).toBe(false)
})

test('schema: unknown tools enum rejected', () => {
  expect(ok({ subagents: [{ name: 'q', tools: 'writable' }] })).toBe(false)
})

test('schema: subagent item requires name', () => {
  expect(ok({ subagents: [{ description: 'd' }] })).toBe(false)
})

test('schema: unknown flag rejected (additionalProperties false on flags)', () => {
  expect(ok({ flags: { unknownFlag: true } })).toBe(false)
})

test('schema: executionTimeoutMs minimum 1', () => {
  expect(ok({ interpreter: { executionTimeoutMs: 0, subagents: true } })).toBe(false)
})