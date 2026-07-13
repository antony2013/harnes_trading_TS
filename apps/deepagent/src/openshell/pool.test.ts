// apps/deepagent/src/openshell/pool.test.ts
import { test, expect, beforeEach } from 'bun:test'
import { WorkspacePool } from './pool'
import { InMemoryExecutionBackend } from './backend'

let backend: InMemoryExecutionBackend
beforeEach(() => { backend = new InMemoryExecutionBackend((cmd) => ({ output: `out:${cmd}`, exitCode: 0 })) })

test('WorkspacePool: lazy-creates a workspace once, reuses after', async () => {
  const pool = new WorkspacePool(backend, { idleTimeoutMs: 60_000 })
  await pool.exec('w1', 'a')
  await pool.exec('w1', 'b')
  // getOrCreateWorkspace called once for w1
  const creates = backend.execLog // exec called twice
  expect(creates).toHaveLength(2)
  // (getOrCreateWorkspace count is internal; assert via listWorkspaces size = 1)
  expect((await pool.list()).map((w) => w.id)).toEqual(['w1'])
})

test('WorkspacePool: isolates workspaces by id', async () => {
  const pool = new WorkspacePool(backend, { idleTimeoutMs: 60_000 })
  await pool.exec('w1', 'a')
  await pool.exec('w2', 'b')
  expect((await pool.list()).map((w) => w.id).sort()).toEqual(['w1', 'w2'])
})

test('WorkspacePool: serializes concurrent execs on the same id', async () => {
  let active = 0, maxActive = 0
  const slow = new InMemoryExecutionBackend(async (cmd) => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 10)); active--; return { output: cmd, exitCode: 0 } })
  // InMemoryExecutionBackend.resultFor is sync in Task 2; for this test use a custom backend:
  const backend2: import('./backend').ExecutionBackend = {
    async getOrCreateWorkspace(id) { return { id, phase: 'ready' } },
    async exec(id, command) { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 10)); active--; return { output: command, exitCode: 0 } },
    async destroyWorkspace() {},
    async listWorkspaces() { return [] },
  }
  const pool = new WorkspacePool(backend2, { idleTimeoutMs: 60_000 })
  await Promise.all([pool.exec('w1', 'x'), pool.exec('w1', 'y'), pool.exec('w1', 'z')])
  expect(maxActive).toBe(1)
})

test('WorkspacePool: reaps workspaces idle longer than idleTimeoutMs', async () => {
  const pool = new WorkspacePool(backend, { idleTimeoutMs: 0, reapIntervalMs: 5 })
  await pool.exec('w1', 'a')
  await new Promise((r) => setTimeout(r, 20))
  expect((await pool.list()).map((w) => w.id)).toEqual([])
})

test('WorkspacePool: does not reap a workspace with an in-flight exec', async () => {
  let resolve: () => void = () => {}
  const backend2: import('./backend').ExecutionBackend = {
    async getOrCreateWorkspace(id) { return { id, phase: 'ready' } },
    async exec() { await new Promise<void>((r) => (resolve = r)); return { output: '', exitCode: 0 } },
    async destroyWorkspace() {},
    async listWorkspaces() { return [] },
  }
  const pool = new WorkspacePool(backend2, { idleTimeoutMs: 0, reapIntervalMs: 5 })
  const inflight = pool.exec('w1', 'long')
  await new Promise((r) => setTimeout(r, 20))
  expect((await pool.list()).map((w) => w.id)).toEqual(['w1']) // not reaped
  resolve()
  await inflight
})