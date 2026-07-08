# Agent Chat UI + LLM Provider Settings — Design

Date: 2026-07-08
Status: Approved (brainstorm)
Scope: v1 — chat UI for the deepagent + a complete model settings page with multi-provider support, including Ollama local-model selection.

## Goal

Give the trading agent (`apps/deepagent`, today a CLI REPL) a modern web chat UI in `apps/web`, with a settings page where the user configures any LLM provider and selects a model — including auto-discovery of locally-installed Ollama models. The agent engine itself stays in `apps/deepagent`; `apps/api` exposes it over HTTP.

## Non-goals (v1)

- Chat history persistence (messages are session-only; refresh resets).
- Multiple saved provider profiles — one active provider at a time.
- Auth / multi-user.
- File attachments.
- Markdown rendering beyond basic text + code blocks.

## Decisions (from brainstorm)

| Decision | Choice |
|---|---|
| Where the agent runs for the web | Inside `apps/api` (Elysia, :3000) — imports `buildAgent` from `apps/deepagent` |
| Settings persistence | Server-side JSON file `apps/api/data/agent-settings.json` (gitignored) |
| Providers supported | Anthropic, OpenAI, Ollama, OpenAI-compatible custom |
| Chat UX | SSE stream with `token` / `tool_call` / `tool_result` / `done` / `error` events; tool steps shown collapsibly |
| Settings page shape | Single active provider; pick → configure → test → save |

## Architecture

```
┌─────────────┐   SSE /agent/chat + REST /agent/*   ┌──────────────────┐
│  apps/web   │  ─────────────────────────────────► │   apps/api       │
│  SvelteKit  │                                      │  Elysia :3000    │
│  /chat      │                                      │  agent module    │
│  /settings  │                                      │   buildAgent()   │
└─────────────┘                                      │   from deepagent │
                                                     │  data/agent-     │
                                                     │  settings.json   │
                                                     └──────────────────┘
```

- The agent engine (`createDeepAgent` + tools + system prompt) remains in `apps/deepagent/src/agent.ts`. `apps/api` imports `buildAgent` and wraps it in HTTP endpoints.
- The existing CLI (`apps/deepagent/src/index.ts`) keeps working. It reads `agent-settings.json` (resolved relative to apps/api/data) when present, falling back to `DEEPAGENT_MODEL` + provider env vars for legacy use.
- API keys never leave the server: `GET /agent/settings` returns masked values; `PUT` keeps the existing key when the field is blank.

## Data model — `apps/api/data/agent-settings.json`

```json
{
  "provider": "ollama",          // "anthropic" | "openai" | "ollama" | "custom"
  "baseUrl": "http://localhost:11434",  // used by ollama + custom; ignored for hosted
  "model": "llama3",
  "apiKey": ""                   // empty for ollama; sk-... for hosted; may be empty for custom
}
```

Helpers: `readSettings()`, `writeSettings()` (atomic: temp file + rename). File is created on first save; absent file = not-configured.

## `apps/deepagent` changes

- `buildAgent` refactored to accept an explicit config object `{ provider, apiKey, baseUrl, model }` instead of reading env directly:
  ```ts
  export async function buildAgent(cfg: AgentConfig): Promise<DeepAgent>
  ```
