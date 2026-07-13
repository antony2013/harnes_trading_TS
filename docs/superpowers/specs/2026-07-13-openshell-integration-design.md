# OpenShell Integration — Design Spec

**Date:** 2026-07-13
**Sub-project:** OpenShell execution environment for the deepagent (standalone; not part of the A/B/C eval+tuning decomposition)
**Status:** Design approved (with refinements); ready for implementation planning

---

## Goal

Replace the deepagent's ephemeral quickjs code interpreter (`eval` tool) with a **persistent, isolated shell execution environment backed by NVIDIA OpenShell**, selected via the existing harness-profile system. The agent gains a real shell it can run commands in across turns — for long-running tasks, real runtimes (Python/Node), and a better execution environment — while the rest of the agent (market-data tools, filesystem backend, model wiring) stays unchanged.

**Three benefits the user asked for, mapped to the design:**
- **Persistent shell sessions** — a per-workspace OpenShell sandbox that survives across turns (and chats within a project), with cwd / env / installed packages / files persisting across `shell` calls.
- **Long-running tasks** — a real container where daemons, scripts, and multi-step jobs can run.
- **Better execution environment** — an isolated Linux container (Ubuntu LTS + bash + curl + git + Python 3 + uv + Node LTS + npm + pnpm) with policy-enforced egress, instead of a quickjs WASM sandbox with no filesystem.

## Background — what exists today

- **Code interpreter:** `createCodeInterpreterMiddleware` (`@langchain/quickjs`) contributes a single `eval({code: string})` tool — a quickjs WASM JS/TS REPL. Stateful *within* a turn, **not across turns** (`afterAgent` deletes the session; `buildAgent` runs per-HTTP-request; no `thread_id` is passed). Wrapped by `buildInterpreterMiddleware` in `apps/deepagent/src/profiles/implementations.ts`, registered as the `interpreter` entry in `MIDDLEWARE_REGISTRY`.
- **PTC bridge (quickjs-specific):** `ptcAllowlist` (10 read-only market-data tools in the default profile) is injected into the REPL as `tools.*` async functions, so eval code can call `tools.getLtp(...)`. This works only because the WASM REPL and the LangChain tools live in the same process.
- **Profile system (Sub-project B, merged):** `buildAgent(cfg)` calls `resolveProfile(loadProfile(cfg.provider, cfg.model))`; `profile.parentMiddleware` is built from `MIDDLEWARE_REGISTRY` by name. Profiles are JSONC data files validated by ajv + post-merge semantic checks. Writable knobs include `ptcAllowlist`, `interpreter`, `middleware`, `subagents`, `flags`. Adding a new middleware = a new registry entry + optional profile field.
- **Production chat path (stateless per request):** `apps/api/src/modules/agent/index.ts:148-213` — `POST /agent/chat` builds a fresh agent per request, body is `{messages}` only (no chat/session/workspace id), full history re-sent by the client each turn, no `configurable` passed to `streamEvents`. No `chats`/`messages` tables. A single shared global workspace `apps/api/data/agent-workspace`.
- **Filesystem tools:** `read_file`/`write_file`/`edit_file`/`ls`/`glob`/`grep` are framework-built-in (deepagents), operating on the `FilesystemBackend` rooted at the workspace. `execute` is NOT registered today (`FilesystemBackend` isn't sandbox-capable; deepagents ships `LocalShellBackend` that is, but we don't use it).
- **OpenShell:** NVIDIA's open-source sandboxed runtime for autonomous agents (Rust CLI, Apache-2.0, v0.0.80, alpha, single-player mode). Provisions persistent sandbox containers via Docker/Podman/MicroVM/Kubernetes; `openshell sandbox create/exec/connect/delete/list`; PVC-backed state at `/sandbox/state`; policy engine (filesystem/network/process/inference); file sync over SSH (tar, git-aware). **Explicitly supports "Windows with WSL 2."** No JS/TS SDK (CLI + Python SDK + undocumented gRPC/REST gateway).

## Scope

