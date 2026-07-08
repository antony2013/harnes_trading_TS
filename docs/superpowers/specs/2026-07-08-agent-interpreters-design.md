# Agent Interpreters (eval + PTC) — Phase A Design

**Date:** 2026-07-08
**Status:** Approved (design phase)
**Refs:** [deepagents interpreters](https://docs.langchain.com/oss/javascript/deepagents/interpreters)
**Phase:** A of three (A: interpreters → B: dynamic subagents → C: event streaming v3). This spec covers Phase A only.

## Goal

Give the trading agent an in-memory JavaScript interpreter (`eval` tool via `@langchain/quickjs`) so it can run deterministic transforms, loops, and batched tool calls from code. Programmatic Tool Calling (PTC) exposes the read-only market-data tools inside the interpreter via a `tools.*` namespace, so the agent can fetch/aggregate/compute indicators in bulk from a single `eval` call instead of one model turn per tool call. Intermediate values stay in the QuickJS WASM sandbox (token savings); only the final result returns to the model context.

## Context (current state)

- `apps/deepagent/src/agent.ts` — `buildAgent(cfg)` calls `createDeepAgent({ model, tools: allTools, systemPrompt, backend: buildBackend(root), permissions: WORKSPACE_PERMISSIONS })`. No `middleware`. Exports: `workspaceDir`, `WORKSPACE_PERMISSIONS`, `buildBackend`, `buildAgent`, `buildModel`, `resolveAgentConfig`, `SYSTEM_PROMPT`, etc.
- `allTools` (`apps/deepagent/src/tools/`) = 12 tools: `search_instruments`, `get_ltp`, `get_ohlc_quote`, `historical_candles`, `intraday_candles`, `option_chain`, `market_status`, `sync_candles`, `read_candles`, `company_profile`, `news`, `call_api`.
- `/agent/chat` SSE endpoint uses `agent.streamEvents(..., { version: 'v2' })` and emits `token` / `tool_call` / `tool_result` / `done` / `error`. The `eval` tool will flow through this path unchanged in Phase A.
- `@langchain/quickjs` is NOT installed.

## Decisions (from brainstorming)

1. **PTC allowlist:** the 10 read-only market-data tools — `search_instruments`, `get_ltp`, `get_ohlc_quote`, `historical_candles`, `intraday_candles`, `option_chain`, `market_status`, `read_candles`, `company_profile`, `news`. **Exclude** `sync_candles` (writes SQLite files on the server) and `call_api` (arbitrary endpoint passthrough). The allowlist is the permission boundary.
2. **Limits:** `executionTimeoutMs: 30000` (30s, to allow multi-tool PTC network orchestration); other defaults kept — `maxResultChars: 4000`, `maxPtcCalls: 256`, `memoryLimitBytes: 64MB`, `captureConsole: true`.
3. **Always-on** — the interpreter middleware is always added in `buildAgent`. No toggle. QuickJS is sandboxed (no FS/network/shell/clock by default); PTC is the only bridge to host capabilities, gated by the allowlist.
4. **No SSE/UI change in Phase A** — `eval` calls render through the existing `tool_call`/`tool_result` SSE events and the `ToolStep` component like any tool. `maxResultChars` truncates large results.

Rejected this phase: exposing `sync_candles`/`call_api` via PTC (risk of bulk DB writes / arbitrary endpoint hammering with no `interruptOn` gate), env-configurable limits (YAGNI — one tuned timeout suffices), a toggle for the interpreter (YAGNI), any subagent or v3-streaming work (Phases B/C).

## Design

All code changes live in `apps/deepagent/`. `buildAgent(cfg)` signature stays unchanged.

### 1. Dependency

`bun add @langchain/quickjs` (per repo rule: never hand-write `package.json`). Pin whatever version bun resolves; note the installed version in the spec implementation.

### 2. `apps/deepagent/src/agent.ts` — decompose into testable units

Mirrors the workspace phase's decomposition (small exported units composed in `buildAgent`):

```ts
import { createCodeInterpreterMiddleware } from '@langchain/quickjs'

/** PTC allowlist: read-only market-data tools exposed inside the eval interpreter.
 *  Excludes sync_candles (server-side SQLite writes) and call_api (arbitrary endpoint
 *  passthrough) — this list is the interpreter's permission boundary. */
export const PTC_ALLOWLIST: string[] = [
  'search_instruments',
  'get_ltp',
  'get_ohlc_quote',
  'historical_candles',
  'intraday_candles',
  'option_chain',
  'market_status',
  'read_candles',
  'company_profile',
  'news',
]

/** Build the code-interpreter middleware: eval tool + PTC over the read-only data tools,
 *  with a 30s timeout to allow multi-tool network orchestration from a single eval. */
export function buildInterpreterMiddleware() {
  return createCodeInterpreterMiddleware({
    ptc: PTC_ALLOWLIST,
    executionTimeoutMs: 30_000,
  })
}
```

`buildAgent` — add `middleware: [buildInterpreterMiddleware()]` to the existing `createDeepAgent` call. Everything else (model, tools, systemPrompt, backend, permissions) unchanged. Signature unchanged:

```ts
return createDeepAgent({
  model,
  tools: allTools,
  systemPrompt: SYSTEM_PROMPT,
  backend: buildBackend(root),
  permissions: WORKSPACE_PERMISSIONS,
  middleware: [buildInterpreterMiddleware()],
})
```

### 3. `SYSTEM_PROMPT` update

Append guidance (after the existing workspace paragraph):

> You have an `eval` tool that runs JavaScript in a sandboxed QuickJS interpreter (no filesystem, network, or shell access). The read-only market-data tools are available inside `eval` as `tools.*` (e.g. `tools.get_ltp`, `tools.historical_candles`, `tools.search_instruments`). Use `eval` for loops, parallel/batched fetches, and deterministic transforms (indicators, aggregation, filtering) instead of one tool call per turn. For multi-step data work, write a workflow in `eval`.

### 4. Testing (`apps/deepagent/src/agent.test.ts`)

Hermetic, no LLM key required:

- `PTC_ALLOWLIST` deep-equals the 10 expected names and does NOT include `sync_candles` or `call_api`.
- `buildInterpreterMiddleware()` returns a truthy object and does not throw.
- Existing `buildAgent: creates workspace dir if missing` test still passes — proves the middleware wiring does not break agent construction.

Real `eval`/PTC execution is verified when an LLM key is available (same constraint as prior phases); hermetic tests cover the wiring.

## What does NOT change

- `/agent/chat` SSE endpoint, web client (`agentChat.ts`, `ChatView`, `ToolStep`), `/settings` UI, the 12 trading tools, the workspace backend/permissions.
- No subagents (Phase B). No v3 streaming (Phase C).

## Risks / verification notes

- **`@langchain/quickjs` export name:** confirm `createCodeInterpreterMiddleware` is the named export at implementation time (the docs show it). If the installed version exposes it under a different name, adjust the import — same public behavior.
- **Beta API:** the interpreter is documented as beta; APIs may change between releases. Pin the installed version and note it.
- **Timeout semantics:** `executionTimeoutMs` may be CPU-time-only or wall-clock. 30s is a safe margin either way for multi-tool PTC network calls; harmless if CPU-time-only. Tunable later.
- **PTC bypasses `interruptOn`:** moot for this agent — it has no HITL gating. The allowlist (excluding `sync_candles` + `call_api`) is the active guardrail.
- **Real `eval` behavior unverified without an LLM key:** hermetic tests cover allowlist + middleware construction + agent-builds; live execution is verified when a key is available.

## Out of scope (deferred to Phases B/C)

- Dynamic subagents (`subagents` array + `task()` orchestration) — Phase B.
- Event streaming v3 migration + subagent-aware SSE/UI — Phase C.
- Exposing `sync_candles` / `call_api` via PTC.
- Env-configurable interpreter limits.
- A toggle to disable the interpreter.
- Filesystem/network access inside the interpreter (QuickJS has none by default; not adding bridges).