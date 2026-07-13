// apps/deepagent/src/openshell/middleware.test.ts
import { test, expect, beforeEach } from 'bun:test'
import { buildOpenShellMiddleware } from './middleware'
import { InMemoryExecutionBackend } from './backend'
import { _resetWorkspacePoolSingleton } from './pool'
import { _resetToolBridgeSingleton } from './bridge'

beforeEach(() => { _resetWorkspacePoolSingleton(); _resetToolBridgeSingleton() })

function makeMiddleware(backend: InMemoryExecutionBackend) {
  return buildOpenShellMiddleware({
    image: 'img:1', idleTimeoutMs: 60_000, bridgePort: 0,
    executionTimeoutMs: 30_000, ptcAllowlist: ['get_ltp'], allTools: [],
    backend,  // inject for testing
  })
}

test('buildOpenShellMiddleware: contributes a `shell` tool', async () => {
  const mw = makeMiddleware(new InMemoryExecutionBackend(() => ({ output: 'hi', exitCode: 0 })))
  expect(mw.name).toBe('OpenShellMiddleware')
  // The middleware contributes tools via the createMiddleware shape; assert the tool name.
  const tools = (mw as any).tools ?? []
  expect(tools.map((t: any) => t.name)).toContain('shell')
})

test('shell tool: execs a command in the workspace + returns output + exit + persistence note', async () => {
  const backend = new InMemoryExecutionBackend(() => ({ output: 'hello', exitCode: 0 }))
  const mw = makeMiddleware(backend)
  const shellTool = ((mw as any).tools as any[]).find((t) => t.name === 'shell')
  const res = await shellTool.invoke({ command: 'echo hello' }, { configurable: { workspace_id: 'w1' } })
  expect(res).toContain('hello')
  expect(res).toContain('exit: 0')
  expect(res).toContain('persistent')
})

test('shell tool: resolves workspace_id from configurable (thread_id fallback, __default__ last)', async () => {
  const backend = new InMemoryExecutionBackend((cmd) => ({ output: cmd, exitCode: 0 }))
  const mw = makeMiddleware(backend)
  const shellTool = ((mw as any).tools as any[]).find((t) => t.name === 'shell')
  await shellTool.invoke({ command: 'a' }, { configurable: { workspace_id: 'wA' } })
  await shellTool.invoke({ command: 'b' }, { configurable: { thread_id: 'wT' } })
  await shellTool.invoke({ command: 'c' }, {})
  expect(backend.execLog.map((l) => l.id).sort()).toEqual(['__default__', 'wA', 'wT'])
})

test('shell tool: error result surfaces when backend exec fails', async () => {
  const backend: import('./backend').ExecutionBackend = {
    async getOrCreateWorkspace(id) { return { id, phase: 'error' } },
    async exec() { throw new Error('sandbox not ready') },
    async destroyWorkspace() {}, async listWorkspaces() { return [] },
  }
  const mw = makeMiddleware(backend as any)
  const shellTool = ((mw as any).tools as any[]).find((t) => t.name === 'shell')
  const res = await shellTool.invoke({ command: 'x' }, { configurable: { workspace_id: 'w1' } })
  expect(String(res)).toContain('error')
})