import { Elysia, t } from 'elysia'
import {
  readSettings,
  writeSettings,
  toView,
  OLLAMA_DEFAULT,
  type AgentSettings,
  type Provider,
} from './settings'
import { buildModel, type AgentConfig } from '@harnesh-trading-ts/deepagent'

const PROVIDER_LITERAL = t.Union([
  t.Literal('anthropic'),
  t.Literal('openai'),
  t.Literal('ollama'),
  t.Literal('custom'),
])

async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const url = baseUrl.replace(/\/$/, '') + '/api/tags'
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Ollama /api/tags responded ${res.status}`)
  const json: any = await res.json()
  const models = Array.isArray(json?.models) ? json.models : []
  return models.map((m: any) => m?.name).filter((n: any): n is string => typeof n === 'string')
}

/** Build an AgentConfig from a request body, keeping the existing saved key when the body omits/blank it. */
function cfgFromBody(
  body: { provider: Provider; baseUrl?: string; model: string; apiKey?: string },
): AgentConfig {
  const existing = readSettings()
  const apiKey = body.apiKey && body.apiKey.trim() ? body.apiKey : existing?.apiKey ?? ''
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
    for await (const _chunk of stream) break
    return { ok: true, detail: 'Connected.' }
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
      const apiKey = body.apiKey && body.apiKey.trim() ? body.apiKey : existing?.apiKey ?? ''
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