- New `resolveAgentConfig()` that reads `agent-settings.json`, falling back to `DEEPAGENT_MODEL` + `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env (keeps CLI working). The settings path is resolved as `<repoRoot>/apps/api/data/agent-settings.json` where `repoRoot` is derived from the module location (not `process.cwd()`), overridable via `AGENT_SETTINGS_PATH` env.
- Provider → LangChain model map:
  - `anthropic` → `ChatAnthropic({ model, apiKey })`
  - `openai` → `ChatOpenAI({ model, apiKey })`
  - `ollama` → `ChatOllama({ model, baseUrl })` (no key) — adds `@langchain/ollama` dep
  - `custom` → `ChatOpenAI({ model, apiKey, configuration: { baseURL } })`
- CLI `src/index.ts` calls `resolveAgentConfig()` then `buildAgent(cfg)`.

## API endpoints — `apps/api/src/modules/agent/index.ts`

| Endpoint | Method | Body / Query | Returns |
|---|---|---|---|
| `/agent/settings` | GET | — | `{ provider, baseUrl, model, apiKey: "sk-...abcd" (masked), hasKey }` |
| `/agent/settings` | PUT | `{ provider, apiKey?, baseUrl?, model }` | `{ ok: true }`; omits/blank `apiKey` keeps existing |
| `/agent/test` | POST | `{ provider, apiKey?, baseUrl?, model }` | `{ ok, detail }`; runs a trivial completion (hosted) or list (ollama); does NOT save |
| `/agent/ollama/models` | GET | `?baseUrl=` | `{ models: ["llama3", ...] }` — proxies Ollama `GET <baseUrl>/api/tags` |
| `/agent/chat` | POST | `{ messages: [{role, content}] }` | SSE stream |

**SSE event shapes**:
```
event: token       data: { "text": "The " }
event: tool_call   data: { "name": "search_instruments", "input": {...} }
event: tool_result data: { "name": "...", "output": "..." }
event: done        data: { "messageId": "..." }
event: error       data: { "message": "..." }
```

- The chat endpoint builds the agent from current settings, runs `agent.stream({ messages, streamMode: 'messages' })`, maps LangChain chunks → `token` events, and tool messages → `tool_call` / `tool_result`. Exact mapping against `deepagents`' API is verified at implementation time.
- AbortController: if the SSE client disconnects, the agent run is aborted so we don't keep streaming to a dead connection.

## Web UI (`apps/web`, Svelte 5 runes)

### Routes
- `/chat` — main chat page.
- `/settings` — model settings page.
- Header gains nav links: **Chat** | **Settings** (alongside existing market ticks).

### `/chat`
- Scrollable message list. Assistant messages render text + interleaved tool steps (collapsible). Tokens append live; auto-scroll to bottom.
- `MessageInput` (textarea, Enter to send, Shift+Enter newline) + Send button.
- **Stop** button aborts the SSE stream mid-run.
- Empty state: suggested prompts ("What's NIFTY LTP?", "Sync 1d candles for RELIANCE", "Explain instrument keys").
- Footer shows active model + stream indicator.

### `/settings`
- Provider dropdown: Anthropic / OpenAI / Ollama / OpenAI-compatible.
- Per-provider fields (form swaps via `{#if provider === ...}`):
  - Anthropic: API Key (masked, last-4 shown if saved) + Model dropdown (curated static list: `claude-sonnet-4-6`, `claude-haiku-4-5`, …) with free-text override.
  - OpenAI: API Key + Model dropdown (curated static list: `gpt-4o-mini`, `gpt-4o`, …) with free-text override.
  - Ollama: Base URL (default `http://localhost:11434`) + Model dropdown (fetched live from `/agent/ollama/models`) + Refresh button.
  - Custom: Base URL + API Key + Model (free text).
- **Test connection** button → `POST /agent/test` → shows ✓ Connected / ✗ error.
- **Save** → `PUT /agent/settings`; becomes active for next chat.
- API key field: leave blank to keep existing key.

### Components (`apps/web/src/lib/components/agent/`)
- `ChatView.svelte` — message list, scroll, stop.
- `MessageInput.svelte` — textarea + send.
- `AgentMessage.svelte` — text + tool steps.
- `ToolStep.svelte` — collapsible tool_call/tool_result pair.
- `ProviderForm.svelte` — settings form, switches on provider.
- `ModelSelect.svelte` — model dropdown; Ollama mode fetches `/agent/ollama/models`.

### Store (`apps/web/src/lib/stores/agentChat.ts`)
- `messages: AgentMessage[]`, `streaming: boolean`.
- `sendMessage(text)` — opens SSE to `/agent/chat`, parses events, appends tokens + tool steps.
- `stop()` — aborts the stream.

## Error handling

- No settings file / no key for a hosted provider → `/agent/chat` returns 400 `agent-not-configured`; UI shows a banner linking to `/settings`.
- Provider unreachable / bad key → `error` event mid-stream; `/agent/test` returns `{ ok: false, detail }`.
- Ollama not running → `/agent/ollama/models` returns 502 with `Ollama not reachable at <url>`; settings page shows the same message inline.
- SSE client disconnect → AbortController cancels the agent run.

## Testing

- **Unit** (Bun test or Vitest, whichever the repo uses): `readSettings`/`writeSettings` round-trip; masked-GET doesn't leak full key; provider→model map returns the right class for each provider.
- **Integration**: `/agent/settings` GET → PUT → GET (masked) round-trip; `/agent/ollama/models` against a stubbed Ollama response.
- **Manual e2e**: configure Ollama + llama3 in `/settings` → Test ✓ → open `/chat` → "What's NIFTY LTP?" → see tool steps + streamed answer. Repeat with Anthropic (real key).

## Build order (preview — full plan in writing-plans)

1. Refactor `buildAgent` to take config + add `@langchain/ollama`; keep CLI working via `resolveAgentConfig`.
2. `apps/api` agent module: settings file helpers + REST endpoints + `/agent/chat` SSE.
3. `apps/web`: `/settings` page + components + store.
4. `apps/web`: `/chat` page + SSE parsing + tool-step rendering.
5. Header nav links.
6. Manual e2e + unit/integration tests.