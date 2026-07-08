# Agent Chat UI + LLM Provider Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the deepagent a modern web chat UI (apps/web) with a complete model settings page (Anthropic / OpenAI / Ollama / OpenAI-compatible), served via apps/api.

**Architecture:** The agent engine stays in `apps/deepagent` (`buildAgent`); `apps/api` imports it and exposes REST settings endpoints + an SSE chat endpoint; `apps/web` (SvelteKit 5) renders `/chat` and `/settings`. Settings persist in `apps/api/data/agent-settings.json` (gitignored). Chat streams via LangChain `streamEvents` v2 mapped to SSE events.

**Tech Stack:** Bun + Elysia (api), SvelteKit 5 + Vite (web, runes mode), deepagents + @langchain/{anthropic,openai,ollama} (agent), Bun test (api unit tests).

## Global Constraints

- Monorepo = bun workspaces (`apps/*`), packageManager `bun@1.3.14`. Cross-app deps added as `workspace:*` via `bun add` (never hand-edit package.json deps).
- `apps/api/data/` is gitignored — `agent-settings.json` lives there and is NOT committed.
- API keys never leave the server: `GET /agent/settings` returns masked keys; `PUT` keeps the existing key when the field is blank.
- Web runes mode is forced (Svelte 5 `$state`/`$props`/`$derived` + stores). Match existing `marketFeed.ts` / `Header.svelte` style (dark theme `#0b1020` bg, tabular-nums).
- Dev proxy in `apps/web/vite.config.ts` keeps browser same-origin (no CORS) — extend it for `/agent`.
- Settings path is resolved lazily from `process.env.AGENT_SETTINGS_PATH` (so tests can redirect it), else `<app>/data/agent-settings.json` derived from the module location (NOT `process.cwd()`).
- TDD where a test runner exists (api: `bun test`). UI (web) is verified manually per the spec — no web test runner is set up.
- Commit after each task. Commit messages end with `Co-Authored-By: Claude <noreply@anthropic.com>`.

---

## File Structure

**apps/deepagent** (agent engine — config-driven now):
- Modify `apps/deepagent/package.json` — add `@langchain/ollama` dep + `exports` map.
- Modify `apps/deepagent/src/agent.ts` — `buildAgent(cfg)`, `buildModel(cfg)`, `resolveAgentConfig()`, types.
- Modify `apps/deepagent/src/index.ts` — CLI uses `resolveAgentConfig()`.
- Create `apps/deepagent/src/agent.test.ts` — unit tests for model map + config resolution.

**apps/api** (HTTP wrapper):
- Create `apps/api/src/modules/agent/settings.ts` — read/write/mask helpers + types.
- Create `apps/api/src/modules/agent/settings.test.ts` — round-trip + masking tests.
- Create `apps/api/src/modules/agent/index.ts` — Elysia plugin: GET/PUT `/agent/settings`, GET `/agent/ollama/models`, POST `/agent/test`, POST `/agent/chat` (SSE).
- Modify `apps/api/src/index.ts` — register `.use(agent)`, exclude `/agent/chat` from Swagger.
- Modify `apps/api/package.json` — add `@harnesh-trading-ts/deepagent` workspace dep.

**apps/web** (UI):
- Modify `apps/web/vite.config.ts` — add `/agent` dev proxy.
- Modify `apps/web/src/lib/components/Header.svelte` — add Chat | Settings nav.
- Create `apps/web/src/lib/stores/agentSettings.ts` — settings store + API calls.
- Create `apps/web/src/lib/stores/agentChat.ts` — chat store + SSE parser.
- Create `apps/web/src/lib/components/agent/ProviderForm.svelte` — settings form.
- Create `apps/web/src/lib/components/agent/ModelSelect.svelte` — model dropdown.
- Create `apps/web/src/lib/components/agent/ChatView.svelte` — message list.
- Create `apps/web/src/lib/components/agent/MessageInput.svelte` — input box.
- Create `apps/web/src/lib/components/agent/AgentMessage.svelte` — one message.
- Create `apps/web/src/lib/components/agent/ToolStep.svelte` — collapsible tool step.
- Create `apps/web/src/routes/settings/+page.svelte` — settings page.
- Create `apps/web/src/routes/chat/+page.svelte` — chat page.

---

### Task 1: Make deepagent config-driven (buildAgent takes a config object)

**Files:**
- Modify: `apps/deepagent/package.json`
- Modify: `apps/deepagent/src/agent.ts`
- Modify: `apps/deepagent/src/index.ts`
- Create: `apps/deepagent/src/agent.test.ts`

**Interfaces:**
- Produces: `buildAgent(cfg: AgentConfig): Promise<DeepAgent>`, `buildModel(cfg: AgentConfig): BaseLanguageModel`, `resolveAgentConfig(): AgentConfig | null`, type `Provider = 'anthropic'|'openai'|'ollama'|'custom'`, type `AgentConfig = { provider, apiKey, baseUrl, model }`. These are consumed by Task 2 (api) and the CLI.

- [ ] **Step 1: Add `@langchain/ollama` dep + `exports` map**

Run (from repo root):
```bash
cd apps/deepagent && bun add @langchain/ollama
```
Then edit `apps/deepagent/package.json` to add an `exports` field (after `"private": true`). The `.` export points at the agent builder (NOT the CLI, which would start the REPL on import):

