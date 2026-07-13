// apps/deepagent/src/openshell/bridge.ts
import { randomUUID } from 'node:crypto'

export interface ToolBridgeOpts {
  port: number               // 0 = OS-assigned
  allowedTools: string[]     // ptcAllowlist
  allTools: any[]            // StructuredTool[]
  requestTimeoutMs?: number
  /** Pre-generated bearer token. If omitted, one is generated at bind time.
   *  Passed in by the openshell middleware so the sandbox env (baked at create
   *  time, before the server lazily binds) and the lazy bind use the SAME token. */
  token?: string
}

export interface ToolBridge {
  server: ReturnType<typeof Bun.serve>
  port: number
  token: string
  stop: () => void
}

export async function startToolBridge(opts: ToolBridgeOpts): Promise<ToolBridge> {
  const token = opts.token ?? randomUUID()
  const allowed = new Set(opts.allowedTools)
  const byName = new Map(opts.allTools.map((t) => [t.name, t] as const))
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000

  const server = Bun.serve({
    port: opts.port,
    hostname: '127.0.0.1',
    async fetch(req) {
      const auth = req.headers.get('authorization') ?? ''
      if (auth !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 })
      const url = new URL(req.url)
      const name = url.pathname.slice(1)
      const t = byName.get(name)
      if (!t || !allowed.has(name)) return new Response('forbidden', { status: 403 })
      let input: any
      try { input = await req.json() } catch { input = {} }
      try {
        const result = await Promise.race([
          t.invoke(input),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), requestTimeoutMs)),
        ])
        // Serialize via JSON round-trip so SDK class instances become plain objects.
        const safe = JSON.parse(JSON.stringify(result ?? null))
        return Response.json(safe)
      } catch (err: any) {
        return Response.json({ error: String(err?.message ?? err) }, { status: 500 })
      }
    },
  })
  return { server, port: server.port, token, stop: () => server.stop() }
}

let _singleton: ToolBridge | undefined
export function getToolBridge(opts: ToolBridgeOpts): Promise<ToolBridge> {
  if (!_singleton) return startToolBridge(opts).then((b) => { _singleton = b; return b })
  return Promise.resolve(_singleton)
}
export function _resetToolBridgeSingleton(): void { _singleton?.stop(); _singleton = undefined }