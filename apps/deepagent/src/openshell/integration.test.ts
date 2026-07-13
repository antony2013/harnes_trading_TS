// apps/deepagent/src/openshell/integration.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { buildOpenShellMiddleware, _resetWorkspacePoolSingleton, _resetToolBridgeSingleton } from './index'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'

// Gated: only runs when OPENSHELL_AVAILABLE=1 AND Docker + the built image are present.
// The bridge binds lazily on the first shell call (process singleton) at bridgePort 7777
// (matches the image's baked OPENSHELL_BRIDGE_PORT). The middleware generates the token
// and bakes it into the sandbox env; the lazy bind reuses that same token, so wrappers
// inside the sandbox authenticate successfully — no test-side token plumbing needed.
const RUN = !!process.env.OPENSHELL_AVAILABLE
const itIf = RUN ? test : test.skip
const PORT = 7777

const getLtp = tool(async ({ instrument }) => ({ price: 123, instrument }), { name: 'get_ltp', schema: z.object({ instrument: z.string() }) })

beforeAll(() => { if (RUN) { _resetWorkspacePoolSingleton(); _resetToolBridgeSingleton() } })
afterAll(() => { if (RUN) { _resetToolBridgeSingleton(); _resetWorkspacePoolSingleton() } })
// NOTE: leftover sandboxes (int-w1/w2/w3) are not force-destroyed here; idle-reap or
// `openshell sandbox delete --name <id>` cleans them. Acceptable for a manually-gated run.

const mk = () => {
  const mw = buildOpenShellMiddleware({
    image: 'harnesh/agent-sandbox:ubuntu-lts', idleTimeoutMs: 60_000, bridgePort: PORT,
    executionTimeoutMs: 30_000, ptcAllowlist: ['get_ltp'], allTools: [getLtp],
  })
  return (mw as any).tools.find((t: any) => t.name === 'shell')
}

itIf('e2e: shell echo + exit code', async () => {
  const shell = mk()
  const res = await shell.invoke({ command: 'echo hello' }, { configurable: { workspace_id: 'int-w1' } })
  expect(res).toContain('hello')
  expect(res).toContain('exit: 0')
})

itIf('e2e: persistent state across calls', async () => {
  const shell = mk()
  await shell.invoke({ command: 'X=42' }, { configurable: { workspace_id: 'int-w2' } })
  const res = await shell.invoke({ command: 'echo $X' }, { configurable: { workspace_id: 'int-w2' } })
  expect(res).toContain('42')
})

itIf('e2e: wrapper round-trip via bridge (get_ltp)', async () => {
  const shell = mk()
  const res = await shell.invoke({ command: 'get_ltp --instrument NIFTY' }, { configurable: { workspace_id: 'int-w3' } })
  expect(res).toContain('123')
})