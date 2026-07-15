// apps/deepagent/src/search/middleware.ts
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { AgentMiddleware } from '@langchain/core/multi_agent'
import type { SearchSpec } from '../profiles/types'

const SEARXNG_TIMEOUT_MS = 15_000
const CRAWL_MAX_CHARS = 20_000

function tryParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

/** Strip a trailing slash from a base URL. */
function base(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Search SearXNG and return top N results as a JSON string of
 *  [{ title, url, snippet, engines }]. Never throws. */
export async function runWebSearch(spec: SearchSpec, query: string): Promise<string> {
  const url = new URL(base(spec.searxngBaseUrl) + '/search')
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('safesearch', '1')
  url.searchParams.set('pageno', '1')
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(SEARXNG_TIMEOUT_MS) })
    const text = await res.text()
    if (!res.ok) return JSON.stringify({ status: res.status, error: tryParse(text) ?? text })
    const body = tryParse(text) as { results?: any[] } | null
    const results = Array.isArray(body?.results) ? body!.results : []
    const top = results.slice(0, spec.maxResults).map((r: any) => ({
      title: String(r?.title ?? ''),
      url: String(r?.url ?? ''),
      snippet: String(r?.content ?? ''),
      engines: Array.isArray(r?.engines) ? r.engines : [],
    }))
    return JSON.stringify(top)
  } catch (err: any) {
    return JSON.stringify({
      error: `SearXNG not reachable at ${spec.searxngBaseUrl} — is it running? (${err?.message ?? String(err)})`,
    })
  }
}

/** Extract markdown from a Crawl4AI /crawl response (shape varies by version:
 *  array of {markdown}, or {result:{markdown}}, or {data:{markdown|content}}). */
function extractMarkdown(body: any): string {
  if (Array.isArray(body)) body = body[0]
  if (body?.success === false) {
    const msg = body?.error_message || body?.error || 'crawl failed'
    throw new Error(String(msg))
  }
  if (typeof body?.result?.markdown === 'string') return body.result.markdown
  if (typeof body?.data?.markdown === 'string') return body.data.markdown
  if (typeof body?.data?.content === 'string') return body.data.content
  if (typeof body?.markdown === 'string') return body.markdown
  return JSON.stringify(body)
}

/** Crawl a single URL via Crawl4AI and return its cleaned markdown (truncated
 *  to CRAWL_MAX_CHARS). Never throws. */
export async function runCrawlPage(spec: SearchSpec, url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    return JSON.stringify({ error: 'url must be an http(s):// URL' })
  }
  try {
    const res = await fetch(base(spec.crawl4aiBaseUrl) + '/crawl', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url,
        browser_config: { headless: true },
        crawler_config: { cache_mode: 'BYPASS' },
      }),
      signal: AbortSignal.timeout(spec.crawlTimeoutMs),
    })
    const text = await res.text()
    if (!res.ok) return JSON.stringify({ status: res.status, error: tryParse(text) ?? text })
    let md: string
    try {
      md = extractMarkdown(tryParse(text))
    } catch (extractErr: any) {
      return JSON.stringify({ error: `Crawl4AI returned an error for ${url}: ${extractErr?.message ?? extractErr}` })
    }
    if (md.length > CRAWL_MAX_CHARS) md = md.slice(0, CRAWL_MAX_CHARS) + '\n\n…[truncated]'
    return md
  } catch (err: any) {
    return JSON.stringify({
      error: `Crawl4AI not reachable at ${spec.crawl4aiBaseUrl} — is it running? (${err?.message ?? String(err)})`,
    })
  }
}

/** Build the 'search' middleware: web_search + crawl_page tools with `spec`
 *  baked in. Mirrors buildOpenShellMiddleware's shape ({ name, tools }). */
export function buildSearchMiddleware(spec: SearchSpec): AgentMiddleware {
  const webSearch = tool(
    async ({ query }) => runWebSearch(spec, query),
    {
      name: 'web_search',
      description:
        'Search the public web via SearXNG. Returns the top results as JSON: [{ title, url, snippet, engines }]. Use this to find sources, then crawl_page on the most relevant URL(s) to read their full content.',
      schema: z.object({
        query: z.string().min(1).describe('The search query, e.g. "TCS Q4 results 2026"'),
      }),
    },
  )
  const crawlPage = tool(
    async ({ url }) => runCrawlPage(spec, url),
    {
      name: 'crawl_page',
      description:
        'Fetch a single web page URL via Crawl4AI and return its cleaned markdown content (truncated). Use this to read the full content of a URL found via web_search. The URL must be http(s)://.',
      schema: z.object({
        url: z.string().min(1).describe('The full http(s):// URL to crawl'),
      }),
    },
  )
  const mw: AgentMiddleware = {
    name: 'SearchMiddleware', // unique — must not collide with other middleware
    tools: [webSearch, crawlPage],
  }
  return mw
}