```json
{
  "name": "@harnesh-trading-ts/deepagent",
  "private": true,
  "exports": {
    ".": "./src/agent.ts",
    "./tools": "./src/tools/index.ts"
  },
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "build": "bun build src/index.ts --outdir dist --target bun",
    "start": "bun run src/index.ts"
  },
  "dependencies": {
    "@langchain/anthropic": "^1.5.1",
    "@langchain/core": "^1.2.1",
    "@langchain/ollama": "...",
    "@langchain/openai": "^1.5.3",
    "deepagents": "^1.10.5",
    "langchain": "^1.5.2",
    "zod": "^4.4.3"
  }
}
```
(Keep the versions `bun add` wrote for `@langchain/ollama`; don't hand-write the version string — the command above populates it. The block above only shows the shape.)

- [ ] **Step 2: Write the failing test**

Create `apps/deepagent/src/agent.test.ts`:
```ts
import { test, expect, beforeEach } from 'bun:test'
import { buildModel, resolveAgentConfig } from './agent'

beforeEach(() => {
  process.env.AGENT_SETTINGS_PATH = `/tmp/agent-settings-${Math.random().toString(36).slice(2)}.json`
  delete process.env.DEEPAGENT_MODEL
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
})

test('buildModel: ollama -> ChatOllama', () => {
  const m = buildModel({ provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama3' })
  expect(m.constructor.name).toBe('ChatOllama')
})

test('buildModel: custom -> ChatOpenAI', () => {
  const m = buildModel({ provider: 'custom', apiKey: 'k', baseUrl: 'http://x/v1', model: 'gpt' })
  expect(m.constructor.name).toBe('ChatOpenAI')
})

test('buildModel: anthropic -> ChatAnthropic', () => {
  const m = buildModel({ provider: 'anthropic', apiKey: 'k', baseUrl: '', model: 'claude' })
  expect(m.constructor.name).toBe('ChatAnthropic')
})

test('resolveAgentConfig: env fallback parses provider:model', () => {
  process.env.DEEPAGENT_MODEL = 'openai:gpt-4o-mini'
  process.env.OPENAI_API_KEY = 'sk-test'
  const cfg = resolveAgentConfig()
  expect(cfg).toEqual({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test', baseUrl: '' })
})

test('resolveAgentConfig: null when no settings + no env', () => {
  expect(resolveAgentConfig()).toBeNull()
})
```

- [ ] **Step 3: Run test to verify it fails**

Run (from `apps/deepagent`):
```bash
bun test src/agent.test.ts
```
Expected: FAIL — `buildModel` / `resolveAgentConfig` not exported (current `agent.ts` only exports `buildAgent` reading env).

- [ ] **Step 4: Rewrite `apps/deepagent/src/agent.ts`**

```ts
import { createDeepAgent } from 'deepagents'
import type { BaseLanguageModel } from '@langchain/core/language_models/base'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import { ChatOllama } from '@langchain/ollama'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { allTools } from './tools'

export const SYSTEM_PROMPT = `You are a trading assistant for the Indian stock market, backed by the local Upstox trading API.
Use the provided tools to answer the user's question.
- Instrument keys look like "NSE_EQ|INE002A01018" or "NSE_INDEX|Nifty 50". Use search_instruments if you don't know the key.
- Timeframes are canonical labels: v2 raw (1minute, 30minute, day, week, month) or v3 {interval}{unit} (e.g. 5minutes, 1days).
- Dates are YYYY-MM-DD.
- To store candles for a backtest, use sync_candles; to read stored candles, use read_candles.
- If a tool returns an error object, read it and retry with corrected parameters.
- If the API is unreachable, tell the user to start apps/api (bun run dev in apps/api).
Be concise. Prefer tools over guessing.`

export type Provider = 'anthropic' | 'openai' | 'ollama' | 'custom'

export interface AgentConfig {
  provider: Provider
  apiKey: string
  baseUrl: string
  model: string
}

const OLLAMA_DEFAULT = 'http://localhost:11434'

export function buildModel(cfg: AgentConfig): BaseLanguageModel {
  switch (cfg.provider) {
    case 'anthropic':
      return new ChatAnthropic({ model: cfg.model, apiKey: cfg.apiKey })
    case 'openai':
      return new ChatOpenAI({ model: cfg.model, apiKey: cfg.apiKey })
    case 'ollama':
      return new ChatOllama({ model: cfg.model, baseUrl: cfg.baseUrl || OLLAMA_DEFAULT })
    case 'custom':
      return new ChatOpenAI({ model: cfg.model, apiKey: cfg.apiKey, configuration: { baseURL: cfg.baseUrl } })
  }
}

export async function buildAgent(cfg: AgentConfig) {
  if (!cfg.model) {
    throw new Error('Agent config missing model')
  }
  const model = buildModel(cfg)
  return createDeepAgent({ model, tools: allTools, systemPrompt: SYSTEM_PROMPT })
}

function defaultSettingsPath(): string {
  // apps/deepagent/src/agent.ts -> ../../api/data/agent-settings.json
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../api/data/agent-settings.json')
}

function settingsPath(): string {
  return process.env.AGENT_SETTINGS_PATH || defaultSettingsPath()
}

export function resolveAgentConfig(): AgentConfig | null {
  // 1. settings file
  const path = settingsPath()
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      if (raw && raw.provider && raw.model) {
        return {
          provider: raw.provider as Provider,
          apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
          baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
          model: raw.model,
        }
      }
    } catch {
      /* fall through to env */
    }
  }
  // 2. env fallback (legacy CLI): DEEPAGENT_MODEL = "provider:model"
  const envModel = process.env.DEEPAGENT_MODEL
  if (envModel && envModel.includes(':')) {
    const idx = envModel.indexOf(':')
    const provider = envModel.slice(0, idx) as Provider
    const model = envModel.slice(idx + 1)
    const apiKey =
      provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY || '' :
      provider === 'openai' ? process.env.OPENAI_API_KEY || '' : ''
    return { provider, model, apiKey, baseUrl: provider === 'ollama' ? OLLAMA_DEFAULT : '' }
  }
  return null
}
```

- [ ] **Step 5: Update the CLI `apps/deepagent/src/index.ts`**

```ts
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { buildAgent, resolveAgentConfig } from './agent'

async function main() {
  const cfg = resolveAgentConfig()
  if (!cfg) {
    console.error(
      'No agent config. Either save settings via apps/web /settings (writes apps/api/data/agent-settings.json), or set DEEPAGENT_MODEL + the matching API key env var.',
    )
    process.exit(1)
  }
  const agent = await buildAgent(cfg)
  console.log(`deepagent ready (${cfg.provider}:${cfg.model}). Type a question (empty line or "exit" to quit).`)
  const rl = readline.createInterface({ input, output })
  while (true) {
    const line = (await rl.question('\n> ')).trim()
    if (!line || line.toLowerCase() === 'exit') break
    try {
      const result = await agent.invoke({
        messages: [{ role: 'user', content: line }],
      })
      const msgs = (result?.messages ?? []) as Array<{ content?: unknown }>
      const last = msgs[msgs.length - 1]
      const text =
        typeof last?.content === 'string'
          ? last.content
          : last?.content
            ? JSON.stringify(last.content)
            : '(no output)'
      console.log(text)
    } catch (err: any) {
      console.error('Agent error:', err?.message ?? String(err))
    }
  }
  rl.close()
}

main()
```

- [ ] **Step 6: Run test to verify it passes**

Run (from `apps/deepagent`):
```bash
bun test src/agent.test.ts
```
Expected: PASS (5/5).

- [ ] **Step 7: Commit**

```bash
git add apps/deepagent/package.json apps/deepagent/bun.lock apps/deepagent/src/agent.ts apps/deepagent/src/index.ts apps/deepagent/src/agent.test.ts
git commit -m "$(cat <<'EOF'
refactor(deepagent): config-driven buildAgent + Ollama provider

buildAgent now takes an explicit AgentConfig {provider,apiKey,baseUrl,model}
and instantiates the right LangChain chat model (anthropic/openai/ollama/
custom). resolveAgentConfig() reads apps/api/data/agent-settings.json, falling
back to DEEPAGENT_MODEL env so the CLI still works. Adds @langchain/ollama
and a package exports map (./src/agent.ts) so apps/api can import the engine.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: api settings store + REST endpoints (settings, ollama models, test)

**Files:**
- Create: `apps/api/src/modules/agent/settings.ts`
- Create: `apps/api/src/modules/agent/settings.test.ts`
- Create: `apps/api/src/modules/agent/index.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/package.json` (via `bun add`)

**Interfaces:**
- Consumes: `buildAgent`, `buildModel`, `AgentConfig`, `Provider` from Task 1 (`@harnesh-trading-ts/deepagent`).
- Produces: Elysia plugin `agent` exporting routes `GET/PUT /agent/settings`, `GET /agent/ollama/models`, `POST /agent/test`, `POST /agent/chat` (chat wired in Task 3). `readSettings()/writeSettings()/toView()/maskKey()` helpers.

- [ ] **Step 1: Add deepagent workspace dep to api**

Run (from `apps/api`):
```bash
cd apps/api && bun add @harnesh-trading-ts/deepagent@workspace:* --no-save
```
If `--no-save` is not supported by your bun version, use:
```bash
cd apps/api && bun add @harnesh-trading-ts/deepagent@workspace:*
```
Verify `apps/api/package.json` now lists `"@harnesh-trading-ts/deepagent": "workspace:*"` under `dependencies`.

- [ ] **Step 2: Write the failing test for settings helpers**

Create `apps/api/src/modules/agent/settings.test.ts`:
```ts
import { test, expect, beforeEach } from 'bun:test'
import { readSettings, writeSettings, toView, maskKey } from './settings'

beforeEach(() => {
  process.env.AGENT_SETTINGS_PATH = `/tmp/agent-settings-${Math.random().toString(36).slice(2)}.json`
})

test('maskKey: long key -> prefix...suffix', () => {
  expect(maskKey('sk-abcdefghijklmnop')).toBe('sk-...mnop')
})

test('maskKey: empty -> empty', () => {
  expect(maskKey('')).toBe('')
})

test('maskKey: short key -> ****', () => {
  expect(maskKey('ab')).toBe('****')
})

test('readSettings: null when no file', () => {
  expect(readSettings()).toBeNull()
})

test('write then read round-trips', () => {
  writeSettings({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '' })
  expect(readSettings()).toEqual({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '' })
})

test('toView masks key + sets hasKey', () => {
  const v = toView({ provider: 'anthropic', baseUrl: '', model: 'claude', apiKey: 'sk-abcdefghijklmnop' })
  expect(v.apiKey).toBe('sk-...mnop')
  expect(v.hasKey).toBe(true)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run (from `apps/api`):
```bash
bun test src/modules/agent/settings.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 4: Create `apps/api/src/modules/agent/settings.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export type Provider = 'anthropic' | 'openai' | 'ollama' | 'custom'

export interface AgentSettings {
  provider: Provider
  baseUrl: string
  model: string
  apiKey: string
}

export interface AgentSettingsView {
  provider: Provider
  baseUrl: string
  model: string
  apiKey: string // masked, e.g. "sk-...mnop" or ""
  hasKey: boolean
}

const OLLAMA_DEFAULT = 'http://localhost:11434'

function defaultSettingsPath(): string {
  // apps/api/src/modules/agent/settings.ts -> ../../../data/agent-settings.json
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../../data/agent-settings.json')
}

function settingsPath(): string {
  return process.env.AGENT_SETTINGS_PATH || defaultSettingsPath()
}

export function readSettings(): AgentSettings | null {
  const path = settingsPath()
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!raw || !raw.provider || !raw.model) return null
    return {
      provider: raw.provider as Provider,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
      model: raw.model,
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    }
  } catch {
    return null
  }
}

export function writeSettings(s: AgentSettings): void {
  const path = settingsPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n')
  renameSync(tmp, path) // atomic
}

export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return key.slice(0, 3) + '...' + key.slice(-4)
}

