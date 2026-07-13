// apps/deepagent/src/openshell/backend.test.ts
import { test, expect } from 'bun:test'
import { InMemoryExecutionBackend, type ExecResult } from './backend'

test('InMemoryExecutionBackend: getOrCreateWorkspace creates ready then reuses', async () => {
  const b = new InMemoryExecutionBackend()
  const h1 = await b.getOrCreateWorkspace('w1')
  const h2 = await b.getOrCreateWorkspace('w1')
  expect(h1.phase).toBe('ready')
  expect(h2.id).toBe('w1')
})

test('InMemoryExecutionBackend: exec records log + returns canned/derived result', async () => {
  const b = new InMemoryExecutionBackend((cmd) => ({ output: `ran:${cmd}`, exitCode: 0 }))
  await b.getOrCreateWorkspace('w1')
  const r = await b.exec('w1', 'echo hi')
  expect(r).toEqual({ output: 'ran:echo hi', exitCode: 0 })
  expect(b.execLog).toEqual([{ id: 'w1', command: 'echo hi', opts: undefined }])
})

test('InMemoryExecutionBackend: exec on unknown workspace throws', async () => {
  const b = new InMemoryExecutionBackend()
  expect(b.exec('nope', 'x')).rejects.toThrow(/unknown workspace/)
})

test('InMemoryExecutionBackend: destroy + listWorkspaces', async () => {
  const b = new InMemoryExecutionBackend()
  await b.getOrCreateWorkspace('w1')
  await b.getOrCreateWorkspace('w2')
  expect((await b.listWorkspaces()).map((w) => w.id).sort()).toEqual(['w1', 'w2'])
  await b.destroyWorkspace('w1')
  expect((await b.listWorkspaces()).map((w) => w.id)).toEqual(['w2'])
})

test('InMemoryExecutionBackend: implements ExecutionBackend (structural)', async () => {
  const b: import('./backend').ExecutionBackend = new InMemoryExecutionBackend()
  expect(typeof b.getOrCreateWorkspace).toBe('function')
  expect(typeof b.exec).toBe('function')
  expect(typeof b.destroyWorkspace).toBe('function')
  expect(typeof b.listWorkspaces).toBe('function')
})