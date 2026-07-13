// apps/deepagent/src/profiles/parse-jsonc.test.ts
import { test, expect } from 'bun:test'
import { parseJsonc } from './parse-jsonc'

test('parseJsonc: parses plain JSON', () => {
  expect(parseJsonc('{"a":1}')).toEqual({ a: 1 })
})

test('parseJsonc: strips // line comments', () => {
  expect(parseJsonc('{\n  // a comment\n  "a": 1\n}')).toEqual({ a: 1 })
})

test('parseJsonc: strips /* block */ comments', () => {
  expect(parseJsonc('{\n  /* multi\n     line */\n  "a": 1\n}')).toEqual({ a: 1 })
})

test('parseJsonc: does not strip // or /* inside strings', () => {
  expect(parseJsonc('{"url":"https://x/y","c":"a // b"}')).toEqual({ url: 'https://x/y', c: 'a // b' })
})

test('parseJsonc: throws on malformed JSON after stripping', () => {
  expect(() => parseJsonc('{\n  // comment\n  "a":\n}')).toThrow()
})