export function toView(s: AgentSettings): AgentSettingsView {
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    apiKey: maskKey(s.apiKey),
    hasKey: !!s.apiKey,
  }
}

export { OLLAMA_DEFAULT }
```

- [ ] **Step 5: Run test to verify it passes**

Run (from `apps/api`):
```bash
bun test src/modules/agent/settings.test.ts
```
Expected: PASS (6/6).

- [ ] **Step 6: Create the agent Elysia plugin `apps/api/src/modules/agent/index.ts`**

(chat endpoint stubbed here; full streaming wired in Task 3.)

```ts
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
```

- [ ] **Step 7: Register the plugin in `apps/api/src/index.ts`**

Add the import and `.use(agent)`. Edit the import block (after the `stream` import line):
```ts
import { stream } from './modules/stream'
import { agent } from './modules/agent'
```
And in the chain, add `.use(agent)` after `.use(backtestData)`:
```ts
  .use(backtestData)
  .use(agent)
  .get('/', () => 'Hello from Harnesh Trading API')
```

- [ ] **Step 8: Manual smoke test of the REST endpoints**

Start the api (from `apps/api`): `bun run dev` (background or separate terminal).
Then:
```bash
# default view (no settings yet)
curl -s http://localhost:3000/agent/settings
# save ollama config
curl -s -X PUT http://localhost:3000/agent/settings -H 'content-type: application/json' -d '{"provider":"ollama","baseUrl":"http://localhost:11434","model":"llama3"}'
# read back (apiKey masked)
curl -s http://localhost:3000/agent/settings
# list ollama models (works only if ollama running; otherwise 502 — both are correct behavior)
curl -s 'http://localhost:3000/agent/ollama/models?baseUrl=http://localhost:11434'
```
Expected: PUT returns `{"ok":true}`; GET after PUT returns the saved config with `apiKey:""` and `hasKey:false`; `apps/api/data/agent-settings.json` exists on disk with the saved JSON.

- [ ] **Step 9: Commit**

```bash
git add apps/api/package.json apps/api/bun.lock apps/api/src/modules/agent/settings.ts apps/api/src/modules/agent/settings.test.ts apps/api/src/modules/agent/index.ts apps/api/src/index.ts
git commit -m "$(cat <<'EOF'
feat(api): agent settings store + REST endpoints

apps/api/src/modules/agent: settings.ts (atomic read/write of
data/agent-settings.json, masked views), Elysia plugin with GET/PUT
/agent/settings, GET /agent/ollama/models (proxies Ollama /api/tags),
POST /agent/test (1-chunk stream / model-list check, no save). Wires
@harnesh-trading-ts/deepagent workspace dep. Chat SSE endpoint next.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: api chat SSE endpoint (streamEvents v2 → token/tool_call/tool_result/done/error)