**In scope (Mode 3 — replace code interpreter only):**
- A new `openshell` middleware that contributes a `shell({command, upload?, download?})` tool backed by a persistent OpenShell sandbox.
- A per-workspace sandbox pool that outlives per-request `buildAgent`, with lazy-create + idle-reap lifecycle.
- A localhost **tool bridge** (HTTP + bearer token) so sandbox CLI wrappers can invoke the agent's allowed market-data tools (PTC, reimagined for a separate process).
- A minimal sandbox base image (Ubuntu LTS + bash + curl + git + Python 3 + uv + Node LTS + npm + pnpm) with the per-tool wrappers baked in.
- An `ExecutionBackend` interface so the OpenShell-CLI implementation can later be swapped for a TS SDK, and so snapshot/restore + process management can be added without changing the agent architecture.
- Profile-system extension: `OpenShellSpec` + `openshell` registry entry; production profile selects it, default/eval profiles keep `interpreter`.
- `workspaceId` identity + plumbing through the agent route; per-workspace host working dir.
- WSL2 deployment/setup documentation.

**Out of scope (deferred / future):**
- Replacing the `FilesystemBackend` or the agent's filesystem tools (Mode 2). `write_file`/`read_file` stay on the host workspace as the export/seeding layer.
- Sandbox-the-whole-agent (Mode 1).
- Snapshot/restore, process management (list/kill), and the TS-SDK backend — **designed for** via the `ExecutionBackend` interface, but not implemented in v1.
- PVC-based persistence across sandbox re-creation (v1 treats idle-reap/delete as terminal for `/workspace`).
- The full OpenShell policy engine beyond the single bridge-egress rule (filesystem/process/inference policies are future).
- A managed/cloud OpenShell gateway (v1 is local single-player in WSL2).
- Multi-model / Ralph-loop tuning (Sub-project C is independently deferred).

## Architecture

The deepagent gains an OpenShell execution backend that replaces the quickjs `eval` tool with a persistent-shell `shell` tool, **selected via the profile system** — a new `openshell` middleware registry entry alongside the existing `interpreter` (quickjs). A profile's `middleware` list picks one or the other; `ptcAllowlist` feeds the CLI wrappers either way. Quickjs (offline eval suite) and OpenShell (production persistent shell) coexist, chosen per profile.

The deepagent + API run **inside WSL2** so `openshell` is a local subprocess and Docker (the OpenShell compute backend) is available. The OpenShell CLI is installed in WSL2. The bridge HTTP server binds to a localhost port reachable from sandbox containers via the host gateway.

```
[ Bun API + deepagent process (WSL2) ]
   │  agent route: workspaceId → configurable.workspace_id
   │  buildAgent(cfg) per request → profile chooses middleware, e.g. ["openshell",...]
   │
   ├── openshell middleware ── contributes `shell({command, upload?, download?})` tool
   │        │  reads config.configurable.workspace_id (thread_id fallback)
   │        │
   │        ├── WorkspacePool (module-level Map<workspaceId, Handle>) ── outlives per-request buildAgent
   │        │      lazy getOrCreateWorkspace(id) via ExecutionBackend
   │        │      reuse across turns; idle-reap (> idleTimeoutMs)
   │        │      per-id serialization (one in-flight exec per workspace)
   │        │
   │        └── exec(id, command, {upload, download, timeoutMs}) via ExecutionBackend
   │                OpenShellCliBackend → `openshell sandbox exec --name <id> --cwd /workspace -- <cmd>`
   │                captures combined stdout/stderr + exit code (marker-delimited)
   │
   └── ToolBridge (Bun.serve, one per process, 127.0.0.1:bridgePort, bearer-token auth)
          POST /:toolName, header Authorization: Bearer <token>
          tool = allTools.find(name) ∈ ptcAllowlist  →  await tool.invoke(body)  →  JSON
          403 unknown/disallowed; 401 bad token

[ OpenShell sandbox container (per workspace) ]
   /workspace              ← shell working dir (isolated FS); PRIMARY authoring environment
   /usr/local/bin/<tool>   ← CLI wrappers (one per ptcAllowlist entry), baked into image
       curl -s --max-time N -H "Authorization: Bearer $OPENSHELL_BRIDGE_TOKEN" \
            http://$OPENSHELL_BRIDGE_HOST:$OPENSHELL_BRIDGE_PORT/<tool> -d '<json>'
   policy: egress allowed ONLY to <host-gateway>:bridgePort
```

