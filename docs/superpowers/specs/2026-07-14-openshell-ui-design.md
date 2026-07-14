# OpenShell UI — Chat + Settings

**Date:** 2026-07-14
**Status:** Approved (design)
**Feature:** Surface the OpenShell persistent-shell backend in the web UI — specialized shell rendering in chat + an OpenShell configuration surface in settings.

## Context

The OpenShell backend (merged in `a8b7406`) adds a `shell` tool, per-workspace Docker sandboxes, and an `OpenShellSpec` in profiles. The web UI has **zero** references to it today. This spec covers the UI update to expose it.

Key backend facts established during exploration (with file refs):

- **Shell tool** (`apps/deepagent/src/openshell/middleware.ts`): tool name `shell`, input `{ command: string }`, returns a flat string `${output}\n\n[exit: ${exitCode}] [persistent shell: …][optional [warning: …]]` (or `[error: ${msg}]` on exception). No discrete stdout/stderr/exit events; no partial streaming.
- **SSE protocol** (`apps/api/src/modules/agent/index.ts:150-201`): events `token`, `tool_call { name, input }`, `tool_result { name, output }`, `done`, `error`. **Shell calls are already visible** — `tool_call` carries `input.command`, `tool_result` carries the flat output string including `[exit: N]`.
- **SSE consumer** (`apps/web/src/lib/stores/agentChat.ts`): handles `token`/`tool_call`/`tool_result`/`error`; message shape `ChatMessage { id, role, content, tools?: ToolStep[], ts }`, `ToolStep { type, name, data }`. Today `sendMessage` does **not** send `workspaceId` → backend always uses `__default__`.
- **OpenShellSpec** (`apps/deepagent/src/profiles/types.ts:12-17`, `schema.json:20-30`): `{ image: string, idleTimeoutMs: number, bridgePort: number, executionTimeoutMs: number }`, all required, `additionalProperties:false`, integer mins `1` (bridgePort `0`). Optional on `ProfileData`; enabled by adding `"openshell"` to the `middleware` array. No `enable` boolean. Defaults from the example profile: `image:"harnesh/agent-sandbox:ubuntu-lts"`, `idleTimeoutMs:1800000`, `bridgePort:7777`, `executionTimeoutMs:120000`. Bridge host hardcoded `host.docker.internal`.
- **Settings API** (`apps/api/src/modules/agent/index.ts:86-148`, `settings.ts`): `GET/PUT /agent/settings` with `{ provider, baseUrl, model, apiKey }`; `POST /agent/test`; `GET /agent/ollama/models`. On-disk `apps/api/data/agent-settings.json`. **No OpenShell fields, no profile field.**
- **Workspace lifecycle**: `/agent/chat` resolves `workspaceId = body.workspaceId || '__default__'` (regex-validated `^[A-Za-z0-9_-]{1,64}$`), creates `workspaceDir(id)`, passes `configurable.workspace_id` into `streamEvents`. `WorkspacePool.list()` / `reapIdle()` / `backend.listWorkspaces()` exist internally but **no HTTP endpoint** exposes them.
- **Profiles**: auto-selected via 4-level merge `DEFAULT → default.jsonc → <provider>__default.jsonc → <provider>__<model>.jsonc` (`loader.ts:120-126`). Active profile **not exposed to UI**.

## Approach

**Approach B (chosen): overlay settings file**, mirroring the existing `agent-settings.json` pattern. A new `openshell-settings.json` is owned by the API; the deepagent applies it as an override on top of the auto-selected profile. Clean separation (sandbox config ≠ LLM config), no JSONC comment loss, global (applies regardless of active profile).

Rejected: editing active profile JSONC directly (fragile, comment loss, provider+model-scoped churn); extending `agent-settings.json` with an `openshell` block (muddies schemas, still needs deepagent wiring).

## Design

### Architecture + components

**Frontend (`apps/web`)**
1. `ShellStep.svelte` (new) — specialized render for `name === "shell"` tool steps: command line (monospace + copy button), terminal-style output block (monospace, scrollable, dark), exit-code badge (✓ green for `0`, ✗ red for non-zero), warning chip. Parses `[exit: N]` / `[warning:…]` / `[error:…]` markers from the existing flat `tool_result` string — **no backend change required**. Collapsible: expanded while running, collapsed when done.
2. `OpenShellForm.svelte` (new) — settings section: enable toggle + 4 fields (`image`, `idleTimeoutMs`, `bridgePort`, `executionTimeoutMs`) with unit helpers (ms → min/s). Save + Test buttons. Fields disabled when toggle is off. "Requires Docker Desktop" hint linking to `docs/openshell-setup.md`.
3. `AgentMessage.svelte` (modify) — route `shell` tool steps to `ShellStep` instead of the generic `ToolStep`.
4. `agentChat.ts` (modify) — receive the backend-assigned `workspaceId` (from the new `workspace` SSE event), persist it per chat session in the store, and send it on every subsequent `sendMessage`. (No client-side id generation.)
5. `agentOpenshell.ts` (new store) — `GET/PUT /agent/openshell`, mirrors `agentSettings.ts`.