**Files:**
- Modify: `apps/api/src/modules/agent/index.ts` — append `.post('/agent/chat', ...)` to the plugin.
- Modify: `apps/api/src/index.ts` — exclude `/agent/chat` from Swagger (it's a stream).

**Interfaces:**
- Consumes: `buildAgent` from Task 1, `readSettings` from Task 2.
- Produces: `POST /agent/chat` SSE stream with events `token` | `tool_call` | `tool_result` | `done` | `error`. Consumed by Task 5 (web chat store).

- [ ] **Step 1: Append the chat endpoint to `apps/api/src/modules/agent/index.ts`**

Add `sse` to the elysia import at the top:
```ts
import { Elysia, t, sse } from 'elysia'
```
Add `buildAgent` to the deepagent import:
```ts
import { buildAgent, buildModel, type AgentConfig } from '@harnesh-trading-ts/deepagent'
```
Then append to the plugin chain (after the `/agent/test` `.post(...)` block, before the closing `)`):
```ts
  .post(
    '/agent/chat',
    async function* ({ body, set, request }) {
      set.headers['Cache-Control'] = 'no-cache'
      set.headers['Connection'] = 'keep-alive'

      const s = readSettings()
      if (!s || !s.model) {
        set.status = 400
        yield sse({ event: 'error', data: { message: 'Agent not configured. Open /settings first.' } })
        return
      }

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
        const stream = (agent as any).streamEvents(
          { messages: body.messages },
          { version: 'v2', signal: request.signal },
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
```

- [ ] **Step 2: Exclude `/agent/chat` from Swagger in `apps/api/src/index.ts`**

Update the openapi `exclude.paths` array:
```ts
    exclude: { paths: ['/stream/market-data', '/agent/chat'] },
```

- [ ] **Step 3: Manual smoke test of the chat stream**

Start ollama + a model first (e.g. `ollama pull llama3` and `ollama serve`), and ensure settings saved in Task 2 point at it. With api running:
```bash
curl -N -X POST http://localhost:3000/agent/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hello in one short sentence."}]}'
```
Expected: a stream of `event: token` lines building up a sentence, then `event: done`. If you ask a trading question that triggers a tool (e.g. "What is the NIFTY LTP?"), you should see `event: tool_call` then `event: tool_result` then `token`s.

If `streamEvents` with `version: 'v2'` throws (deepagents only accepts v3 on its typed override), fall back to v3 projections: replace the `for await (const ev of stream)` block with concurrent consumption of `run.messages` (each `msg.text` async-iterable of tokens) and `run.toolCalls` (each `{ name, input, output }`), merging into the same SSE events. Verify which works at impl time and keep the working version.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/agent/index.ts apps/api/src/index.ts
git commit -m "$(cat <<'EOF'
feat(api): agent chat SSE endpoint

POST /agent/chat streams LangChain v2 streamEvents as SSE: token
(on_chat_model_stream text), tool_call (on_tool_start), tool_result
(on_tool_end), done, error. Aborts the run on client disconnect via
request.signal. 400 + error event when the agent is not configured.
Hidden from Swagger (streaming).

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: web settings store + `/settings` page

**Files:**
- Modify: `apps/web/vite.config.ts` — add `/agent` proxy.
- Create: `apps/web/src/lib/stores/agentSettings.ts`
- Create: `apps/web/src/lib/components/agent/ModelSelect.svelte`
- Create: `apps/web/src/lib/components/agent/ProviderForm.svelte`
- Create: `apps/web/src/routes/settings/+page.svelte`

**Interfaces:**
- Consumes: `GET/PUT /agent/settings`, `GET /agent/ollama/models`, `POST /agent/test` (Task 2).
- Produces: `agentSettings` store + `loadSettings/fetchOllamaModels/saveSettings/testConnection` actions; `/settings` route. Used by Header (Task 6) to show active model and by chat (Task 5).

- [ ] **Step 1: Add `/agent` dev proxy in `apps/web/vite.config.ts`**

Add a key to `server.proxy`:
```ts
		server: {
			proxy: {
				'/stream': { target: 'http://localhost:3000', changeOrigin: true },
				'/market-quote': { target: 'http://localhost:3000', changeOrigin: true },
				'/agent': { target: 'http://localhost:3000', changeOrigin: true }
			}
		}
```

- [ ] **Step 2: Create `apps/web/src/lib/stores/agentSettings.ts`**

```ts
import { writable } from 'svelte/store'

export type Provider = 'anthropic' | 'openai' | 'ollama' | 'custom'

export interface AgentSettingsView {
	provider: Provider
	baseUrl: string
	model: string
	apiKey: string // masked from server
	hasKey: boolean
}

export const PROVIDER_LABELS: Record<Provider, string> = {
	anthropic: 'Anthropic',
	openai: 'OpenAI',
	ollama: 'Ollama (local)',
	custom: 'OpenAI-compatible (custom)'
}

export const CURATED_MODELS: Partial<Record<Provider, string[]>> = {
	anthropic: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-1'],
	openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini']
}

export const DEFAULT_BASE_URL: Record<Provider, string> = {
	anthropic: '',
	openai: '',
	ollama: 'http://localhost:11434',
	custom: ''
}

export const agentSettings = writable<AgentSettingsView | null>(null)
export const ollamaModels = writable<string[]>([])
export const saving = writable(false)
export const testing = writable(false)
export const testResult = writable<{ ok: boolean; detail: string } | null>(null)
export const settingsError = writable<string | null>(null)

export async function loadSettings(): Promise<void> {
	const res = await fetch('/agent/settings')
	agentSettings.set(await res.json())
}

export async function fetchOllamaModels(baseUrl: string): Promise<void> {
	const res = await fetch(`/agent/ollama/models?baseUrl=${encodeURIComponent(baseUrl)}`)
	if (res.ok) {
		const j = await res.json()
		ollamaModels.set(j.models ?? [])
	} else {
		ollamaModels.set([])
	}
}

export async function saveSettings(payload: {
	provider: Provider
	baseUrl: string
	model: string
	apiKey: string
}): Promise<boolean> {
	saving.set(true)
	settingsError.set(null)
	try {
		const res = await fetch('/agent/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		})
		if (!res.ok) {
			settingsError.set(`Save failed (${res.status})`)
			return false
		}
		await loadSettings()
		return true
	} finally {
		saving.set(false)
	}
}

export async function testConnection(payload: {
	provider: Provider
	baseUrl: string
	model: string
	apiKey: string
}): Promise<void> {
	testing.set(true)
	testResult.set(null)
	try {
		const res = await fetch('/agent/test', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		})
		testResult.set(await res.json())
	} finally {
		testing.set(false)
	}
}
```

- [ ] **Step 3: Create `apps/web/src/lib/components/agent/ModelSelect.svelte`**

A model dropdown. For Ollama it lists `ollamaModels`; for Anthropic/OpenAI it lists curated models + free text; for Custom it's free text.

```svelte
<script lang="ts">
	import { CURATED_MODELS, ollamaModels, type Provider } from '$lib/stores/agentSettings';

	let {
		provider,
		value = $bindable(),
		placeholder = 'Select or type a model'
	}: { provider: Provider; value: string; placeholder?: string } = $props();

	let custom = $state(false);
	const curated = $derived(CURATED_MODELS[provider] ?? []);
	const options = $derived(provider === 'ollama' ? ollamaModels : curated);

	$effect(() => {
		// reset to dropdown mode whenever provider or options change
		custom = false;
	});
</script>

{#if custom || (options.length === 0 && provider !== 'ollama')}
	<input
		class="field"
		type="text"
		placeholder={placeholder}
		bind:value
	/>
	{#if options.length > 0}
		<button type="button" class="link" onclick={() => (custom = false)}>use list</button>
	{/if}
{:else}
	<select class="field" bind:value>
		{#if !value}<option value="" disabled>{placeholder}</option>{/if}
		{#each options as m (m)}<option value={m}>{m}</option>{/each}
	</select>
	<button type="button" class="link" onclick={() => (custom = true)}>type manually</button>
{/if}

<style>
	.field {
		width: 100%;
		padding: 0.45rem 0.6rem;
		background: #121a33;
		border: 1px solid #1e2740;
		border-radius: 8px;
		color: #e7ecf5;
		font-size: 14px;
	}
	.link {
		background: none;
		border: none;
		color: #4f8cff;
		font-size: 12px;
		cursor: pointer;
		padding: 0.25rem 0;
	}
</style>
```

- [ ] **Step 4: Create `apps/web/src/lib/components/agent/ProviderForm.svelte`**

The form swaps fields per provider. Emits `save` / `test` via callbacks; manages local editable state seeded from the loaded settings.

```svelte
<script lang="ts">
	import {
		agentSettings,
		agentSettings as settingsStore,
		ollamaModels,
		loadSettings,
		fetchOllamaModels,
		saveSettings,
		testConnection,
		saving,
		testing,
		testResult,
		PROVIDER_LABELS,
		DEFAULT_BASE_URL,
		type Provider
	} from '$lib/stores/agentSettings';
	import ModelSelect from './ModelSelect.svelte';

	const PROVIDERS: Provider[] = ['anthropic', 'openai', 'ollama', 'custom'];

	let provider = $state<Provider>('ollama');
	let baseUrl = $state('http://localhost:11434');
	let model = $state('');
	let apiKey = $state(''); // leave blank to keep existing

	// Seed from loaded settings once they arrive.
	let seeded = false;
	$effect(() => {
		const s = $settingsStore;
		if (s && !seeded) {
			seeded = true;
			provider = s.provider;
			baseUrl = s.baseUrl || DEFAULT_BASE_URL[s.provider];
			model = s.model;
			apiKey = '';
		}
	});

	function onProviderChange() {
		baseUrl = DEFAULT_BASE_URL[provider];
		model = '';
		if (provider === 'ollama') fetchOllamaModels(baseUrl);
	}

	function refreshOllama() {
		fetchOllamaModels(baseUrl);
	}

	function payload() {
		return { provider, baseUrl, model, apiKey };
	}

	let showKey = $state(false);
	const keyPlaceholder = $derived(
		$agentSettings?.hasKey ? `(kept: ${$agentSettings?.apiKey || '****'})` : 'paste API key'
	);
</script>

<div class="form">
	<label class="row">
		<span class="lbl">Provider</span>
		<select class="field" bind:value={provider} onchange={onProviderChange}>
			{#each PROVIDERS as p (p)}<option value={p}>{PROVIDER_LABELS[p]}</option>{/each}
		</select>
	</label>

	{#if provider === 'ollama' || provider === 'custom'}
		<label class="row">
			<span class="lbl">Base URL</span>
			<div class="inline">
				<input class="field" type="text" bind:value={baseUrl} />
				{#if provider === 'ollama'}<button type="button" class="btn ghost" onclick={refreshOllama}>↻ Models</button>{/if}
			</div>
		</label>
	{/if}

	{#if provider === 'anthropic' || provider === 'openai' || provider === 'custom'}
		<label class="row">
			<span class="lbl">API Key</span>
			<div class="inline">
				<input class="field" type={showKey ? 'text' : 'password'} placeholder={keyPlaceholder} bind:value={apiKey} />
				<button type="button" class="btn ghost" onclick={() => (showKey = !showKey)}>{showKey ? 'hide' : 'show'}</button>
			</div>
		</label>
	{/if}

	<label class="row">
		<span class="lbl">Model</span>
		<div class="model-row"><ModelSelect {provider} bind:value={model} /></div>
	</label>

	<div class="actions">
		<button class="btn" disabled={$testing || !model} onclick={() => testConnection(payload())}>
			{$testing ? 'Testing…' : 'Test connection'}
		</button>
		<button class="btn primary" disabled={$saving || !model} onclick={async () => { await saveSettings(payload()); }}>
			{$saving ? 'Saving…' : 'Save'}
		</button>
	</div>

	{#if $testResult}
		<div class="result" data-ok={$testResult.ok}>
			{$testResult.ok ? '✓' : '✗'} {$testResult.detail}
		</div>
	{/if}
</div>

<style>
	.form { display: flex; flex-direction: column; gap: 1rem; }
	.row { display: flex; flex-direction: column; gap: 0.35rem; }
	.lbl { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #8a97b5; }
	.inline { display: flex; gap: 0.5rem; }
	.inline .field { flex: 1 1 auto; }
	.model-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
	.field {
		width: 100%; padding: 0.45rem 0.6rem; background: #121a33;
		border: 1px solid #1e2740; border-radius: 8px; color: #e7ecf5; font-size: 14px;
	}
	.actions { display: flex; gap: 0.6rem; }
	.btn {
		padding: 0.5rem 0.9rem; border-radius: 8px; border: 1px solid #1e2740;
		background: #121a33; color: #e7ecf5; font-size: 14px; cursor: pointer;
	}
	.btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn.primary { background: linear-gradient(135deg, #4f8cff, #7a5cff); border: none; color: #fff; }
	.btn.ghost { background: transparent; }
	.result { font-size: 13px; padding: 0.5rem 0.7rem; border-radius: 8px; }
	.result[data-ok='true'] { background: rgba(34,197,94,0.12); color: #22c55e; }
	.result[data-ok='false'] { background: rgba(239,68,68,0.12); color: #ef4444; }
</style>
```

- [ ] **Step 5: Create `apps/web/src/routes/settings/+page.svelte`**

```svelte
<script lang="ts">
	import { onMount } from 'svelte';
	import { loadSettings, fetchOllamaModels, agentSettings } from '$lib/stores/agentSettings';
	import ProviderForm from '$lib/components/agent/ProviderForm.svelte';

	onMount(async () => {
		await loadSettings();
		if ($agentSettings?.provider === 'ollama') {
			fetchOllamaModels($agentSettings.baseUrl || 'http://localhost:11434');
		}
	});
</script>

<svelte:head><title>Agent settings — Harnesh Trading</title></svelte:head>

<div class="page">
	<h1>Agent model settings</h1>
	<p class="muted">Pick an LLM provider, configure it, test, then save. The agent uses this for the next chat.</p>
	<section class="card"><ProviderForm /></section>
</div>

<style>
	.page { max-width: 560px; margin: 0 auto; padding: 2rem 1rem; }
	h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
	.muted { color: #8a97b5; margin: 0 0 1.5rem; }
	.card {
		background: #0b1020; border: 1px solid #1e2740; border-radius: 12px; padding: 1.25rem;
	}
</style>
```

- [ ] **Step 6: Manual verify of the settings page**

Start api (`bun run dev` in apps/api) and web (`bun run dev` in apps/web). Open `http://localhost:5173/settings`.
Expected: form loads with Provider=Ollama (default). Switch to Anthropic → API Key + Model fields appear, Base URL hides. Switch to Ollama → Base URL shows, clicking "↻ Models" lists installed models (or shows empty if Ollama off). Save writes `apps/api/data/agent-settings.json`; reloading the page keeps the saved provider/model + shows masked key note for hosted providers. Test connection shows ✓/✗.

- [ ] **Step 7: Commit**

```bash
git add apps/web/vite.config.ts apps/web/src/lib/stores/agentSettings.ts apps/web/src/lib/components/agent/ModelSelect.svelte apps/web/src/lib/components/agent/ProviderForm.svelte apps/web/src/routes/settings/+page.svelte
git commit -m "$(cat <<'EOF'
feat(web): /settings page for LLM provider config

agentSettings store wraps GET/PUT /agent/settings, /agent/ollama/models,
POST /agent/test. ProviderForm swaps fields per provider (Anthropic/OpenAI:
key + curated model list; Ollama: base URL + live model list; Custom:
base URL + key + free-text model). API key field masked, blank keeps
existing. Vite dev proxy extended for /agent.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: web chat store + `/chat` page (SSE render)

**Files:**
- Create: `apps/web/src/lib/stores/agentChat.ts`
- Create: `apps/web/src/lib/components/agent/ToolStep.svelte`
- Create: `apps/web/src/lib/components/agent/AgentMessage.svelte`
- Create: `apps/web/src/lib/components/agent/MessageInput.svelte`
- Create: `apps/web/src/lib/components/agent/ChatView.svelte`
- Create: `apps/web/src/routes/chat/+page.svelte`

**Interfaces:**
- Consumes: `POST /agent/chat` SSE (Task 3), `agentSettings` store (Task 4) for the footer model label + "not configured" banner.
- Produces: `/chat` route + chat store (`messages`, `streaming`, `sendMessage`, `stop`, `clear`).

- [ ] **Step 1: Create `apps/web/src/lib/stores/agentChat.ts`**

```ts
import { writable, get } from 'svelte/store';

export interface ToolStep {
	type: 'tool_call' | 'tool_result';
	name: string;
	data: unknown;
}

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	tools?: ToolStep[];
}

