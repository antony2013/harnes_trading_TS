import { Elysia, t, sse } from 'elysia'
import {
  readSettings,
  writeSettings,
  toView,
  OLLAMA_DEFAULT,
  type AgentSettings,
  type Provider,
} from './settings'
import { buildAgent, buildModel, workspaceDir, type AgentConfig } from '@harnesh-trading-ts/deepagent'
import { mkdirSync } from 'node:fs'

const PROVIDER_LITERAL = t.Union([
  t.Literal('anthropic'),
  t.Literal('openai'),
  t.Literal('openrouter'),
  t.Literal('ollama'),
  t.Literal('custom'),
])

async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const url = baseUrl.replace(/\/$/, '') + '/api/tags'
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`Ollama /api/tags responded ${res.status}`)
  const json: any = await res.json()
  const models = Array.isArray(json?.models) ? json.models : []
  return models.map((m: any) => m?.name).filter((n: any): n is string => typeof n === 'string')
}

/** Resolve the apiKey: a blank/omitted body key keeps the existing saved key (security invariant). */
function resolveApiKey(body: { apiKey?: string }, existing: AgentSettings | null): string {
  return body.apiKey && body.apiKey.trim() ? body.apiKey : existing?.apiKey ?? ''
}

/** Build an AgentConfig from a request body, keeping the existing saved key when the body omits/blank it. */
function cfgFromBody(
  body: { provider: Provider; baseUrl?: string; model: string; apiKey?: string },
): AgentConfig {
  const existing = readSettings()
  const apiKey = resolveApiKey(body, existing)
  return {
    provider: body.provider,
    baseUrl: body.baseUrl ?? '',
    model: body.model,
    apiKey,
  }
}

async function testProvider(cfg: AgentConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    if (cfg.provider === 'ollama') {
      const base = cfg.baseUrl || OLLAMA_DEFAULT
      const models = await listOllamaModels(base)
      if (!models.includes(cfg.model)) {
        return { ok: false, detail: `Model "${cfg.model}" not found. Available: ${models.join(', ') || 'none'}` }
      }
      return { ok: true, detail: `Connected. ${models.length} model(s) available.` }
    }
    // hosted + custom: prove the key + endpoint work with a 1-chunk stream we abort immediately
    const model = buildModel(cfg)
    const stream = await (model as any).stream([{ role: 'user', content: 'ping' }])
    let timer: ReturnType<typeof setTimeout> | undefined
    const firstChunk = (async () => {
      for await (const _chunk of stream) break
      return { ok: true as const, detail: 'Connected.' }
    })()
    const timeout = new Promise<{ ok: boolean; detail: string }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, detail: 'Timed out (15s)' }), 15000)
    })
    try {
      const result = await Promise.race([firstChunk, timeout])
      if (!result.ok) {
        // Timed out: best-effort abort the stream so it doesn't linger.
        try { await (stream as any)?.return?.() } catch {}
      }
      return result
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch (err: any) {
    return { ok: false, detail: err?.message ?? String(err) }
  }
}

export const agent = new Elysia({ name: 'agent' })
  .get(
    '/agent/settings',
    () => {
      const s = readSettings()
      if (!s) {
        return { provider: 'ollama' as Provider, baseUrl: OLLAMA_DEFAULT, model: '', apiKey: '', hasKey: false }
      }
      return toView(s)
    },
    { detail: { summary: 'Get agent LLM settings (apiKey masked)', tags: ['Agent'] } },
  )
  .put(
    '/agent/settings',
    ({ body }) => {
      const existing = readSettings()
      const apiKey = resolveApiKey(body, existing)
      const next: AgentSettings = {
        provider: body.provider,
        baseUrl: body.baseUrl ?? '',
        model: body.model,
        apiKey,
      }
      writeSettings(next)
      return { ok: true }
    },
    {
      body: t.Object({
        provider: PROVIDER_LITERAL,
        baseUrl: t.Optional(t.String()),
        model: t.String({ minLength: 1 }),
        apiKey: t.Optional(t.String()),
      }),
      detail: { summary: 'Save agent LLM settings (blank apiKey keeps existing)', tags: ['Agent'] },
    },
  )
  .get(
    '/agent/ollama/models',
    async ({ query, status }) => {
      const baseUrl = query.baseUrl || readSettings()?.baseUrl || OLLAMA_DEFAULT
      try {
        return { models: await listOllamaModels(baseUrl) }
      } catch {
        return status(502, { message: `Ollama not reachable at ${baseUrl}` })
      }
    },
    {
      query: t.Object({ baseUrl: t.Optional(t.String()) }),
      detail: { summary: 'List installed Ollama models', tags: ['Agent'] },
    },
  )
  .post(
    '/agent/test',
    async ({ body }) => testProvider(cfgFromBody(body)),
    {
      body: t.Object({
        provider: PROVIDER_LITERAL,
        baseUrl: t.Optional(t.String()),
        model: t.String({ minLength: 1 }),
        apiKey: t.Optional(t.String()),
      }),
      detail: { summary: 'Test LLM provider connection (does NOT save)', tags: ['Agent'] },
    },
  )
  .post(
    '/agent/chat',
    async function* ({ body, set, request }) {
      set.headers['Connection'] = 'keep-alive'

      const s = readSettings()
      if (!s || !s.model) {
        set.status = 400
        yield sse({ event: 'error', data: { message: 'Agent not configured. Open /settings first.' } })
        return
      }

      const workspaceId = (body.workspaceId as string) || '__default__'
      mkdirSync(workspaceDir(workspaceId), { recursive: true })

      let agent
      try {
        agent = await buildAgent(s)
      } catch (err: any) {
        yield sse({ event: 'error', data: { message: err?.message ?? 'Failed to build agent' } })
        return
      }

      try {
        // LangChain v2 streamEvents: a single interleaved event stream.
        // deepagents' typed override targets v3; cast to any to use the stable v2 events.
        // configurable.workspace_id keys the openshell sandbox workspace (Task 7 middleware).
        const stream = (agent as any).streamEvents(
          { messages: body.messages },
          { version: 'v2', signal: request.signal, configurable: { workspace_id: workspaceId } },
        )
        for await (const ev of stream) {
          if (ev.event === 'on_chat_model_stream') {
            const chunk = ev.data?.chunk
            const text = typeof chunk?.content === 'string' ? chunk.content : ''
            if (text) yield sse({ event: 'token', data: { text } })
          } else if (ev.event === 'on_tool_start') {
            yield sse({ event: 'tool_call', data: { name: ev.name, input: ev.data?.input ?? null } })
          } else if (ev.event === 'on_tool_end') {
            const out = ev.data?.output
            const outStr =
              typeof out === 'string' ? out :
              typeof out?.content === 'string' ? out.content :
              JSON.stringify(out)
            yield sse({ event: 'tool_result', data: { name: ev.name, output: outStr } })
          }
        }
        yield sse({ event: 'done', data: {} })
      } catch (err: any) {
        if (err?.name === 'AbortError') return
        yield sse({ event: 'error', data: { message: err?.message ?? 'Agent stream failed' } })
      }
    },
    {
      body: t.Object({
        workspaceId: t.Optional(t.String()),
        messages: t.Array(
          t.Object({
            role: t.Union([t.Literal('user'), t.Literal('assistant'), t.Literal('system')]),
            content: t.String(),
          }),
          { minItems: 1 },
        ),
      }),
      detail: {
        summary: 'Agent chat (SSE stream: token/tool_call/tool_result/done/error)',
        tags: ['Agent'],
        hide: true, // stream — not executable via Swagger "Try it out"
      },
    },
  )