## Components (new code, all under `apps/deepagent/src/openshell/`)

- **`backend.ts`** — the `ExecutionBackend` interface + `ExecResult`/`WorkspaceHandle`/`WorkspaceInfo` types (see *Execution-layer interface* below). The future-proofing seam.
- **`openshell-cli-backend.ts`** — `OpenShellCliBackend implements ExecutionBackend`: spawns the `openshell` CLI via `Bun.spawn` for `create`/`exec`/`delete`/`upload`/`download`/`list`; parses exec output. The v1 implementation.
- **`cli.ts`** — low-level `openshell` CLI invocation helpers (`create`, `exec`, `delete`, `upload`, `download`, `list`) + `parseExecOutput()` (splits combined output on an exit-marker the backend injects: `<<<OPENSHELL_EXIT:$?>>>`; returns `{output, exitCode}`; parse-failure returns raw output + a warning flag, never throws).
- **`pool.ts`** — `WorkspacePool`: `Map<workspaceId, {handle, lastUsed, inFlight}>`; `getOrCreate(id)`, `exec(id, ...)` (serializes per-id via a per-id promise queue), `destroy(id)`, `listIdle()`; a periodic idle-reaper that destroys workspaces idle > `idleTimeoutMs` with no in-flight exec. Depends on `ExecutionBackend`, not the CLI.
- **`bridge.ts`** — `startToolBridge({port, token, allowedTools, allTools})`: `Bun.serve` on `127.0.0.1:port`; `POST /:name` validates `Authorization: Bearer <token>` (401) and `name ∈ allowedTools` (403), then `await tool.invoke(body)` → JSON; per-request timeout. Generates the random token; returns `{port, token}` so the middleware can inject it into sandboxes.
- **`wrappers.ts`** — `generateWrappers(ptcAllowlist, {bridgeHost, bridgePort, token}): Record<string,string>` — produces one bash wrapper script per allowed tool (e.g. `/usr/local/bin/get_ltp`). Each wrapper maps CLI args → the tool's input JSON, curls the bridge, prints the JSON result. Used at image-build time (baked in) and made configurable via env (`OPENSHELL_BRIDGE_HOST/PORT/TOKEN`).
- **`middleware.ts`** — `buildOpenShellMiddleware({image, idleTimeoutMs, bridgePort, executionTimeoutMs, ptcAllowlist, allTools, backend?})`: contributes the `shell` tool; on each call resolves `workspaceId = config.configurable?.workspace_id ?? config.configurable?.thread_id ?? "__default__"`, goes through the pool, execs, returns a `ToolMessage` with `{output, exitCode}` + a persistence note. Registered in `MIDDLEWARE_REGISTRY` as `openshell`. Accepts an injected `backend` (default `OpenShellCliBackend`) for testing.
- **`image/Dockerfile`** — the minimal sandbox image (see *Sandbox image*). Built to an image ref referenced by `openshell.image` in the production profile.
- **`index.ts`** — re-exports the public surface (`buildOpenShellMiddleware`, `ExecutionBackend`, `OpenShellCliBackend`, types).

