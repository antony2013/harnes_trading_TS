// apps/deepagent/src/eval/workspace.test.ts
import { test, expect } from 'bun:test'
import { createSeededWorkspace } from './workspace'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

test('creates dir + writes seed files; cleanup removes dir', () => {
  const ws = createSeededWorkspace([{ path: 'a.txt', content: 'hello' }, { path: 'sub/b.txt', content: 'nested' }])
  expect(existsSync(join(ws.dir, 'a.txt'))).toBe(true)
  expect(readFileSync(join(ws.dir, 'a.txt'), 'utf8')).toBe('hello')
  // nested path: ensure parent dir is created
  expect(existsSync(join(ws.dir, 'sub', 'b.txt'))).toBe(true)
  ws.cleanup()
  expect(existsSync(ws.dir)).toBe(false)
})

test('cleanup is idempotent (no throw on missing dir)', () => {
  const ws = createSeededWorkspace([])
  ws.cleanup()
  expect(() => ws.cleanup()).not.toThrow()
})