// apps/deepagent/src/eval/stub-server.ts
import type { StubRoute } from './types'

export interface StubServer {
  url: string
  stop: () => Promise<void>
}

function queryMatches(route: StubRoute, params: URLSearchParams): boolean {
  if (!route.query) return true
  for (const [k, v] of Object.entries(route.query)) {
    if (params.get(k) !== v) return false
  }
  return true
}

export async function startStubServer(routes: StubRoute[]): Promise<StubServer> {
  const byKey = new Map<string, StubRoute[]>()
  for (const r of routes) {
    const key = `${r.method} ${r.path}`
    const list = byKey.get(key) ?? []
    list.push(r)
    byKey.set(key, list)
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const pathname = decodeURIComponent(url.pathname)
      const candidates = byKey.get(`${req.method} ${pathname}`) ?? []
      const route = candidates.find((r) => queryMatches(r, url.searchParams))
      if (!route) {
        return new Response(
          JSON.stringify({ error: `no stub for ${req.method} ${pathname}` }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify(route.body ?? null), {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  return {
    url: `http://localhost:${server.port}`,
    stop: async () => {
      server.stop()
    },
  }
}