**Modified existing files:**
- `apps/deepagent/src/profiles/types.ts` — add `OpenShellSpec`; `ProfileData.openshell?: OpenShellSpec`.
- `apps/deepagent/src/profiles/schema.json` — add optional `openshell` field with `additionalProperties:false`.
- `apps/deepagent/src/profiles/middleware.ts` — add `openshell` to `MIDDLEWARE_REGISTRY`; `MwCtx` gains `openshell?: OpenShellSpec` and `allTools: unknown[]` (the real tool objects, so the bridge can invoke them).
- `apps/deepagent/src/profiles/resolve.ts` — when building parent middleware, pass `ctx.openshell` to the `openshell` builder (analogous to `ctx.interpreter`).
- `apps/deepagent/src/profiles/loader.ts` — `validateMerged`: if `middleware` includes `openshell`, require `openshell` to be complete (image/idleTimeoutMs/bridgePort/executionTimeoutMs all present).
- `apps/deepagent/src/profiles/defaults.ts` — unchanged (default profile keeps `interpreter`).
- `apps/deepagent/src/agent.ts` — `workspaceDir()` widens to accept a `workspaceId` and return `join(root, workspaceId)`; `buildAgent` passes the resolved per-workspace dir to `buildBackend`. (The `FilesystemBackend` remains; only the root becomes per-workspace.)
- `apps/api/src/modules/agent/index.ts` — accept a `workspaceId` from the request body (client-owned, stable across a project's chats; derived/stable fallback if absent in v1), pass `configurable: { workspace_id }` into `streamEvents`. Start the `ToolBridge` once per process (lifecycle tied to the API process, not per request).

## Process-singleton lifecycle (correctness note)

`buildAgent` runs **per HTTP request** and is discarded. Persistence therefore requires that the `WorkspacePool` and the `ToolBridge` are **module-level singletons** that `buildOpenShellMiddleware` *references*, not creates. Each per-request `buildAgent` call obtains the same shared pool + bridge across the process; only the per-request agent instance is fresh. The pool is a module-level `Map`; the bridge is started once (lazily on first use, or at API boot) and exposes its `{port, token}` for the middleware to inject into sandboxes. This mirrors how quickjs's `ReplSession` static map already works — except the openshell pool deliberately does **not** destroy on `afterAgent` (the sandbox persists; only idle-reap or explicit `destroyWorkspace` tears it down).

## Execution-layer interface (future-proofing seam)

The middleware and pool depend on `ExecutionBackend`, **not** the OpenShell CLI. v1 ships `OpenShellCliBackend`. Future capabilities arrive behind this interface without changing the agent architecture.

```ts
// apps/deepagent/src/openshell/backend.ts
export interface ExecResult {
  output: string         // combined stdout+stderr
  exitCode: number
  truncated?: boolean
  parseWarning?: boolean // exit marker not found; output is raw
}

export interface WorkspaceHandle {
  id: string
  phase: 'provisioning' | 'ready' | 'error'
}

export interface WorkspaceInfo {
  id: string
  phase: string
  lastUsed: number
}

export interface ExecOpts {
  cwd?: string
  env?: Record<string, string>
  upload?: string[]    // host paths → sandbox /workspace (low-level seed)
  download?: string[]  // sandbox paths → host per-workspace dir (low-level export)
  timeoutMs?: number
}

export interface ExecutionBackend {
  getOrCreateWorkspace(id: string): Promise<WorkspaceHandle>
  exec(id: string, command: string, opts: ExecOpts): Promise<ExecResult>
  destroyWorkspace(id: string): Promise<void>
  listWorkspaces(): Promise<WorkspaceInfo[]>

  // FUTURE — added to the interface + implemented later. The `shell` tool and the
  // middleware do NOT change; they may gain OPTIONAL new tools that call these:
  //   snapshot(id: string): Promise<SnapshotId>
  //   restore(id: string, snapshotId: SnapshotId): Promise<void>
  //   listProcesses(id: string): Promise<ProcessInfo[]>
  //   killProcess(id: string, pid: number): Promise<void>
}
```

**Swapping the implementation later:** a `OpenShellSdkBackend` (once a TS SDK exists) or a `DockerDirectBackend` implement the same interface; the middleware/pool are unchanged. **Adding snapshot/restore + process management:** add the methods to the interface + an impl in `OpenShellCliBackend` + optional new agent tools (`snapshot`, `restore`, `ps`, `kill`) that the profile can opt into — the core `shell` tool and middleware are untouched.

## Data flow

### A `shell` tool call (agent runs code)

1. Agent emits `shell({ command: "python analyze.py", upload: ["analyze.py"] })`.
2. Middleware resolves `workspaceId` from `configurable.workspace_id` (thread_id fallback, `__default__` last resort). `WorkspacePool.getOrCreate(id)` — if absent, `backend.getOrCreateWorkspace(id)` → `openshell sandbox create --name <id> --from <image>` (image has wrappers + bridge-egress policy + bridge env), wait for `ready`.
3. If `upload` host paths given, `backend.exec` uploads them (tar-over-SSH) into `/workspace` before running.
4. `backend.exec(id, "sh -c '<command>; printf \"\\n<<<OPENSHELL_EXIT:$?>>>\"'", {cwd:"/workspace", timeoutMs})` → `openshell sandbox exec --name <id> --cwd /workspace -- ...` → `parseExecOutput` → `{output, exitCode}`.
5. If `download` sandbox paths given, fetch them to the per-workspace host dir (export).
6. Return `ToolMessage` with `output` + `exitCode` + a note: *"This is a persistent shell. cwd, env vars, installed packages, and files in /workspace persist across your shell calls within this workspace."*
7. Bump `lastUsed`; the idle-reaper later destroys workspaces idle > `idleTimeoutMs`.

### A PTC call from inside the shell (agent's script calls a market-data tool)

- Script runs `get_ltp --instrument NIFTY` (a wrapper baked into the image).
- Wrapper: `curl -s --max-time 30 -H "Authorization: Bearer $OPENSHELL_BRIDGE_TOKEN" http://$OPENSHELL_BRIDGE_HOST:$OPENSHELL_BRIDGE_PORT/get_ltp -d '{"instrument":"NIFTY"}'`.
- Bridge: validates token (401 on failure), `get_ltp ∈ ptcAllowlist` (403 if not), `await getLtpTool.invoke({instrument:'NIFTY'})` (hits the real or stubbed Upstox API as usual) → JSON.
- Wrapper prints JSON; the script reads it. The agent never sees this round-trip — it's inside the shell.

### Persistence model

- The **workspace** (sandbox) is the persistent unit. Within a workspace, every `shell` call hits the same container, so `cd`, env vars, `pip install`/`pnpm add`, and written files persist across turns and across chats that share the `workspaceId`.
- Across workspaces, sandboxes are isolated (separate containers, separate `/workspace`).
- PVC-based persistence across sandbox *re-creation* is future; v1 treats idle-reap/delete as terminal for `/workspace`.

### Filesystem boundary (Approach A, sandbox-primary authoring)

- The sandbox's `/workspace` is the **primary authoring environment**. The agent creates and edits files inside the sandbox via shell commands (`cat > file`, heredocs, editors, `pnpm`/`uv` writes).
- The host workspace (`FilesystemBackend`, rooted at `join(workspaceDir(), workspaceId)`) is the **export/seeding layer**. The agent exports **only final artifacts** to the host (via `shell`'s `download`), and may seed files from the host when needed (via `upload`).
- `upload`/`download` are **low-level operations**, not the default workflow. The system-prompt suffix instructs the agent: author in the sandbox; export final artifacts to the host; use `write_file`/`read_file` for host-side final artifacts, not for in-sandbox work.
- The two trees are **separate** (Approach A isolation). No bind-mount in v1.

## Sandbox image

`apps/deepagent/src/openshell/image/Dockerfile`, built to an image ref (e.g. `harnesh/agent-sandbox:ubuntu-lts`) referenced by `openshell.image` in the production profile.

**Contents (minimal, intentional):**
- Base: Ubuntu LTS.
- `bash`, `curl`, `git`, `ca-certificates`, basic coreutils.
- Python 3 + [`uv`](https://docs.astral.sh/uv/).
- Node LTS + `npm` + `pnpm`.
- The generated CLI wrappers (from `wrappers.ts`) installed at `/usr/local/bin/<tool>` for each tool in the production `ptcAllowlist`.
- Env: `OPENSHELL_BRIDGE_HOST`, `OPENSHELL_BRIDGE_PORT`, `OPENSHELL_BRIDGE_TOKEN` (set at sandbox-create time by the backend, so wrappers can reach the bridge).
- OpenShell network policy: egress allowed **only** to `<host-gateway>:bridgePort`.

**Explicitly NOT preinstalled:** heavy ML frameworks (torch, transformers, etc.), browser/automation tooling (playwright, chromium), databases. The agent installs what it needs at runtime via `uv`/`pnpm` (persisted across calls within the workspace). This keeps the image small and the per-workspace provisioning fast.

## Tool bridge

- `Bun.serve` on `127.0.0.1:bridgePort`, one instance per API process (started at API boot, shared across all workspaces/requests).
- **Auth:** a random bearer token generated per process at bridge startup. Wrappers send `Authorization: Bearer <token>`. The bridge rejects missing/wrong tokens with 401. Localhost binding + token = two layers; the token matters because containers reach the bridge via the host gateway (not strict localhost).
- **Routing:** `POST /:toolName` → look up `toolName` in `allTools`; reject if not in `ptcAllowlist` (403); `await tool.invoke(body)`; return the tool result as JSON. Per-request timeout (default 30s, configurable).
- **Reachability:** from inside a WSL2 Docker container, the host is reachable via the host gateway IP / `host.docker.internal`; confirmed in the integration test. `OPENSHELL_BRIDGE_HOST` is set to that address at sandbox-create time.
- **Lifecycle:** the bridge runs for the lifetime of the API process. The token + port are passed into each sandbox at create time (env vars), so wrappers are configured per-workspace.

## CLI wrappers (PTC bridge, reimagined for a separate process)

`wrappers.ts` generates one bash script per tool in `ptcAllowlist`. A wrapper:
1. Parses its CLI args into the tool's input shape (a thin per-tool arg mapping; the schema for each tool's inputs is known at generation time).
2. `curl -s --max-time <timeout> -H "Authorization: Bearer $OPENSHELL_BRIDGE_TOKEN" http://$OPENSHELL_BRIDGE_HOST:$OPENSHELL_BRIDGE_PORT/<tool> -d '<json>'`.
3. Prints the JSON result to stdout (so shell scripts can pipe/parse it).

The wrappers are baked into the image at build time (so the image is self-contained for the production `ptcAllowlist`), and read the bridge location from env at runtime (so the same image works across bridge ports/tokens/processes).

## Profile-system extension

- **New type `OpenShellSpec`:**
  ```ts
  interface OpenShellSpec {
    image: string              // e.g. "harnesh/agent-sandbox:ubuntu-lts"
    idleTimeoutMs: number      // sandbox idle-reap threshold (default 1_800_000 = 30min)
    bridgePort: number         // localhost port for the tool bridge
    executionTimeoutMs: number // per-shell-call bound (default 120_000)
  }
  ```
- `ProfileData` gains optional `openshell?: OpenShellSpec`. `schema.json` adds it with `additionalProperties:false` and the four required sub-fields (when present). `profileVersion` stays 1 (additive, no migration).
- `MIDDLEWARE_REGISTRY.openshell`: `(ctx) => buildOpenShellMiddleware({ ...ctx.openshell, ptcAllowlist: ctx.ptcAllowlist, allTools: ctx.allTools })`. `MwCtx` gains `openshell?: OpenShellSpec` and `allTools`.
- `validateMerged`: if `middleware` includes `"openshell"`, require `openshell` to be fully present (all four fields); else ignore `openshell`.
- **Production profile** (`profiles/<provider>__<model>.jsonc` or a provider default) sets:
  ```jsonc
  {
    "middleware": ["openshell", "coerceToolContent", "readFileContinuation"],
    "openshell": {
      "image": "harnesh/agent-sandbox:ubuntu-lts",
      "idleTimeoutMs": 1800000,
      "bridgePort": 7777,
      "executionTimeoutMs": 120000
    },
    "ptcAllowlist": ["search_instruments","get_ltp","get_ohlc_quote",
      "historical_candles","intraday_candles","option_chain","market_status",
      "read_candles","company_profile","news"]
  }
  ```
- **Default + eval profiles** keep `middleware: ["interpreter","coerceToolContent","readFileContinuation"]` — unchanged, non-regressive.

## Workspace identity + plumbing

- **Identity:** `workspaceId` — a stable, client-owned identifier of a project workspace. It outlives a single chat (a project may have many chats sharing one workspace/sandbox). The user's refinement: this supports future project-oriented workflows.
- **Route change (`apps/api/src/modules/agent/index.ts`):** accept `workspaceId` in the request body (the client `apps/web/src/lib/stores/agentChat.ts` sends a stable one per project). If absent, fall back to a single shared `"__default__"` workspace (v1) — the client is expected to send a real id; the fallback keeps things working without inventing a workspace table now. Pass `configurable: { workspace_id: workspaceId }` into `agent.streamEvents(...)`. The openshell middleware reads `config.configurable?.workspace_id ?? config.configurable?.thread_id ?? "__default__"`.
- **Per-workspace host dir:** `workspaceDir()` widens to `join(root, workspaceId)`; `buildAgent` `mkdirSync`s it per workspace. This is the export/seeding target for `write_file`/`read_file` and for `shell` `download`/`upload`.
- **ToolBridge lifecycle:** started once at API process boot (not per request), since it's shared across all workspaces. Port + token published into each sandbox at create time.

## Error handling

- **OpenShell not installed / Docker not running:** the `openshell` middleware fails fast at first `shell` use with a clear, actionable error (and may probe once at `buildAgent` construction when the profile selects `openshell`). Surfaced as a tool error to the agent, not a process crash.
- **`getOrCreateWorkspace` failure** (image pull, provision timeout, Docker error): pool marks the workspace `phase:'error'`, returns a tool error with the CLI's last condition; subsequent calls on that id do bounded retry rather than spinning.
- **`exec` failure** (workspace not ready, SSH/proxy error): error with the sandbox phase; the pool re-checks phase and re-creates if the workspace went away.
- **Bridge timeout / unreachable:** wrappers curl with `--max-time`; the bridge enforces a per-request timeout; the `shell` call is bounded by `executionTimeoutMs`. A hung wrapper surfaces as a timeout error, not a forever hang.
- **CLI output parse failure** (no exit marker): return raw output + `parseWarning:true`; never throw on parse.
- **Concurrent `shell` calls on the same workspace:** serialized via a per-workspaceId promise queue (cross-workspace parallelism is fine).
- **Idle-reap race:** reaper destroys only workspaces that are idle *and* have no in-flight exec (in-flight tracked via the per-id queue).
- **Bridge auth failure:** 401 logged; the wrapper's curl returns an auth-error string the shell sees (the agent can react).
- **`afterAgent` must NOT destroy the sandbox** (unlike quickjs). The sandbox persists across turns; only idle-reap or explicit `destroyWorkspace` tears it down.

## Testing

**Unit (no OpenShell/Docker needed — the `ExecutionBackend` interface enables fakes):**
- `WorkspacePool`: lazy create, reuse across "turns," idle-reap, per-workspace isolation, per-id serialization — against a `FakeExecutionBackend`.
- `ToolBridge`: name → `tool.invoke`, enforces `ptcAllowlist` (403 disallowed/unknown), 401 bad/missing token, JSON response, request timeout.
- `parseExecOutput`: marker split, combined-stderr handling, parse-failure fallback (`parseWarning`).
- `wrappers.ts`: given a `ptcAllowlist`, produces the expected wrapper scripts with the token + bridge URL.
- Profile spec: `openshell` field validates; `middleware:["openshell",...]` resolves via the registry; coexists with `interpreter`; `validateMerged` requires `openshell` completeness when `openshell` is in `middleware`; default/eval profile unchanged.
- `OpenShellCliBackend`: tested via a **fake CLI runner** (spawns a stub script instead of real `openshell`), asserting the exact `openshell sandbox create/exec/delete/upload/download` invocations + arg shape — no real OpenShell required.

**Integration (gated on `OPENSHELL_AVAILABLE` env = OpenShell on PATH + Docker running; skipped otherwise):**
- End-to-end via the real bridge: `shell({command:"echo hello"})` → `hello`; persistent state (`x=1` then `echo $x` → `1`); wrapper round-trip (`get_ltp` via bridge → a stub market-data tool → JSON); export (`download` sandbox file → host workspace); auth (wrong token → 401 → wrapper error). These run locally / in CI only when OpenShell is present; the unit suite stays green everywhere.

**Eval-suite compatibility:** the offline eval keeps the `interpreter` (quickjs) profile — unchanged, still green. The 8 cases don't exercise `eval`/`shell`, so introducing the `openshell` module is non-regressive. Confirm the full suite stays green with the new module present.

## Deployment / run changes

- The API + deepagent run **in WSL2** (`wsl` → `bun run dev` in the repo). The repo can be accessed at its Windows path via `/mnt/d/...` or cloned inside WSL (the latter avoids cross-filesystem overhead).
- **Setup (documented in the spec + a short setup section in the README/plan):**
  1. In WSL2: install OpenShell — `curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh` (or `uv tool install -U openshell`).
  2. Ensure Docker Desktop's WSL2 backend is running (Docker is already installed on the host).
  3. Build the sandbox image: `docker build -t harnesh/agent-sandbox:ubuntu-lts apps/deepagent/src/openshell/image/` (or via OpenShell's image workflow).
  4. `bun run dev` in WSL2.
- **ToolBridge binding:** `127.0.0.1:bridgePort`; reachable from containers via the host gateway (`host.docker.internal` / WSL2 host IP). `OPENSHELL_BRIDGE_HOST` set to that address at sandbox-create time. Confirmed in the integration test.
- **Agent route:** accepts `workspaceId`; passes `configurable.workspace_id`; starts the bridge once at API boot.
- **Alpha-tool caveat:** OpenShell is v0.0.80 alpha with no TS SDK and an undocumented gateway API; v1 integrates via the CLI subprocess (the documented, stable-ish surface). The `ExecutionBackend` interface isolates us from CLI/SDK churn.

## Future evolution (behind the `ExecutionBackend` interface — no agent-architecture change)

- **Snapshot/restore:** `snapshot(id)` / `restore(id, snapshotId)` — save and roll back workspace state (useful for the deferred Ralph loop and for safe experimentation). Add interface methods + `OpenShellCliBackend` impl + optional `snapshot`/`restore` agent tools the profile can opt into.
- **Process management:** `listProcesses(id)` / `killProcess(id, pid)` — manage long-running processes in the sandbox. Same interface-extension pattern.
- **SDK replacement:** `OpenShellSdkBackend implements ExecutionBackend` once a TS SDK / documented gateway API matures — swap one config; middleware + pool + `shell` tool unchanged.
- **PVC persistence across re-creation:** preserve `/sandbox/state` across `destroy`/`create` so a reaped workspace can be restored.
- **Full policy engine:** filesystem/process/inference policies via `openshell policy set` — beyond the v1 bridge-egress rule.
- **Bind-mount option (Approach B):** if the explicit export workflow proves too chore-heavy for the agent in practice, add a per-workspace bind-mount mode (configurable via `OpenShellSpec`) that shares the host dir with the sandbox, trading isolation for coherence.

## Decisions locked

| Decision | Choice |
|---|---|
| Scope | Mode 3 — replace code interpreter only; `FilesystemBackend` + market-data tools unchanged |
| Deployment | Local, deepagent in WSL2; OpenShell CLI subprocess; Docker compute backend |
| Approach | A — HTTP tool-bridge + isolated sandbox FS; sandbox-primary authoring |
| PTC bridge | Keep, via CLI wrappers in the sandbox curling a localhost bearer-token bridge |
| Identity | `workspaceId` (stable, client-owned, project-oriented) |
| Sandbox image | Ubuntu LTS + bash + curl + git + Python 3 + uv + Node LTS + npm + pnpm (no ML/browser) |
| Bridge security | localhost binding **+** per-process bearer token |
| Future-proofing | `ExecutionBackend` interface; v1 = `OpenShellCliBackend`; snapshot/restore, process mgmt, TS SDK behind it |
| Profile integration | New `openshell` middleware registry entry + `OpenShellSpec`; production selects it, default/eval keep `interpreter` |
| Persistence | Per-workspace sandbox, lazy-create + idle-reap; persists across turns within a workspace; PVC-across-re-creation deferred |
| Eval suite | Keeps quickjs (`interpreter` profile); non-regressive |

## Open / to-confirm during planning

- Exact `workspaceId` source on the client (`apps/web`) and whether a `workspaces` concept/table is introduced now or deferred (v1: client sends a stable id; no server table).
- Whether `write_file`/`read_file` should be hidden from the agent when the `openshell` middleware is active (to enforce sandbox-primary authoring), or just de-emphasized via the prompt suffix. (v1 lean: de-emphasize via prompt suffix; keep the tools available.)
- Exact per-tool wrapper arg mappings (derived from each tool's input schema at plan time).
- Image build/publish workflow (local `docker build` vs OpenShell-managed image) — settled at plan time.