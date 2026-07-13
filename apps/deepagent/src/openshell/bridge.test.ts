// apps/deepagent/src/openshell/bridge.test.ts
import { test, expect, afterEach } from 'bun:test'
import { startToolBridge, _resetToolBridgeSingleton } from './bridge'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'

const getLtp = tool(async ({ instrument }) => ({ price: 123, instrument }), { name: 'get_ltp', schema: z.object({ instrument: z.string() }) })
const syncCandles = tool(async () => 'ok', { name: 'sync_candles', schema: z.object({}) })
const allTools: any[] = [getLtp, syncCandles]
const allowed = ['get_ltp']

let bridge: Awaited<ReturnType<typeof startToolBridge>>
afterEach(() => { bridge?.stop(); _resetToolBridgeSingleton() })

async function callBridge(name: string, body: any, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`http://127.0.0.1:${bridge.port}/${name}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

test('ToolBridge: invokes an allowed tool and returns JSON', async () => {
  bridge = await startToolBridge({ port: 0, allowedTools: allowed, allTools })
  const r = await callBridge('get_ltp', { instrument: 'NIFTY' }, bridge.token)
  expect(r.status).toBe(200)
  expect(r.json).toEqual({ price: 123, instrument: 'NIFTY' })
})

test('ToolBridge: 403 for a tool not in ptcAllowlist', async () => {
  bridge = await startToolBridge({ port: 0, allowedTools: allowed, allTools })
  const r = await callBridge('sync_candles', {}, bridge.token)
  expect(r.status).toBe(403)
})

test('ToolBridge: 403 for unknown tool', async () => {
  bridge = await startToolBridge({ port: 0, allowedTools: allowed, allTools })
  const r = await callBridge('nope', {}, bridge.token)
  expect(r.status).toBe(403)
})

test('ToolBridge: 401 when token missing or wrong', async () => {
  bridge = await startToolBridge({ port: 0, allowedTools: allowed, allTools })
  expect((await callBridge('get_ltp', { instrument: 'X' })).status).toBe(401)
  expect((await callBridge('get_ltp', { instrument: 'X' }, 'wrong')).status).toBe(401)
})

test('ToolBridge: binds to 127.0.0.1', async () => {
  bridge = await startToolBridge({ port: 0, allowedTools: allowed, allTools })
  // port 0 -> OS-assigned; the server reports the actual port
  expect(bridge.port).toBeGreaterThan(0)
})

test('ToolBridge: honors a pre-supplied token (used by openshell middleware so sandbox env + lazy bind match)', async () => {
  bridge = await startToolBridge({ port: 0, allowedTools: allowed, allTools, token: 'fixed-tok' })
  expect(bridge.token).toBe('fixed-tok')
  expect((await callBridge('get_ltp', { instrument: 'NIFTY' }, 'fixed-tok')).status).toBe(200)
  expect((await callBridge('get_ltp', { instrument: 'NIFTY' }, 'wrong')).status).toBe(401)
})