export const messages = writable<ChatMessage[]>([]);
export const streaming = writable(false);
export const chatError = writable<string | null>(null);

let controller: AbortController | null = null;
let currentAssistantId: string | null = null;

function patchAssistant(patch: (a: ChatMessage) => ChatMessage): void {
	const id = currentAssistantId;
	if (!id) return;
	messages.update((m) => m.map((msg) => (msg.id === id ? patch(msg) : msg)));
}
function appendText(t: string): void {
	patchAssistant((a) => ({ ...a, content: a.content + t }));
}
function pushTool(step: ToolStep): void {
	patchAssistant((a) => ({ ...a, tools: [...(a.tools ?? []), step] }));
}

function handleBlock(block: string): void {
	let event = 'message';
	let data = '';
	for (const line of block.split('\n')) {
		if (line.startsWith('event:')) event = line.slice(6).trim();
		else if (line.startsWith('data:')) data += line.slice(5).trim();
	}
	let payload: any = {};
	try {
		payload = JSON.parse(data);
	} catch {
		return;
	}
	if (event === 'token' && typeof payload.text === 'string') appendText(payload.text);
	else if (event === 'tool_call') pushTool({ type: 'tool_call', name: payload.name, data: payload.input });
	else if (event === 'tool_result') pushTool({ type: 'tool_result', name: payload.name, data: payload.output });
	else if (event === 'error') {
		appendText(`\n\n⚠️ ${payload.message ?? 'error'}`);
		chatError.set(payload.message ?? 'error');
	}
	// 'done' is a no-op; stream end is handled by the reader loop.
}

