# Agent Workspace Filesystem (Backends + Permissions)

**Date:** 2026-07-08
**Status:** Approved (design phase)
**Refs:** [deepagents backends](https://docs.langchain.com/oss/javascript/deepagents/backends), [deepagents permissions](https://docs.langchain.com/oss/javascript/deepagents/permissions)

## Goal

Give the trading agent a sandboxed virtual filesystem via deepagents' `FilesystemBackend`, so it can use the built-in tools `ls`, `read_file`, `write_file`, `edit_file`, `glob`, and `grep` to persist files on disk across requests — analysis notes, backtest scratch, reports. No web UI changes this phase; the workspace path is env-configurable.

## Context (current state)

- `apps/deepagent/src/agent.ts` — `buildAgent(cfg)` calls `createDeepAgent({ model, tools: allTools, systemPrompt })` with **no `backend` and no `permissions`**. It therefore uses the default `StateBackend`, but since `/agent/chat` passes `messages` with no `thread_id`/checkpointer, the virtual FS is effectively unused and stateless.
- `allTools` (`apps/deepagent/src/tools/`) = 12 custom Upstox trading tools. The deepagents built-in FS tools are not wired in.
- `/agent/chat` SSE endpoint (`apps/api/src/modules/agent/index.ts`) is stateless; full history sent each request; no thread persistence.
- Agent LLM settings live in `apps/api/data/agent-settings.json` (`apps/api/src/modules/agent/settings.ts`) — a sensitive file the sandbox must not expose.

## Decisions (from brainstorming)

1. **Backend:** `FilesystemBackend` rooted at a dedicated workspace directory, `virtualMode: true`. Real files persist on disk; no extra infra; no threading changes.
2. **Permissions:** Allow-all within the workspace. `virtualMode` already sandboxes to `rootDir` (no escape via `..`), so the agent physically cannot reach `agent-settings.json`, source code, or `.env`. An explicit allow rule is passed to make intent auditable and to future-proof deny rules.
3. **UI scope:** Backend-only, env-configurable. No new web UI. Workspace path = fixed default dir, overridable via `AGENT_WORKSPACE_DIR`.

Rejected this phase: `CompositeBackend` (needs LangGraph store + threading), `StateBackend` + threading (files vanish per thread), `LocalShellBackend` (host shell access — unsafe outside local dev), web file browser + settings UI (deferred).

## Design

All changes live in `apps/deepagent/src/agent.ts`. The `buildAgent(cfg)` signature is unchanged, so the `/agent/chat` call site (`buildAgent(s)`) needs no edit.

### 1. New imports

```ts
import { FilesystemBackend } from 'deepagents'          // runtime class
import type { FilesystemPermission } from 'deepagents'  // type only
import { mkdirSync } from 'node:fs'                     // add to existing node:fs import
```

### 2. Workspace path resolver

Mirrors the existing `settingsPath()` pattern (env override → default relative to the deepagent source file, pointing at `apps/api/data/`):

```ts
function workspaceDir(): string {
  return process.env.AGENT_WORKSPACE_DIR ||
    join(dirname(fileURLToPath(import.meta.url)), '../../api/data/agent-workspace')
}
```

- Default: `apps/api/data/agent-workspace/`.
- Override: `AGENT_WORKSPACE_DIR=<absolute path>`.
- The directory is created (idempotently) inside `buildAgent` before the backend is constructed: `mkdirSync(root, { recursive: true })`.

### 3. `buildAgent` — construct backend + permissions

```ts
export async function buildAgent(cfg: AgentConfig) {
  if (!cfg.model) throw new Error('Agent config missing model')
  const model = buildModel(cfg)

  const root = workspaceDir()
  mkdirSync(root, { recursive: true })

  const backend = new FilesystemBackend({ rootDir: root, virtualMode: true })
  const permissions: FilesystemPermission[] = [
    { operations: ['read', 'write'], paths: ['/**'], mode: 'allow' },
  ]

  return createDeepAgent({
    model,
    tools: allTools,
    systemPrompt: SYSTEM_PROMPT,
    backend,
    permissions,
  })
}
```

- `virtualMode: true` — all FS tool paths are confined to `rootDir`. The agent cannot reach anything outside the workspace.
- `permissions` — a single explicit allow-all rule. The default is already permissive ("if no rule matches, the call is allowed"), so this rule is redundant functionally; it exists to document intent and make future deny rules a one-line addition. No deny rules this phase.

### 4. System prompt update

Append to `SYSTEM_PROMPT`:

> You have a virtual filesystem (ls, read_file, write_file, edit_file, glob, grep) rooted at a workspace directory. Use it to persist analysis, notes, and intermediate results across the conversation. Prefer write_file for new artifacts and edit_file for small changes.

### 5. What does NOT change

- `/agent/chat` SSE endpoint, web client (`apps/web/src/lib/stores/agentChat.ts`, `ChatView`, `ToolStep`, etc.), `/settings` UI, and the 12 trading tools — all untouched.
- FS tool calls render through the existing `ToolStep` component; the SSE handler already emits `tool_call`/`tool_result` for any tool name.
- No `execute`/shell tool — `FilesystemBackend` does not provide one (only `LocalShellBackend` / sandbox backends do), matching the "no LocalShell" decision.

### 6. Testing

Add a focused test (extend `apps/deepagent/src/agent.test.ts` or a new `agent-workspace.test.ts`) that:

- Sets `AGENT_WORKSPACE_DIR` to a temp directory.
- Asserts `buildAgent(...)` returns an agent whose tool list includes the built-in FS tools (`read_file`, `write_file`).
- Round-trips a file: write a file via the backend, read it back, assert the content matches. Hermetic — uses a tmp dir, no real-workspace pollution.

## Risks / verification notes

- **Auto-wiring of FS tools:** the docs imply `createDeepAgent` wires the built-in FS tools when `backend` is passed. The package also exports `createFilesystemMiddleware` as a fallback if manual wiring is needed. At implementation time, confirm the tools are present on the built agent; if not, add the filesystem middleware explicitly. Public behavior is unchanged either way.
- **Permission path namespace:** with `virtualMode: true`, FS tool paths are relative to the workspace root. `/**` is expected to match everything under root. Confirm glob semantics at implementation time against the installed `deepagents@1.10.5`.
- **Existing chat regression:** adding a backend is additive — the 12 trading tools and the SSE streaming path are unaffected. Files now persist to disk (expected), but no existing flow depends on statelessness.

## Out of scope (deferred)

- Thread/conversation persistence (`thread_id` + checkpointer).
- `CompositeBackend` with a `StoreBackend` for cross-thread memory.
- Web UI: workspace file browser, workspace settings controls.
- Deny-list permission rules (the explicit allow rule is in place to make these a trivial follow-up).