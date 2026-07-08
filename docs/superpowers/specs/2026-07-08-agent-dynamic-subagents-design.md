# Agent Dynamic Subagents — Phase B Design

**Date:** 2026-07-08
**Status:** Approved (design phase)
**Refs:** [deepagents dynamic-subagents](https://docs.langchain.com/oss/javascript/deepagents/dynamic-subagents), [deepagents subagents](https://docs.langchain.com/oss/javascript/deepagents/subagents)
**Phase:** B of three (A: interpreters ✓ merged at 10a31e4 → B: dynamic subagents → C: event streaming v3). This spec covers Phase B only.

## Goal

Give the trading agent a set of specialist subagents it can delegate to via the `task` tool (static, model-chosen) and the `task()` interpreter global (dynamic, dispatched from inside `eval`). This unlocks the dynamic-subagents orchestration patterns — fan-out across instruments with `Promise.all`, adversarial verification, loop-until-converged, synthesize — so multi-step, multi-symbol analysis happens in code instead of one model turn per tool call. Each subagent has a tailored, restricted tool set; only the parent retains the write/passthrough tools (`sync_candles`, `call_api`).

## Context (current state, post-Phase-A, master 10a31e4)

- `apps/deepagent/src/agent.ts` — `buildAgent(cfg)` calls `createDeepAgent({ model, tools: allTools, systemPrompt: SYSTEM_PROMPT, backend: buildBackend(root), permissions: WORKSPACE_PERMISSIONS, middleware: [buildInterpreterMiddleware()] })`. No `subagents` key yet.
- `allTools` (`apps/deepagent/src/tools/`) = 12 tools: 10 read-only data tools + `sync_candles` + `call_api`.
- `PTC_ALLOWLIST` (Phase A) = the 10 read-only tool names; `buildInterpreterMiddleware()` = `createCodeInterpreterMiddleware({ ptc: PTC_ALLOWLIST, executionTimeoutMs: 30_000 })`.
- The filesystem tools (ls, read_file, write_file, edit_file, glob, grep) are batteries-included — always present for every agent/subagent that shares the backend; the `tools` array controls only the extra (trading) tools.
- `/agent/chat` SSE endpoint uses `agent.streamEvents({messages}, {version:'v2'})` and emits `token` / `tool_call` / `tool_result` / `done` / `error`, unlabeled.

## Verified API facts (from the deepagents docs)

- `subagents` array on `createDeepAgent`; each entry: `name` + `description` + `systemPrompt` (required); optional `tools` (overrides inherited tools **entirely**), `model` (inherits parent by default; accepts `'provider:model'` or a LangChain model), `permissions` (inherits parent by default; replaces if set), `middleware` (**does not** inherit — appended to a default subagent stack), `interruptOn`, `skills`, `responseFormat`.
- A `task` tool is auto-attached when ≥1 synchronous subagent exists. A `general-purpose` subagent is auto-added **unless** the caller provides a synchronous subagent with that name.
- Dynamic dispatch: the interpreter `task({ description, subagentType, responseSchema? })` global is **on by default** when subagents + interpreter middleware are both present. Disable with `createCodeInterpreterMiddleware({ subagents: false })`. `task()` bypasses `interruptOn` (moot — this agent has no HITL).
- There is no per-subagent `backend` field; subagents share the parent's backend. fs tools are always present (batteries-included).

## Decisions (from brainstorming)

1. **Roster — 3 subagents** with restricted tool sets; the parent keeps all 12 tools (coordinator + sole holder of `sync_candles`/`call_api`):

   | subagent | tools | middleware | role |
   |---|---|---|---|
   | `general-purpose` | `READ_ONLY_TOOLS` | none | generic research/fallback — instrument search, LTP, quotes, news summarization. Defined by us (named `general-purpose`) to suppress the framework's auto general-purpose, which would otherwise inherit `sync_candles` + `call_api`. |
   | `quant` | `READ_ONLY_TOOLS` | `[buildInterpreterMiddleware({ subagents: false })]` | fetches candles + computes indicators (RSI/MACD/aggregations) in its own `eval` via PTC. `subagents: false` prevents nested `task()` dispatch from inside the quant's eval (bounds recursion). |
   | `reporter` | `[]` (filesystem tools only) | none | writes analysis/reports to the workspace via `write_file`/`edit_file`. No market-data, no `sync_candles`, no `call_api`. |

2. **`READ_ONLY_TOOLS`** = `allTools` filtered to the `PTC_ALLOWLIST` names. Reuses the Phase A boundary as the single source of truth — one name list, no drift. Excludes `sync_candles` + `call_api`.

3. **Permissions** inherit the parent's `WORKSPACE_PERMISSIONS` (workspace allow-all) for all three — the reporter needs write, which the inherited rule covers. No per-subagent permissions.

4. **Model** inherits the parent's for all three (YAGNI — no per-subagent model).

5. **Dynamic dispatch on by default** for the parent — do NOT pass `subagents: false` to the parent's `buildInterpreterMiddleware()`. The parent's `eval` gets the `task()` global. The quant's middleware passes `subagents: false` (eval + PTC, but no nested task dispatch).

6. **`buildInterpreterMiddleware` gains an options arg**: `buildInterpreterMiddleware(opts?: { subagents?: boolean })` → `createCodeInterpreterMiddleware({ ptc: PTC_ALLOWLIST, executionTimeoutMs: 30_000, ...(opts?.subagents === false ? { subagents: false } : {}) })`. Default (no arg) unchanged from Phase A — parent behavior preserved.

7. **No SSE/UI change in Phase B** — subagent `on_chat_model_stream`/`on_tool_start`/`on_tool_end` events flow through the existing v2 emitters unlabeled. Per-subagent attribution + v3 projections are Phase C.

Rejected this phase: per-subagent models (YAGNI), per-subagent permissions (inherited allow-all suffices), a standalone `researcher` specialist (folded into `general-purpose` — same tool set, differentiated by systemPrompt would be redundant at this scale), giving all subagents eval (over-engineered), enabling nested `task()` from the quant (recursion risk), any v3-streaming work (Phase C).

## Design

All code changes live in `apps/deepagent/`. `buildAgent(cfg)` signature stays unchanged.

### 1. `apps/deepagent/src/agent.ts` — decompose into testable units

Mirrors Phase A's decomposition (small exported units composed in `buildAgent`):

```ts
/** Read-only market-data tools = allTools filtered to the PTC_ALLOWLIST names.
 *  Reuses the Phase A boundary as the single source of truth (no name drift).
 *  Excludes sync_candles + call_api — subagents never get the write/passthrough tools. */
export const READ_ONLY_TOOLS = allTools.filter((t: any) => PTC_ALLOWLIST.includes(t.name))

/** Build the code-interpreter middleware. opts.subagents === false disables the
 *  dynamic task() global (used for the quant subagent to bound recursion); the
 *  default (no arg) preserves the Phase A parent behavior (task() enabled). */
export function buildInterpreterMiddleware(opts?: { subagents?: boolean }) {
  return createCodeInterpreterMiddleware({
    ptc: PTC_ALLOWLIST,
    executionTimeoutMs: 30_000,
    ...(opts?.subagents === false ? { subagents: false } : {}),
  })
}

const QUANT_PROMPT = `You are a quant analyst for the Indian stock market. Fetch candles with the market-data tools and compute indicators / aggregations in eval (RSI, MACD, moving averages, returns, vol). Return concise numeric results. Do not write files.`

const GENERAL_PURPOSE_PROMPT = `You are a general-purpose research subagent for the Indian stock market. Use the market-data tools to search instruments, fetch LTP/OHLC/quotes, option chain, market status, company profile, and news. Summarize what you find concisely. Do not write files.`

const REPORTER_PROMPT = `You are a report writer. Given analysis results, write a clean markdown report to the workspace using write_file/edit_file. You have no market-data tools — work from what the caller provides.`

/** Subagents the parent can delegate to via the task tool or the eval task() global.
 *  general-purpose is defined here (named) to suppress the framework's auto
 *  general-purpose, which would inherit sync_candles + call_api. */
export const SUBAGENTS = [
  { name: 'general-purpose', description: 'Research/fetch market data: instrument search, LTP, quotes, option chain, news, company profile.', systemPrompt: GENERAL_PURPOSE_PROMPT, tools: READ_ONLY_TOOLS },
  { name: 'quant', description: 'Fetch candles and compute indicators/aggregations in eval (RSI, MACD, returns, vol).', systemPrompt: QUANT_PROMPT, tools: READ_ONLY_TOOLS, middleware: [buildInterpreterMiddleware({ subagents: false })] },
  { name: 'reporter', description: 'Write a markdown report/artifact to the workspace from provided analysis.', systemPrompt: REPORTER_PROMPT, tools: [] },
]
```

`buildAgent` — add `subagents: SUBAGENTS` to the existing `createDeepAgent` call. Everything else (model, tools, systemPrompt, backend, permissions, middleware) unchanged. Signature unchanged:

```ts
return createDeepAgent({
  model,
  tools: allTools,
  systemPrompt: SYSTEM_PROMPT,
  backend: buildBackend(root),
  permissions: WORKSPACE_PERMISSIONS,
  middleware: [buildInterpreterMiddleware()],
  subagents: SUBAGENTS,
})
```

### 2. `SYSTEM_PROMPT` update

Append a paragraph after the existing `eval` paragraph (before the closing backtick):

> You can delegate to specialist subagents with the `task` tool, or from inside `eval` via the `task()` global: `task({ description, subagentType, responseSchema })` runs a full agentic loop on a subagent and resolves to its result. Subagents: `general-purpose` (research/fetch market data), `quant` (fetch candles + compute indicators in its own eval), `reporter` (write reports/artifacts to the workspace filesystem). Use `Promise.all` in `eval` to fan out across instruments, then synthesize. Prefer `task()` orchestration for multi-step, multi-symbol analysis instead of doing it all yourself turn-by-turn.

### 3. Testing (`apps/deepagent/src/agent.test.ts`)

Hermetic, no LLM key required:

- `READ_ONLY_TOOLS` = exactly the 10 `PTC_ALLOWLIST` names from `allTools`; excludes `sync_candles` + `call_api`.
- `SUBAGENTS` has exactly 3 entries; names = `general-purpose`, `quant`, `reporter`; no duplicates; `general-purpose` present.
- `general-purpose` and `quant` `tools` = `READ_ONLY_TOOLS`; `reporter` `tools` = `[]`.
- `quant` `middleware` is a truthy non-empty array; `general-purpose` and `reporter` have no `middleware` (undefined).
- `buildAgent` constructs without throwing with `subagents` wired (regression guard — reuses the Phase A pattern).
- `buildInterpreterMiddleware({ subagents: false })` returns truthy (the no-nested-dispatch knob exists and does not throw).

Live `task()` orchestration is verified when an LLM key is available (same constraint as prior phases); hermetic tests cover the roster, tool boundaries, and wiring.

## What does NOT change

- The 12 trading tools, the workspace backend/permissions, `PTC_ALLOWLIST`, the `/agent/chat` SSE endpoint, the web client (`agentChat.ts`, `ChatView`, `ToolStep`), `/settings`.
- No v3 streaming / per-subagent SSE attribution (Phase C).
- The Phase A `buildInterpreterMiddleware()` default behavior (parent) — only an added optional arg.

## Risks / verification notes

- **`tools` override semantics:** per the docs, a subagent `tools` array "overrides the inherited tools entirely." `reporter` with `tools: []` should retain the always-present filesystem tools (batteries-included, shared backend). Verify at implementation (grep the installed `deepagents` source / a runtime probe) that `tools: []` does NOT strip the fs tools — if it does, `reporter` must explicitly receive the fs tools. This is the key implementation-time verification.
- **Auto `general-purpose` suppression:** the docs state the auto general-purpose is suppressed when a synchronous subagent with that name is provided. Verify at implementation that our named `general-purpose` is the one used (no duplicate).
- **`subagents: false` on quant middleware:** confirm `createCodeInterpreterMiddleware` accepts a `subagents` boolean (docs show it). If the installed version rejects it, fall back to not disabling (accept nested dispatch) and note it — the recursion risk is bounded by `executionTimeoutMs` + `maxPtcCalls` either way.
- **`createDeepAgent` accepts a `subagents` key:** confirm via tsc at Task 4 (same pattern as Phase A's `middleware`/`backend`/`permissions` confirmation).
- **Subagent events unlabeled in v2:** accepted for Phase B; the SSE endpoint emits them as `token`/`tool_call`/`tool_result` without subagent attribution. No behavioral bug — just no attribution until Phase C.
- **Live `task()` orchestration unverified without an LLM key:** hermetic tests cover roster + boundaries + wiring.
- **Beta API:** `@langchain/quickjs` interpreter + subagents lifecycle may change between releases. Pin the installed version.

## Out of scope (deferred to Phase C)

- Event streaming v3 migration + subagent-aware SSE/UI (per-subagent handles, projections, attribution).
- Per-subagent models or permissions.
- A standalone `researcher` specialist (folded into `general-purpose`).
- Enabling nested `task()` dispatch from subagents.
- New trading tools or workspace changes.