export async function sendMessage(text: string): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed || get(streaming)) return;
	chatError.set(null);

	const userId = crypto.randomUUID();
	const assistantId = crypto.randomUUID();
	currentAssistantId = assistantId;

	const history = get(messages)
		.filter((m) => m.content.trim().length > 0)
		.map((m) => ({ role: m.role, content: m.content }));
	const bodyMessages = [...history, { role: 'user' as const, content: trimmed }];

	messages.update((m) => [
		...m,
		{ id: userId, role: 'user', content: trimmed },
		{ id: assistantId, role: 'assistant', content: '', tools: [] }
	]);

	streaming.set(true);
	controller = new AbortController();
	try {
		const res = await fetch('/agent/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ messages: bodyMessages }),
			signal: controller.signal
		});
		if (!res.ok || !res.body) {
			let msg = `HTTP ${res.status}`;
			try {
				const j = await res.json();
				if (j?.message) msg = j.message;
			} catch {}
			patchAssistant((a) => ({ ...a, content: `⚠️ ${msg}` }));
			chatError.set(msg);
			return;
		}
		const reader = res.body.getReader();
		const dec = new TextDecoder();
		let buf = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let idx: number;
			while ((idx = buf.indexOf('\n\n')) >= 0) {
				const block = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				handleBlock(block);
			}
		}
	} catch (err: any) {
		if (err?.name !== 'AbortError') {
			patchAssistant((a) => ({ ...a, content: a.content || `⚠️ ${err?.message ?? 'stream failed'}` }));
			chatError.set(err?.message ?? 'stream failed');
		}
	} finally {
		streaming.set(false);
		controller = null;
	}
}

export function stop(): void {
	controller?.abort();
}

