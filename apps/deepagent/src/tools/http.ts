// Shared HTTP helper for all deepagent tools: calls the running trading API
// (apps/api on port 3000 by default) and returns the response body as a string.
// Tools never throw — they return a JSON error string so the agent can reason.

const API_BASE_URL =
  (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')

export type ApiMethod = 'GET' | 'POST'

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * Call the trading API. Returns the response body as a string.
 * - 2xx  -> the raw body string (usually JSON).
 * - non-2xx -> JSON.stringify({ status, error }).
 * - fetch failure (API not running) -> JSON.stringify({ error: 'API not reachable ...' }).
 */
export async function apiCall(
  method: ApiMethod,
  path: string,
  query?: Record<string, string | number | undefined>,
  body?: unknown,
): Promise<string> {
  const url = new URL(API_BASE_URL + path)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
  }
  try {
    const res = await fetch(url.toString(), {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (res.ok) return text
    return JSON.stringify({ status: res.status, error: tryParse(text) ?? text })
  } catch (err: any) {
    return JSON.stringify({
      error: `API not reachable at ${API_BASE_URL} — is apps/api running? (${err?.message ?? String(err)})`,
    })
  }
}