**API (`apps/api`)**
6. `openshell.ts` (new module, mirrors `settings.ts`) — TypeBox schema `{ enabled: boolean, image: string, idleTimeoutMs: number, bridgePort: number, executionTimeoutMs: number }`, atomic read/write of `apps/api/data/openshell-settings.json`. Defaults: `enabled:false`, `image:"harnesh/agent-sandbox:ubuntu-lts"`, `idleTimeoutMs:1800000`, `bridgePort:7777`, `executionTimeoutMs:120000`.
7. Routes in `agent/index.ts` — `GET /agent/openshell`, `PUT /agent/openshell` (TypeBox validation → 422 on bad input, matching existing route style). `POST /agent/openshell/test` → `{ ok, detail }` (Docker availability + image presence).
8. `/agent/chat` (modify) — read `openshell-settings.json`, pass `{ enabled, image, idleTimeoutMs, bridgePort, executionTimeoutMs }` as `openshellOverride` into the deepagent profile-merge/build. Also: if the request body has no `workspaceId`, generate one (uuid), use it for `workspaceDir` + `configurable.workspace_id`, and emit a `workspace` SSE event `{ id }` at stream start; if the body carries one, reuse it.

**Deepagent (`apps/deepagent`)**
9. Profile-merge step (after `loadProfile(provider, model)`): the override carries `{ enabled, image, idleTimeoutMs, bridgePort, executionTimeoutMs }`, but **only the 4 spec fields belong in `OpenShellSpec`** (`additionalProperties:false`, no `enabled`). So: if `enabled` → `profile.openshell = { ...profile.openshell, image, idleTimeoutMs, bridgePort, executionTimeoutMs }` + ensure `"openshell"` in `profile.middleware` (add if missing); if disabled → remove `"openshell"` from `profile.middleware` (leave `profile.openshell` as-is or clear it). `enabled` is consumed only for middleware membership, never written into the spec. Re-validate the merged profile via existing AJV. Expose a param so the API passes the override through to the build.

**SSE protocol addition**
- New event `workspace { id: string }`, emitted at stream start when the backend generates/assigns a `workspaceId`.

### Data flow

**Settings save:** `OpenShellForm` → `PUT /agent/openshell` → `openshell.ts` validates + atomic write → next `/agent/chat` reads it → `openshellOverride` passed into deepagent profile-merge → `buildAgent` registers `shell` middleware → `shell` tool available.

**Chat shell:**
1. User sends message → `POST /agent/chat` (carries stored `workspaceId`, or none on first turn).
2. Backend resolves/generates `workspaceId` → emits `workspace` event → agent runs.
3. Agent calls `shell` → SSE `tool_call { name:"shell", input:{command} }` → `ShellStep` shows command + "running" (expanded).
4. Tool finishes → SSE `tool_result { name:"shell", output }` → `ShellStep` parses markers, renders terminal output + exit badge, collapses.

**Per-session workspace:** first turn → backend assigns id → frontend stores it. Subsequent turns → frontend sends it → backend reuses the same sandbox (state persists: cwd, env, files). New chat session → no id → backend assigns a fresh one.

### Error handling

- `PUT /agent/openshell` bad payload → 422 (matches existing route validation style).
- OpenShell enabled but Docker Desktop not running / image missing → `shell` tool returns its existing `[error: …]` string → `ShellStep` renders red error badge; no crash; chat continues.
- `POST /agent/openshell/test` → `{ ok, detail }` lets the user verify before relying on it.
- `workspaceId` from body still validated by existing regex; backend-generated uuid is always safe.
- OpenShell disabled → `shell` middleware not registered → agent has no shell tool; UI renders nothing shell-specific (graceful).
- `workspace` event missing/late → frontend treats absence as no stored id; next turn still works (backend assigns one).

### Testing

- **API `openshell.ts` + routes:** mirror existing `agent/settings` tests — defaults when no file, write + re-read, atomic write, TypeBox rejects bad payload (non-bool `enabled`, sub-min ports/timeouts, extra props) → 422. Route tests for `GET/PUT /agent/openshell` and `POST /agent/openshell/test`.
- **Deepagent profile-merge:** `enabled:true` sets `openshell` spec + adds `"openshell"` to middleware; `enabled:false` removes it; merged profile re-validates via AJV; disabled-with-no-spec doesn't throw.
- **API `/agent/chat`:** `openshellOverride` read from settings and passed to the build; `workspaceId` auto-generation + `workspace` SSE event on first turn, reuse on subsequent turn. Reuse existing agent route test harness.
- **Frontend:** extract marker parser (`[exit: N]` / `[warning:…]` / `[error:…]`) as a pure function + unit test (exit 0, non-zero, missing marker, error, warning combos). Test `workspaceId` store/persist logic. `ShellStep`/`OpenShellForm` rendering tests only if Svelte component-test infra already exists — otherwise logic-only unit tests (do not add new infra).

## Scope boundaries (v1 — deferred)

- Structured stdout/stderr/exit split (flat-string parsing client-side for v1).
- Workspace management view (list / idle time / reap / destroy) — per-session isolation only.
- Profile picker in the UI — global overlay applies to the active profile.
- Streaming partial shell output mid-command.
- Bridge host field (still hardcoded `host.docker.internal`).

## Build order (sketch — detailed plan in writing-plans output)

1. API `openshell.ts` + `GET/PUT /agent/openshell` + `POST /agent/openshell/test` routes + tests.
2. Deepagent profile-merge override + tests.
3. `/agent/chat` wiring: read settings, pass override, backend `workspaceId` generation + `workspace` SSE event + tests.
4. Frontend store `agentOpenshell.ts` + `OpenShellForm.svelte` (settings page).
5. Frontend `ShellStep.svelte` + marker parser + `AgentMessage` routing + `agentChat` workspace handling + tests.
6. End-to-end verify (with Docker Desktop running).