export function clear(): void {
	if (get(streaming)) return;
	messages.set([]);
	chatError.set(null);
}
```

- [ ] **Step 2: Create `apps/web/src/lib/components/agent/ToolStep.svelte`**

```svelte
<script lang="ts">
	import type { ToolStep } from '$lib/stores/agentChat';
	let { step }: { step: ToolStep } = $props();
	let open = $state(false);
	const isCall = $derived(step.type === 'tool_call');
	function fmt(d: unknown): string {
		if (d == null) return '';
		if (typeof d === 'string') return d;
		try {
			return JSON.stringify(d, null, 2);
		} catch {
			return String(d);
		}
	}
</script>

<div class="step" data-call={isCall}>
	<button class="head" onclick={() => (open = !open)}>
		<span class="mark">{isCall ? '▸' : '▾'}</span>
		<span class="kind">{isCall ? 'tool_call' : 'tool_result'}</span>
		<span class="name">{step.name}</span>
	</button>
	{#if open}<pre class="body">{fmt(step.data)}</pre>{/if}
</div>

<style>
	.step { font-size: 12px; margin: 0.25rem 0; }
	.head {
		display: flex; align-items: center; gap: 0.4rem; background: none; border: none;
		cursor: pointer; padding: 0.15rem 0; color: #8a97b5; font-family: inherit;
	}
	.mark { width: 0.8ch; }
	.kind { color: #6b7896; text-transform: uppercase; letter-spacing: 0.5px; }
	.name { color: #c7d0e6; font-weight: 600; }
	.step[data-call='true'] .name { color: #4f8cff; }
	.step[data-call='false'] .name { color: #22c55e; }
	.body {
		margin: 0.3rem 0 0.5rem; padding: 0.5rem; background: #0b1020; border: 1px solid #1e2740;
		border-radius: 6px; color: #b8c2d6; white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto;
	}
</style>
```

- [ ] **Step 3: Create `apps/web/src/lib/components/agent/AgentMessage.svelte`**

```svelte
<script lang="ts">
	import type { ChatMessage } from '$lib/stores/agentChat';
	import ToolStep from './ToolStep.svelte';
	let { msg }: { msg: ChatMessage } = $props();
</script>

<div class="msg" data-role={msg.role}>
	<div class="who">{msg.role === 'user' ? 'you' : 'agent'}</div>
	<div class="body">
		{#if msg.tools && msg.tools.length}
			<div class="tools">{#each msg.tools as t (t.type + t.name + Math.random())}<ToolStep step={t} />{/each}</div>
		{/if}
		{#if msg.content}
			<div class="text">{msg.content}</div>
		{:else if msg.role === 'assistant' && (!msg.tools || msg.tools.length === 0)}
			<div class="text muted">thinking…</div>
		{/if}
	</div>
</div>

<style>
	.msg { display: flex; gap: 0.75rem; padding: 0.6rem 0; }
	.who {
		flex: 0 0 3ch; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
		color: #6b7896; padding-top: 0.15rem;
	}
	.msg[data-role='user'] .who { color: #8a97b5; }
	.msg[data-role='assistant'] .who { color: #4f8cff; }
	.body { flex: 1 1 auto; min-width: 0; }
	.text { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
	.text.muted { color: #6b7896; font-style: italic; }
	.tools { margin-bottom: 0.25rem; }
</style>
```

(Note: the `{#each}` key uses `Math.random()` only as a render key for steps that may share name+type — it is not used for logic. Replace with a stable index if preferred: `msg.tools` is append-only, so `{#each msg.tools as t, i (i)}` is also fine.)

- [ ] **Step 4: Create `apps/web/src/lib/components/agent/MessageInput.svelte`**

```svelte
<script lang="ts">
	import { sendMessage, streaming } from '$lib/stores/agentChat';
	let text = $state('');
	function submit() {
		if (!text.trim() || $streaming) return;
		sendMessage(text);
		text = '';
	}
	function onkey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	}
</script>

<div class="input">
	<textarea bind:value={text} onkeydown={onkey} rows="2" placeholder="Ask the trading agent…  (Enter = send, Shift+Enter = newline)"></textarea>
	<button class="send" disabled={$streaming || !text.trim()} onclick={submit}>{$streaming ? '…' : 'Send'}</button>
</div>

<style>
	.input { display: flex; gap: 0.5rem; align-items: flex-end; padding: 0.75rem; border-top: 1px solid #1e2740; }
	textarea {
		flex: 1 1 auto; resize: none; padding: 0.6rem; background: #121a33; border: 1px solid #1e2740;
		border-radius: 8px; color: #e7ecf5; font: inherit; font-size: 14px; line-height: 1.4; max-height: 160px;
	}
	.send {
		padding: 0.6rem 1rem; border-radius: 8px; border: none;
		background: linear-gradient(135deg, #4f8cff, #7a5cff); color: #fff; font-size: 14px; cursor: pointer;
	}
	.send:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
```

- [ ] **Step 5: Create `apps/web/src/lib/components/agent/ChatView.svelte`**

```svelte
<script lang="ts">
	import { messages, streaming, stop, clear } from '$lib/stores/agentChat';
	import { agentSettings } from '$lib/stores/agentSettings';
	import AgentMessage from './AgentMessage.svelte';
	import MessageInput from './MessageInput.svelte';

	let scroller: HTMLDivElement | null = null;
	$effect(() => {
		// re-run when messages or the last content length change -> snap to bottom
		const m = $messages;
		const lastLen = m.length ? m[m.length - 1].content.length : 0;
		void m; void lastLen;
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	});

	const suggestions = ['What is the NIFTY 50 LTP?', 'Sync 1d candles for RELIANCE', 'Explain instrument keys'];
	const configured = $derived(!!$agentSettings && !!$agentSettings.model);
	const modelLabel = $derived($agentSettings ? `${$agentSettings.provider}:${$agentSettings.model}` : 'not configured');
</script>

<section class="chat">
	<div class="topbar">
		<span class="model" data-ok={configured}>● {modelLabel}</span>
		<div class="spacer"></div>
		{#if $streaming}<button class="mini" onclick={stop}>Stop</button>{/if}
		<button class="mini" disabled={$streaming || $messages.length === 0} onclick={clear}>Clear</button>
	</div>

	{#if !configured}
		<div class="banner">Agent not configured — <a href="/settings">set up a model</a> first.</div>
	{/if}

	<div class="scroller" bind:this={scroller}>
		{#if $messages.length === 0}
			<div class="empty">
				<p>Ask the trading agent something.</p>
				<div class="chips">
					{#each suggestions as s (s)}<button class="chip" onclick={() => (suggestion = s)}>{s}</button>{/each}
				</div>
			</div>
		{:else}
			{#each $messages as m (m.id)}<AgentMessage msg={m} />{/each}
		{/if}
	</div>

	<MessageInput />
</section>

<script lang="ts">
	let suggestion = $state('');
	$effect(() => {
		if (suggestion) {
			import('$lib/stores/agentChat').then((m) => m.sendMessage(suggestion));
			suggestion = '';
		}
	});
</script>

<style>
	.chat { display: flex; flex-direction: column; height: calc(100vh - 49px); }
	.topbar { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.75rem; border-bottom: 1px solid #1e2740; }
	.model { font-size: 12px; color: #8a97b5; font-variant-numeric: tabular-nums; }
	.model[data-ok='true'] { color: #22c55e; }
	.spacer { flex: 1 1 auto; }
	.mini { background: #121a33; border: 1px solid #1e2740; color: #c7d0e6; border-radius: 6px; padding: 0.25rem 0.6rem; font-size: 12px; cursor: pointer; }
	.mini:disabled { opacity: 0.5; cursor: not-allowed; }
	.banner { background: rgba(234,179,8,0.12); color: #eab308; padding: 0.5rem 0.75rem; font-size: 13px; }
	.banner a { color: #eab308; }
	.scroller { flex: 1 1 auto; overflow-y: auto; padding: 0 0.75rem; }
	.empty { text-align: center; color: #6b7896; padding: 3rem 1rem; }
	.chips { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: center; margin-top: 1rem; }
	.chip { background: #121a33; border: 1px solid #1e2740; color: #c7d0e6; border-radius: 999px; padding: 0.35rem 0.7rem; font-size: 12px; cursor: pointer; }
</style>
```

> Svelte requires a single `<script>` per module context. The two `<script>` blocks above must be **merged into one** at implementation time — they are split here only to keep the imports and the suggestion-send effect readable. Merge: put the `let suggestion = $state('')` + its `$effect` inside the first `<script lang="ts">` block (after the other state). The `$effect` may then call `sendMessage` directly since it is already imported.

- [ ] **Step 6: Create `apps/web/src/routes/chat/+page.svelte`**

```svelte
<script lang="ts">
	import { onMount } from 'svelte';
	import { loadSettings } from '$lib/stores/agentSettings';
	import ChatView from '$lib/components/agent/ChatView.svelte';
	onMount(() => loadSettings());
</script>

<svelte:head><title>Agent chat — Harnesh Trading</title></svelte:head>
<ChatView />
```

- [ ] **Step 7: Manual verify of the chat page**

With api + web running and Ollama + a model configured in `/settings`:
1. Open `http://localhost:5173/chat`. Footer shows `● ollama:llama3` (green).
2. Type "What is the NIFTY 50 LTP?" → Enter. Expect: an `agent` message appears with `tool_call` / `tool_result` steps (collapsible) and streamed text. Tokens append live; auto-scrolls.
3. Mid-stream, click **Stop** — stream aborts.
4. Ask a follow-up → history is sent; agent has conversational context.
5. Without config (delete `apps/api/data/agent-settings.json`, reload `/chat`) → the yellow "Agent not configured" banner shows.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/stores/agentChat.ts apps/web/src/lib/components/agent/ToolStep.svelte apps/web/src/lib/components/agent/AgentMessage.svelte apps/web/src/lib/components/agent/MessageInput.svelte apps/web/src/lib/components/agent/ChatView.svelte apps/web/src/routes/chat/+page.svelte
git commit -m "$(cat <<'EOF'
feat(web): /chat page with SSE streaming + tool-step rendering

agentChat store parses the POST /agent/chat SSE stream (token/tool_call/
tool_result/done/error) into messages; sendMessage/stop/clear actions;
AbortController for stop. ChatView renders messages with collapsible tool
steps (ToolStep), live token append + auto-scroll, stop/clear, suggested
prompts, and a not-configured banner. Enter sends, Shift+Enter newline.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Header nav links + full e2e

**Files:**
- Modify: `apps/web/src/lib/components/Header.svelte` — add Chat | Settings nav.

**Interfaces:**
- Consumes: `/chat` and `/settings` routes (Tasks 4 + 5).

- [ ] **Step 1: Add nav links to `apps/web/src/lib/components/Header.svelte`**

Insert a `<nav class="links">` between the `.ticks` nav and the `.status` div (inside `<header class="hdr">`):
```svelte
	<nav class="links">
		<a href="/chat" class="navlink">Chat</a>
		<a href="/settings" class="navlink">Settings</a>
	</nav>
```
Add styles inside the existing `<style>` block:
```css
	.links { display: flex; gap: 0.4rem; flex: 0 0 auto; }
	.navlink {
		font-size: 12px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase;
		color: #8a97b5; text-decoration: none; padding: 0.3rem 0.5rem; border-radius: 6px;
	}
	.navlink:hover { color: #e7ecf5; background: #121a33; }
	@media (max-width: 640px) {
		.links { gap: 0.25rem; }
		.navlink { padding: 0.25rem 0.35rem; }
	}
```

- [ ] **Step 2: Full end-to-end manual verify**

1. `cd apps/api && bun run dev` (api on :3000).
2. `cd apps/web && bun run dev` (web on :5173).
3. Open `http://localhost:5173` — header shows market ticks (SSE live) **and** Chat | Settings links.
4. Click **Settings** → choose Ollama, base URL `http://localhost:11434`, refresh models, pick `llama3`, **Test connection** → ✓, **Save**.
5. Click **Chat** → ask "What is the NIFTY 50 LTP?" → see tool_call/tool_result + streamed answer.
6. (Optional, with a real key) Repeat Settings → Anthropic + key → Test → Save → Chat.
7. Confirm `apps/api/data/agent-settings.json` is NOT staged by git (`git status` should not list it — it's gitignored).
8. Confirm the CLI still works: `cd apps/deepagent && bun run src/index.ts` → prompt `>`, asks a question, answers using the same settings file.

- [ ] **Step 3: Run the unit tests one more time**

```bash
cd apps/deepagent && bun test src/agent.test.ts
cd apps/api && bun test src/modules/agent/settings.test.ts
```
Expected: both PASS (5/5 and 6/6).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/components/Header.svelte
git commit -m "$(cat <<'EOF'
feat(web): header nav links to Chat + Settings

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review notes (resolved during planning)

- **Spec coverage**: provider settings page (Task 4), Ollama auto-discovery (Task 4 ModelSelect + Task 2 `/agent/ollama/models`), single active provider (Task 2 PUT), server JSON config (Task 2 settings.ts), SSE token + tool steps (Tasks 3 + 5), masked key / blank-keeps-existing (Task 2), not-configured banner (Task 5), CLI fallback (Task 1), header nav (Task 6). All spec sections covered.
- **Risk acknowledged inline**: `streamEvents({version:'v2'})` vs deepagents' v3-typed override — Step 3 of Task 3 gives the v3 fallback. Verified at impl time.
- **Merge note**: Task 5 Step 5 has two `<script>` blocks that must be merged into one (flagged in-place).
- **`Math.random()` in tests / render keys**: used only for temp-file paths and a render key — not in Workflow-script contexts, so allowed.