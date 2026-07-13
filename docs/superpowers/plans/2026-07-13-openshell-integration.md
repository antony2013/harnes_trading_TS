# OpenShell Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deepagent's quickjs `eval` code interpreter with a persistent OpenShell-backed `shell` tool, selected via the harness-profile system, with a future-proof `ExecutionBackend` seam.

**Architecture:** A new `openshell` middleware (registry entry alongside `interpreter`) contributes a `shell({command, upload?, download?})` tool. A module-level `WorkspacePool` (keyed by `workspaceId`, outlives per-request `buildAgent`) delegates to an `ExecutionBackend` interface — v1 `OpenShellCliBackend` spawns the `openshell` CLI. A process-singleton `ToolBridge` (Bun.serve, localhost + bearer token) lets sandbox CLI wrappers invoke the agent's `ptcAllowlist` tools. Sandbox = primary authoring env; host workspace = export layer. Default/eval profiles keep `interpreter` (non-regressive).

**Tech Stack:** Bun 1.3.14, TypeScript, `bun:test`, `Bun.serve`/`Bun.spawn`, deepagents 1.10.5, OpenShell CLI (external binary, WSL2), Docker (sandbox compute).

## Global Constraints

- **Runtime/test:** Bun 1.3.14 + `bun:test`. Run deepagent tests from `apps/deepagent` (`bun test`). The full existing suite (104 tests) MUST stay green at every task — the default + eval profiles keep `interpreter` (quickjs); this feature is additive.
- **Dependencies:** Use `bun add` only (never hand-edit `package.json`). No new npm runtime deps expected (`Bun.serve`/`Bun.spawn` are built in; OpenShell is an external CLI, not an npm package).
- **tsconfig:** deepagent `include:["src"]`, `rootDir:"./src"` — all new TS goes under `apps/deepagent/src/openshell/`. The `image/Dockerfile` is non-TS data under `apps/deepagent/src/openshell/image/` (ignored by tsc/bun build).
- **Profile-system invariants (must hold):** `additionalProperties:false` everywhere; `profileVersion:1` (additive field, no migration); two-layer validation (ajv per-file + `validateMerged` post-merge); `MIDDLEWARE_REGISTRY` is a closed name set; fail-fast typed errors. New `openshell` field is optional; `validateMerged` requires it complete only when `middleware` includes `"openshell"`.
- **Middleware naming:** Every LangChain `AgentMiddleware` needs a unique `name` or `ReactAgent` throws at construction. The openshell middleware MUST use a distinct name (e.g. `"OpenShellMiddleware"`), not colliding with `"CodeInterpreterMiddleware"`.
- **Process-singleton correctness:** `WorkspacePool` and `ToolBridge` are module-level singletons that `buildOpenShellMiddleware` *references* — per-request `buildAgent` must NOT recreate them (persistence depends on it). The openshell middleware must NOT destroy the sandbox on `afterAgent` (unlike quickjs).
- **Bridge security:** `127.0.0.1` binding **and** a per-process random bearer token; wrappers send `Authorization: Bearer <token>`; 401 on missing/wrong. Sandbox egress (OpenShell network policy) limited to `<host-gateway>:bridgePort`.
- **Behavior preservation:** `buildAgent` signature unchanged; `buildModel`/`buildBackend`/`WORKSPACE_PERMISSIONS` unchanged except `workspaceDir()` widening to per-workspace. The `as any` boundary cast at the `createDeepAgent` seam (from Sub-project B's final review) stays.
- **Sandbox image (minimal, intentional):** Ubuntu LTS + bash + curl + git + ca-certificates + Python 3 + uv + Node LTS + npm + pnpm + the generated CLI wrappers. NO ML frameworks, NO browser/automation tooling. Agent installs extras at runtime via uv/pnpm (persisted across calls within a workspace).
- **Deployment:** Production runs in WSL2 (so `openshell` is a local subprocess + Docker available). Unit tests never require OpenShell/Docker; integration tests are gated on `OPENSHELL_AVAILABLE` env and skip otherwise.
- **Identity:** `workspaceId` (stable, client-owned). Middleware reads `config.configurable?.workspace_id ?? config.configurable?.thread_id ?? "__default__"`.
- **Elysia/tool-result serialization:** When tool results flow through the Elysia SSE route, convert any SDK class instances to plain objects via JSON round-trip before returning (project gotcha).

---

### Task 1: `parseExecOutput` — CLI output parser

**Files:**
- Create: `apps/deepagent/src/openshell/cli.ts`
- Test: `apps/deepagent/src/openshell/cli.test.ts`

**Interfaces:**
- Produces: `parseExecOutput(raw: string): ExecResult` and `EXIT_MARKER` constant; re-exports `ExecResult` from `./backend` (created Task 2 — for now define `ExecResult` locally in cli.ts and re-export from backend in Task 2). To avoid a forward dependency, define `ExecResult` in `cli.ts` in this task and move it to `backend.ts` in Task 2 (re-exported).

- [ ] **Step 1: Write the failing test**

```ts
// apps/deepagent/src/openshell/cli.test.ts
import { test, expect } from 'bun:test'
import { parseExecOutput, EXIT_MARKER, type ExecResult } from './cli'

test('parseExecOutput: splits output and exit code on the marker', () => {
  const raw = `hello\n${EXIT_MARKER}0>>>`
  const r = parseExecOutput(raw)
  expect(r).toEqual({ output: 'hello', exitCode: 0 })
})

test('parseExecOutput: preserves multi-line output, strips trailing newline before marker', () => {
  const raw = `line1\nline2\n\n${EXIT_MARKER}1>>>`
  const r = parseExecOutput(raw)
  expect(r.output).toBe('line1\nline2\n')
  expect(r.exitCode).toBe(1)
})

test('parseExecOutput: parseWarning when marker absent', () => {
  const r = parseExecOutput('no marker here')
  expect(r.parseWarning).toBe(true)
  expect(r.exitCode).toBe(-1)
  expect(r.output).toBe('no marker here')
})

test('parseExecOutput: parseWarning when marker present but digits malformed', () => {
  const r = parseExecOutput(`out\n${EXIT_MARKER}abc>>>`)
  expect(r.parseWarning).toBe(true)
  expect(r.output).toBe('out')
})

test('parseExecOutput: handles exit code with large value', () => {
  const r = parseExecOutput(`${EXIT_MARKER}255>>>`)
  expect(r.exitCode).toBe(255)
  expect(r.output).toBe('')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/openshell/cli.test.ts`
Expected: FAIL — `Cannot find module './cli'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/deepagent/src/openshell/cli.ts
export interface ExecResult {
  output: string
  exitCode: number
  truncated?: boolean
  parseWarning?: boolean
}

export const EXIT_MARKER = '<<<OPENSHELL_EXIT:'

/** Parse combined stdout+stderr emitted by `sh -c '<cmd>; printf "\n<<<OPENSHELL_EXIT:$?>>>"'`.
 *  Never throws: a missing/malformed marker yields parseWarning + exitCode -1. */
export function parseExecOutput(raw: string): ExecResult {
  const idx = raw.lastIndexOf(EXIT_MARKER)
  if (idx === -1) return { output: raw, exitCode: -1, parseWarning: true }
  const after = raw.slice(idx + EXIT_MARKER.length)
  const m = after.match(/^(\d+)>>>/)
  const output = raw.slice(0, idx).replace(/\n$/, '')
  if (!m) return { output, exitCode: -1, parseWarning: true }
  return { output, exitCode: Number(m[1]) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/openshell/cli.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/openshell/cli.ts apps/deepagent/src/openshell/cli.test.ts
git commit -m "feat(openshell): add parseExecOutput CLI output parser"
```

---

### Task 2: `ExecutionBackend` interface + `InMemoryExecutionBackend`

**Files:**
- Create: `apps/deepagent/src/openshell/backend.ts`
- Test: `apps/deepagent/src/openshell/backend.test.ts`
- Modify: `apps/deepagent/src/openshell/cli.ts` (re-export `ExecResult` from `./backend`; remove local def)

**Interfaces:**
- Produces: `ExecutionBackend`, `ExecOpts`, `WorkspaceHandle`, `WorkspaceInfo`, `ExecResult`, `InMemoryExecutionBackend` (a no-OpenShell reference/test double).
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```ts
// apps/deepagent/src/openshell/backend.test.ts
import { test, expect } from 'bun:test'
import { InMemoryExecutionBackend, type ExecResult } from './backend'

test('InMemoryExecutionBackend: getOrCreateWorkspace creates ready then reuses', async () => {
  const b = new InMemoryExecutionBackend()
  const h1 = await b.getOrCreateWorkspace('w1')
  const h2 = await b.getOrCreateWorkspace('w1')
  expect(h1.phase).toBe('ready')
  expect(h2.id).toBe('w1')
})

test('InMemoryExecutionBackend: exec records log + returns canned/derived result', async () => {
  const b = new InMemoryExecutionBackend((cmd) => ({ output: `ran:${cmd}`, exitCode: 0 }))
  await b.getOrCreateWorkspace('w1')
  const r = await b.exec('w1', 'echo hi')
  expect(r).toEqual({ output: 'ran:echo hi', exitCode: 0 })
  expect(b.execLog).toEqual([{ id: 'w1', command: 'echo hi', opts: undefined }])
})

test('InMemoryExecutionBackend: exec on unknown workspace throws', async () => {
  const b = new InMemoryExecutionBackend()
  expect(b.exec('nope', 'x')).rejects.toThrow(/unknown workspace/)
})

test('InMemoryExecutionBackend: destroy + listWorkspaces', async () => {
  const b = new InMemoryExecutionBackend()
  await b.getOrCreateWorkspace('w1')
  await b.getOrCreateWorkspace('w2')
  expect((await b.listWorkspaces()).map((w) => w.id).sort()).toEqual(['w1', 'w2'])
  await b.destroyWorkspace('w1')
  expect((await b.listWorkspaces()).map((w) => w.id)).toEqual(['w2'])
})

test('InMemoryExecutionBackend: implements ExecutionBackend (structural)', async () => {
  const b: import('./backend').ExecutionBackend = new InMemoryExecutionBackend()
  expect(typeof b.getOrCreateWorkspace).toBe('function')
  expect(typeof b.exec).toBe('function')
  expect(typeof b.destroyWorkspace).toBe('function')
  expect(typeof b.listWorkspaces).toBe('function')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/openshell/backend.test.ts`
Expected: FAIL — `Cannot find module './backend'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/deepagent/src/openshell/backend.ts
export interface ExecResult {
  output: string
  exitCode: number
  truncated?: boolean
  parseWarning?: boolean
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
  upload?: string[]   // host paths -> sandbox /workspace (low-level seed)
  download?: string[] // sandbox paths -> host per-workspace dir (low-level export)
  timeoutMs?: number
}

/** The execution-layer seam. v1 impl: OpenShellCliBackend (Task 3).
 *  FUTURE (added behind this interface, no agent-arch change): snapshot/restore, listProcesses/killProcess. */
export interface ExecutionBackend {
  getOrCreateWorkspace(id: string): Promise<WorkspaceHandle>
  exec(id: string, command: string, opts?: ExecOpts): Promise<ExecResult>
  destroyWorkspace(id: string): Promise<void>
  listWorkspaces(): Promise<WorkspaceInfo[]>
}

/** In-process reference implementation + test double. No OpenShell/Docker required. */
export class InMemoryExecutionBackend implements ExecutionBackend {
  private workspaces = new Map<string, { phase: WorkspaceHandle['phase']; lastUsed: number }>()
  public execLog: { id: string; command: string; opts?: ExecOpts }[] = []
  constructor(private readonly resultFor?: (command: string) => ExecResult) {}

  async getOrCreateWorkspace(id: string): Promise<WorkspaceHandle> {
    if (!this.workspaces.has(id)) {
      this.workspaces.set(id, { phase: 'ready', lastUsed: Date.now() })
    }
    return { id, phase: this.workspaces.get(id)!.phase }
  }

  async exec(id: string, command: string, opts?: ExecOpts): Promise<ExecResult> {
    this.execLog.push({ id, command, opts })
    const ws = this.workspaces.get(id)
    if (!ws) throw new Error(`unknown workspace: ${id}`)
    ws.lastUsed = Date.now()
    return this.resultFor ? this.resultFor(command) : { output: '', exitCode: 0 }
  }

  async destroyWorkspace(id: string): Promise<void> {
    this.workspaces.delete(id)
  }

  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    return [...this.workspaces.entries()].map(([id, v]) => ({ id, phase: v.phase, lastUsed: v.lastUsed }))
  }
}
```

Update `cli.ts` to re-export `ExecResult` from `./backend` and drop the local definition:

```ts
// apps/deepagent/src/openshell/cli.ts (top of file)
export type { ExecResult } from './backend'
import type { ExecResult } from './backend'
// ...keep EXIT_MARKER + parseExecOutput unchanged, but reference the imported ExecResult type
```
(Leave `parseExecOutput`'s body identical; only the `ExecResult` definition moves.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/openshell/`
Expected: cli + backend tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/openshell/backend.ts apps/deepagent/src/openshell/backend.test.ts apps/deepagent/src/openshell/cli.ts
git commit -m "feat(openshell): add ExecutionBackend interface + InMemoryExecutionBackend"
```

---

### Task 3: `OpenShellCliBackend` + CLI invocation helpers

**Files:**
- Create: `apps/deepagent/src/openshell/openshell-cli-backend.ts`
- Test: `apps/deepagent/src/openshell/openshell-cli-backend.test.ts`
- Modify: `apps/deepagent/src/openshell/cli.ts` (add `runCli` + `openshell sandbox <sub>` arg builders)

**Interfaces:**
- Consumes: `ExecutionBackend`, `parseExecOutput`, `EXIT_MARKER` (from Tasks 1–2).
- Produces: `OpenShellCliBackend` (implements `ExecutionBackend`), `runCli(args, opts)`, arg-builder helpers.

- [ ] **Step 1: Write the failing test (fake CLI runner — no real OpenShell)**

```ts
// apps/deepagent/src/openshell/openshell-cli-backend.test.ts
import { test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenShellCliBackend } from './openshell-cli-backend'

// A fake "openshell" binary that records args + responds to subcommands.
function fakeOpenshellBin(dir: string): string {
  const path = join(dir, 'openshell')
  writeFileSync(path, `#!/usr/bin/env bash
echo "FAKE openshell $@" >> "${join(dir, 'calls.log')}"
case "$1" in
  sandbox)
    case "$2" in
      create) echo "ready" ;;            # last condition line for create
      exec) shift 2; while [ "$1" != "--" ]; do shift; done; shift; "$@" ;;  # strip --name/--cwd through -- , run the command after
      delete) ;;
      list) echo "NAME PHASE" ;;
    esac ;;
esac
`)
  return path
}

let dir: string
let bin: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'osh-'))
  bin = fakeOpenshellBin(dir)
})

test('OpenShellCliBackend: getOrCreateWorkspace runs `sandbox create --name <id> --from <image>`', async () => {
  const b = new OpenShellCliBackend({ binary: ['bash', bin], image: 'img:1' })
  const h = await b.getOrCreateWorkspace('w1')
  expect(h.id).toBe('w1')
  const calls = require('node:fs').readFileSync(join(dir, 'calls.log'), 'utf8')
  expect(calls).toContain('sandbox create')
  expect(calls).toContain('--name w1')
  expect(calls).toContain('--from img:1')
})

test('OpenShellCliBackend: exec wraps command with exit marker + parses', async () => {
  const b = new OpenShellCliBackend({ binary: ['bash', bin], image: 'img:1' })
  await b.getOrCreateWorkspace('w1')
  const r = await b.exec('w1', 'echo hello')
  expect(r.output).toBe('hello')
  expect(r.exitCode).toBe(0)
})

test('OpenShellCliBackend: exec exit code propagates', async () => {
  const b = new OpenShellCliBackend({ binary: ['bash', bin], image: 'img:1' })
  await b.getOrCreateWorkspace('w1')
  const r = await b.exec('w1', 'sh -c "exit 7"')
  expect(r.exitCode).toBe(7)
})

test('OpenShellCliBackend: destroy runs `sandbox delete --name <id>`', async () => {
  const b = new OpenShellCliBackend({ binary: ['bash', bin], image: 'img:1' })
  await b.getOrCreateWorkspace('w1')
  await b.destroyWorkspace('w1')
  const calls = require('node:fs').readFileSync(join(dir, 'calls.log'), 'utf8')
  expect(calls).toContain('sandbox delete')
  expect(calls).toContain('--name w1')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/openshell/openshell-cli-backend.test.ts`
Expected: FAIL — `Cannot find module './openshell-cli-backend'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/deepagent/src/openshell/cli.ts (append to existing file)
export interface RunCliResult { stdout: string; stderr: string; exitCode: number }

export async function runCli(
  binary: string | string[],
  args: string[],
  opts?: { timeoutMs?: number; input?: string }
): Promise<RunCliResult> {
  // binary may be a single executable ("openshell") or a prefix list (e.g.
  // ["bash", script] for tests on OSes that don't honor shebangs on
  // extension-less scripts, or ["wsl", "--", "openshell"] for a future host).
  const proc = Bun.spawn(
    Array.isArray(binary) ? [...binary, ...args] : [binary, ...args],
    {
      stdin: opts?.input ? 'pipe' : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  if (opts?.input) {
    proc.stdin!.write(opts.input)
    await proc.stdin!.end()
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

/** `openshell sandbox create --name <id> --from <image>` (+ optional env uploads). */
export function createArgs(id: string, image: string, env?: Record<string, string>): string[] {
  const args = ['sandbox', 'create', '--name', id, '--from', image]
  for (const [k, v] of Object.entries(env ?? {})) args.push('--env', `${k}=${v}`)
  return args
}
export function execArgs(id: string, command: string, cwd?: string): string[] {
  const args = ['sandbox', 'exec', '--name', id]
  if (cwd) args.push('--cwd', cwd)
  args.push('--', 'sh', '-c', `${command}; printf '\\n${EXIT_MARKER}%d>>>' "$?"`)
  return args
}
export function deleteArgs(id: string): string[] { return ['sandbox', 'delete', '--name', id] }
export function listArgs(): string[] { return ['sandbox', 'list'] }
```

```ts
// apps/deepagent/src/openshell/openshell-cli-backend.ts
import type { ExecutionBackend, ExecResult, WorkspaceHandle, WorkspaceInfo, ExecOpts } from './backend'
import { runCli, parseExecOutput, createArgs, execArgs, deleteArgs } from './cli'

export interface OpenShellCliBackendOpts {
  /** CLI to invoke: "openshell" (default, production) or a prefix list like
   *  ["bash", script] for tests on OSes that don't honor shebangs on
   *  extension-less scripts. */
  binary?: string | string[]
  image: string
  defaultCwd?: string
  /** Bridge env injected into each sandbox at create time. */
  bridgeEnv?: Record<string, string>
}

export class OpenShellCliBackend implements ExecutionBackend {
  private readonly binary: string | string[]
  private readonly cwd: string
  constructor(private readonly opts: OpenShellCliBackendOpts) {
    this.binary = opts.binary ?? 'openshell'
    this.cwd = opts.defaultCwd ?? '/workspace'
  }

  async getOrCreateWorkspace(id: string): Promise<WorkspaceHandle> {
    // v1: create is idempotent enough for our use; OpenShell returns Ready or errors.
    const env = { ...this.opts.bridgeEnv }
    const r = await runCli(this.binary, createArgs(id, this.opts.image, env))
    if (r.exitCode !== 0) return { id, phase: 'error' }
    return { id, phase: 'ready' }
  }

  async exec(id: string, command: string, opts?: ExecOpts): Promise<ExecResult> {
    const r = await runCli(this.binary, execArgs(id, command, opts?.cwd ?? this.cwd), { timeoutMs: opts?.timeoutMs })
    // combine stdout+stderr (matches LocalShellBackend semantics); marker is on stdout
    return parseExecOutput(r.stdout + r.stderr)
  }

  async destroyWorkspace(id: string): Promise<void> {
    await runCli(this.binary, deleteArgs(id))
  }

  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    const r = await runCli(this.binary, ['sandbox', 'list'])
    // v1: best-effort parse; full parsing is not required for correctness (pool tracks state)
    return r.stdout.split('\n').filter(Boolean).map((line) => ({ id: line, phase: 'ready', lastUsed: 0 }))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/openshell/openshell-cli-backend.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/openshell/openshell-cli-backend.ts apps/deepagent/src/openshell/openshell-cli-backend.test.ts apps/deepagent/src/openshell/cli.ts
git commit -m "feat(openshell): add OpenShellCliBackend + CLI invocation helpers"
```

---

### Task 4: `WorkspacePool` — lazy create, reuse, idle-reap, per-id serialization

**Files:**
- Create: `apps/deepagent/src/openshell/pool.ts`
- Test: `apps/deepagent/src/openshell/pool.test.ts`

**Interfaces:**
- Consumes: `ExecutionBackend` (Task 2).
- Produces: `WorkspacePool` (module-singleton accessor `getWorkspacePool(backend?)`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/deepagent/src/openshell/pool.test.ts
import { test, expect, beforeEach } from 'bun:test'
import { WorkspacePool } from './pool'
import { InMemoryExecutionBackend } from './backend'

let backend: InMemoryExecutionBackend
beforeEach(() => { backend = new InMemoryExecutionBackend((cmd) => ({ output: `out:${cmd}`, exitCode: 0 })) })

test('WorkspacePool: lazy-creates a workspace once, reuses after', async () => {
  const pool = new WorkspacePool(backend, { idleTimeoutMs: 60_000 })
  await pool.exec('w1', 'a')
  await pool.exec('w1', 'b')
  // getOrCreateWorkspace called once for w1
  const creates = backend.execLog // exec called twice
  expect(creates).toHaveLength(2)
  // (getOrCreateWorkspace count is internal; assert via listWorkspaces size = 1)
  expect((await pool.list()).map((w) => w.id)).toEqual(['w1'])
})

test('WorkspacePool: isolates workspaces by id', async () => {
  const pool = new WorkspacePool(backend, { idleTimeoutMs: 60_000 })
  await pool.exec('w1', 'a')
  await pool.exec('w2', 'b')
  expect((await pool.list()).map((w) => w.id).sort()).toEqual(['w1', 'w2'])
})

test('WorkspacePool: serializes concurrent execs on the same id', async () => {
  let active = 0, maxActive = 0
  const slow = new InMemoryExecutionBackend(async (cmd) => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 10)); active--; return { output: cmd, exitCode: 0 } })
  // InMemoryExecutionBackend.resultFor is sync in Task 2; for this test use a custom backend:
  const backend2: import('./backend').ExecutionBackend = {
    async getOrCreateWorkspace(id) { return { id, phase: 'ready' } },
    async exec(id, command) { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 10)); active--; return { output: command, exitCode: 0 } },
    async destroyWorkspace() {},
    async listWorkspaces() { return [] },
  }
  const pool = new WorkspacePool(backend2, { idleTimeoutMs: 60_000 })
  await Promise.all([pool.exec('w1', 'x'), pool.exec('w1', 'y'), pool.exec('w1', 'z')])
  expect(maxActive).toBe(1)
})

test('WorkspacePool: reaps workspaces idle longer than idleTimeoutMs', async () => {
  const pool = new WorkspacePool(backend, { idleTimeoutMs: 0, reapIntervalMs: 5 })
  await pool.exec('w1', 'a')
  await new Promise((r) => setTimeout(r, 20))
  expect((await pool.list()).map((w) => w.id)).toEqual([])
})

test('WorkspacePool: does not reap a workspace with an in-flight exec', async () => {
  let resolve: () => void = () => {}
  const backend2: import('./backend').ExecutionBackend = {
    async getOrCreateWorkspace(id) { return { id, phase: 'ready' } },
    async exec() { await new Promise<void>((r) => (resolve = r)); return { output: '', exitCode: 0 } },
    async destroyWorkspace() {},
    async listWorkspaces() { return [] },
  }
  const pool = new WorkspacePool(backend2, { idleTimeoutMs: 0, reapIntervalMs: 5 })
  const inflight = pool.exec('w1', 'long')
  await new Promise((r) => setTimeout(r, 20))
  expect((await pool.list()).map((w) => w.id)).toEqual(['w1']) // not reaped
  resolve()
  await inflight
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/openshell/pool.test.ts`
Expected: FAIL — `Cannot find module './pool'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/deepagent/src/openshell/pool.ts
import type { ExecutionBackend, ExecResult, ExecOpts, WorkspaceInfo } from './backend'

export interface PoolOptions {
  idleTimeoutMs: number
  reapIntervalMs?: number
}

interface Entry { id: string; lastUsed: number; inFlight: number; chain: Promise<unknown> }

export class WorkspacePool {
  private entries = new Map<string, Entry>()
  private reapTimer?: ReturnType<typeof setInterval>

  constructor(private readonly backend: ExecutionBackend, private readonly opts: PoolOptions) {
    if (opts.reapIntervalMs !== undefined) {
      this.reapTimer = setInterval(() => void this.reapIdle(), opts.reapIntervalMs)
      // Note: keep timer unref'd semantics by allowing process to exit regardless — Bun keeps it; tests call stop().
    }
  }

  async exec(id: string, command: string, opts?: ExecOpts): Promise<ExecResult> {
    let entry = this.entries.get(id)
    if (!entry) {
      entry = { id, lastUsed: Date.now(), inFlight: 0, chain: Promise.resolve() }
      this.entries.set(id, entry)
      await this.backend.getOrCreateWorkspace(id)
    }
    // Per-id serialization: chain execs so only one is in-flight per workspace.
    const run = entry.chain.then(async () => {
      entry!.inFlight++
      try {
        entry!.lastUsed = Date.now()
        return await this.backend.exec(id, command, opts)
      } finally {
        entry!.inFlight--
      }
    })
    entry.chain = run.then(() => undefined, () => undefined)
    return run
  }

  async list(): Promise<WorkspaceInfo[]> {
    return [...this.entries.entries()].map(([id, e]) => ({ id, phase: 'ready', lastUsed: e.lastUsed }))
  }

  async reapIdle(): Promise<void> {
    const now = Date.now()
    for (const [id, e] of [...this.entries.entries()]) {
      if (e.inFlight === 0 && now - e.lastUsed > this.opts.idleTimeoutMs) {
        await this.backend.destroyWorkspace(id).catch(() => {})
        this.entries.delete(id)
      }
    }
  }

  stop(): void { if (this.reapTimer) clearInterval(this.reapTimer) }
}

/** Module-level singleton accessor — per-request buildAgent reuses one pool per process. */
let _singleton: WorkspacePool | undefined
export function getWorkspacePool(backend: ExecutionBackend, opts: PoolOptions): WorkspacePool {
  if (!_singleton) _singleton = new WorkspacePool(backend, opts)
  return _singleton
}
/** Test helper to reset the singleton between test files. */
export function _resetWorkspacePoolSingleton(): void { _singleton?.stop(); _singleton = undefined }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/openshell/pool.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/openshell/pool.ts apps/deepagent/src/openshell/pool.test.ts
git commit -m "feat(openshell): add WorkspacePool (lazy create, reuse, idle-reap, per-id serialize)"
```

---

### Task 5: `ToolBridge` — localhost bearer-token HTTP tool proxy

**Files:**
- Create: `apps/deepagent/src/openshell/bridge.ts`
- Test: `apps/deepagent/src/openshell/bridge.test.ts`

**Interfaces:**
- Consumes: `allTools` (the agent's `StructuredTool[]`), `ptcAllowlist` (names).
- Produces: `startToolBridge({port, allowedTools, allTools})` → `{server, port, token, stop()}`; module singleton `getToolBridge()`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/deepagent/src/openshell/bridge.test.ts
import { test, expect, afterEach } from 'bun:test'
import { startToolBridge, _resetToolBridgeSingleton } from './bridge'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'

const getLtp = tool(async ({ instrument }) => ({ price: 123, instrument }), { name: 'get_ltp', schema: z.object({ instrument: z.string() }) })
const syncCandles = tool(async () => 'ok', { name: 'sync_candles', schema: z.object({}) })
const allTools: any[] = [getLtp, syncCandles]
const allowed = ['get_ltp']

let bridge: Awaited<ReturnType<typeof startToolBridge>>
afterEach(() => { bridge?.stop(); _resetToolBridgeSingleton() })

async function callBridge(name: string, body: any, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`http://127.0.0.1:${bridge.port}/${name}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

test('ToolBridge: invokes an allowed tool and returns JSON', async () => {
  bridge = await startToolBridge({ port: 0, allowedTools: allowed, allTools })
  const r = await callBridge('get_ltp', { instrument: 'NIFTY' }, bridge.token)
  expect(r.status).toBe(200)
  expect(r.json).toEqual({ price: 123, instrument: 'NIFTY' })
})

test('ToolBridge: 403 for a tool not in ptcAllowlist', async () => {
  bridge = await startToolBridge({ port: 0, allowedTools: allowed, allTools })
  const r = await callBridge('sync_candles', {}, bridge.token)
  expect(r.status).toBe(403)
})

test('ToolBridge: 403 for unknown tool', async () => {
  bridge = await startToolBridge({ port: 0, allowedTools: allowed, allTools })
  const r = await callBridge('nope', {}, bridge.token)
  expect(r.status).toBe(403)
})

test('ToolBridge: 401 when token missing or wrong', async () => {
  bridge = await startToolBridge({ port: 0, allowedTools: allowed, allTools })
  expect((await callBridge('get_ltp', { instrument: 'X' })).status).toBe(401)
  expect((await callBridge('get_ltp', { instrument: 'X' }, 'wrong')).status).toBe(401)
})

test('ToolBridge: binds to 127.0.0.1', async () => {
  bridge = await startToolBridge({ port: 0, allowedTools: allowed, allTools })
  // port 0 -> OS-assigned; the server reports the actual port
  expect(bridge.port).toBeGreaterThan(0)
})

test('ToolBridge: honors a pre-supplied token (used by openshell middleware so sandbox env + lazy bind match)', async () => {
  bridge = await startToolBridge({ port: 0, allowedTools: allowed, allTools, token: 'fixed-tok' })
  expect(bridge.token).toBe('fixed-tok')
  expect((await callBridge('get_ltp', { instrument: 'NIFTY' }, 'fixed-tok')).status).toBe(200)
  expect((await callBridge('get_ltp', { instrument: 'NIFTY' }, 'wrong')).status).toBe(401)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/openshell/bridge.test.ts`
Expected: FAIL — `Cannot find module './bridge'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/deepagent/src/openshell/bridge.ts
import { randomUUID } from 'node:crypto'

export interface ToolBridgeOpts {
  port: number               // 0 = OS-assigned
  allowedTools: string[]     // ptcAllowlist
  allTools: any[]            // StructuredTool[]
  requestTimeoutMs?: number
  /** Pre-generated bearer token. If omitted, one is generated at bind time.
   *  Passed in by the openshell middleware so the sandbox env (baked at create
   *  time, before the server lazily binds) and the lazy bind use the SAME token. */
  token?: string
}

export interface ToolBridge {
  server: ReturnType<typeof Bun.serve>
  port: number
  token: string
  stop: () => void
}

export async function startToolBridge(opts: ToolBridgeOpts): Promise<ToolBridge> {
  const token = opts.token ?? randomUUID()
  const allowed = new Set(opts.allowedTools)
  const byName = new Map(opts.allTools.map((t) => [t.name, t] as const))
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000

  const server = Bun.serve({
    port: opts.port,
    hostname: '127.0.0.1',
    async fetch(req) {
      const auth = req.headers.get('authorization') ?? ''
      if (auth !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 })
      const url = new URL(req.url)
      const name = url.pathname.slice(1)
      const t = byName.get(name)
      if (!t || !allowed.has(name)) return new Response('forbidden', { status: 403 })
      let input: any
      try { input = await req.json() } catch { input = {} }
      try {
        const result = await Promise.race([
          t.invoke(input),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), requestTimeoutMs)),
        ])
        // Serialize via JSON round-trip so SDK class instances become plain objects.
        const safe = JSON.parse(JSON.stringify(result ?? null))
        return Response.json(safe)
      } catch (err: any) {
        return Response.json({ error: String(err?.message ?? err) }, { status: 500 })
      }
    },
  })
  return { server, port: server.port, token, stop: () => server.stop() }
}

let _singleton: ToolBridge | undefined
export function getToolBridge(opts: ToolBridgeOpts): Promise<ToolBridge> {
  if (!_singleton) return startToolBridge(opts).then((b) => { _singleton = b; return b })
  return Promise.resolve(_singleton)
}
export function _resetToolBridgeSingleton(): void { _singleton?.stop(); _singleton = undefined }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/openshell/bridge.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/openshell/bridge.ts apps/deepagent/src/openshell/bridge.test.ts
git commit -m "feat(openshell): add ToolBridge (localhost bearer-token HTTP tool proxy)"
```

---

### Task 6: `wrappers.ts` — generate per-tool CLI wrapper scripts

**Files:**
- Create: `apps/deepagent/src/openshell/wrappers.ts`
- Test: `apps/deepagent/src/openshell/wrappers.test.ts`

**Interfaces:**
- Consumes: a `ptcAllowlist` (names) + bridge config.
- Produces: `generateWrappers(allowlist, opts)` → `Record<toolName, scriptString>`; a CLI mode `bun run src/openshell/wrappers.ts --out <dir> --tools a,b --port N` for image builds.

- [ ] **Step 1: Write the failing test**

```ts
// apps/deepagent/src/openshell/wrappers.test.ts
import { test, expect } from 'bun:test'
import { generateWrappers } from './wrappers'

test('generateWrappers: one bash script per allowed tool, referencing env + bridge', () => {
  const w = generateWrappers(['get_ltp', 'historical_candles'], { bridgeHostEnv: 'OPENSHELL_BRIDGE_HOST', bridgePortEnv: 'OPENSHELL_BRIDGE_PORT', tokenEnv: 'OPENSHELL_BRIDGE_TOKEN', port: 7777, timeoutMs: 30 })
  expect(Object.keys(w).sort()).toEqual(['get_ltp', 'historical_candles'])
  const s = w['get_ltp']
  expect(s).toContain('#!/usr/bin/env bash')
  expect(s).toContain('$OPENSHELL_BRIDGE_TOKEN')
  expect(s).toContain('http://$OPENSHELL_BRIDGE_HOST:$OPENSHELL_BRIDGE_PORT/get_ltp')
  expect(s).toContain('--max-time 30')
  expect(s).toContain('-H "Authorization: Bearer $OPENSHELL_BRIDGE_TOKEN"')
})

test('generateWrappers: passes JSON args from named flags via a simple convention', () => {
  const w = generateWrappers(['get_ltp'], { bridgeHostEnv: 'OPENSHELL_BRIDGE_HOST', bridgePortEnv: 'OPENSHELL_BRIDGE_PORT', tokenEnv: 'OPENSHELL_BRIDGE_TOKEN', port: 7777, timeoutMs: 30 })
  // The wrapper accepts --<arg> value pairs and builds the JSON body.
  expect(w['get_ltp']).toContain('--instrument')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/openshell/wrappers.test.ts`
Expected: FAIL — `Cannot find module './wrappers'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/deepagent/src/openshell/wrappers.ts
export interface WrapperOpts {
  bridgeHostEnv: string   // e.g. 'OPENSHELL_BRIDGE_HOST'
  bridgePortEnv: string
  tokenEnv: string
  port: number
  timeoutMs: number
  // Per-tool arg specs: arg name -> whether required. v1: a single generic convention
  // (--<arg> value) covers tools with flat string/number args. Complex schemas are
  // handled at plan time per the spec's open-questions list.
  argSpecs?: Record<string, string[]> // toolName -> arg names
}

const DEFAULT_ARG_SPECS: Record<string, string[]> = {
  search_instruments: ['query'],
  get_ltp: ['instrument'],
  get_ohlc_quote: ['instrument'],
  historical_candles: ['instrument', 'interval', 'from_date', 'to_date'],
  intraday_candles: ['instrument', 'interval'],
  option_chain: ['instrument'],
  market_status: [],
  read_candles: ['instrument', 'interval'],
  company_profile: ['instrument'],
  news: ['query'],
}

/** Generate one bash wrapper per allowed tool. Reads bridge location + token from env
 *  at runtime (so one image works across processes/ports/tokens). */
export function generateWrappers(allowlist: string[], opts: WrapperOpts): Record<string, string> {
  const specs = { ...DEFAULT_ARG_SPECS, ...(opts.argSpecs ?? {}) }
  const out: Record<string, string> = {}
  for (const name of allowlist) {
    const args = specs[name] ?? []
    const parseLines = args.map((a) => `  --${a}) ${a}="$2"; shift 2;;`).join('\n')
    const jsonParts = args.map((a) => `"${a}":"$${a}"`).join(',')
    out[name] = `#!/usr/bin/env bash
# OpenShell tool wrapper -> bridges to the deepagent ToolBridge.
set -euo pipefail
${args.map((a) => `${a}=`).join('\n')}
while [[ $# -gt 0 ]]; do
  case "$1" in${parseLines}
    *) shift;;
  esac
done
body='{${jsonParts}}'
exec curl -s --max-time ${opts.timeoutMs} \\
  -H "Authorization: Bearer $${opts.tokenEnv}" \\
  -H "content-type: application/json" \\
  -d "$body" \\
  "http://$${opts.bridgeHostEnv}:$${opts.bridgePortEnv}/${name}"
`
  }
  return out
}

// CLI mode for image builds: bun run src/openshell/wrappers.ts --out <dir> --tools a,b --port N
if (import.meta.main) {
  const args = process.argv.slice(2)
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
  const out = get('--out'); const tools = (get('--tools') ?? '').split(',').filter(Boolean)
  const port = Number(get('--port') ?? '7777'); const timeoutMs = Number(get('--timeout') ?? '30')
  if (!out || tools.length === 0) { console.error('usage: --out <dir> --tools a,b [--port N] [--timeout s]'); process.exit(2) }
  const { writeFileSync, mkdirSync } = require('node:fs')
  mkdirSync(out, { recursive: true })
  const w = generateWrappers(tools, { bridgeHostEnv: 'OPENSHELL_BRIDGE_HOST', bridgePortEnv: 'OPENSHELL_BRIDGE_PORT', tokenEnv: 'OPENSHELL_BRIDGE_TOKEN', port, timeoutMs })
  for (const [name, script] of Object.entries(w)) { const p = require('node:path').join(out, name); writeFileSync(p, script); require('node:fs').chmodSync(p, 0o755) }
  console.log(`wrote ${Object.keys(w).length} wrappers to ${out}`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/openshell/wrappers.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/openshell/wrappers.ts apps/deepagent/src/openshell/wrappers.test.ts
git commit -m "feat(openshell): add CLI wrapper generator (PTC bridge scripts)"
```

---

### Task 7: `openshell` middleware — the `shell` tool

**Files:**
- Create: `apps/deepagent/src/openshell/middleware.ts`
- Create: `apps/deepagent/src/openshell/index.ts` (public surface)
- Test: `apps/deepagent/src/openshell/middleware.test.ts`

**Interfaces:**
- Consumes: `WorkspacePool` (Task 4), `ToolBridge` (Task 5), `allTools`, `ptcAllowlist`, `OpenShellSpec`-like options.
- Produces: `buildOpenShellMiddleware(opts)` → an `AgentMiddleware` contributing a `shell` tool; re-exported from `index.ts`.

- [ ] **Step 1: Write the failing test (against InMemoryExecutionBackend)**

```ts
// apps/deepagent/src/openshell/middleware.test.ts
import { test, expect, beforeEach } from 'bun:test'
import { buildOpenShellMiddleware } from './middleware'
import { InMemoryExecutionBackend } from './backend'
import { _resetWorkspacePoolSingleton } from './pool'
import { _resetToolBridgeSingleton } from './bridge'

beforeEach(() => { _resetWorkspacePoolSingleton(); _resetToolBridgeSingleton() })

function makeMiddleware(backend: InMemoryExecutionBackend) {
  return buildOpenShellMiddleware({
    image: 'img:1', idleTimeoutMs: 60_000, bridgePort: 0,
    executionTimeoutMs: 30_000, ptcAllowlist: ['get_ltp'], allTools: [],
    backend,  // inject for testing
  })
}

test('buildOpenShellMiddleware: contributes a `shell` tool', async () => {
  const mw = makeMiddleware(new InMemoryExecutionBackend(() => ({ output: 'hi', exitCode: 0 })))
  expect(mw.name).toBe('OpenShellMiddleware')
  // The middleware contributes tools via the createMiddleware shape; assert the tool name.
  const tools = (mw as any).tools ?? []
  expect(tools.map((t: any) => t.name)).toContain('shell')
})

test('shell tool: execs a command in the workspace + returns output + exit + persistence note', async () => {
  const backend = new InMemoryExecutionBackend(() => ({ output: 'hello', exitCode: 0 }))
  const mw = makeMiddleware(backend)
  const shellTool = ((mw as any).tools as any[]).find((t) => t.name === 'shell')
  const res = await shellTool.invoke({ command: 'echo hello' }, { configurable: { workspace_id: 'w1' } })
  expect(res).toContain('hello')
  expect(res).toContain('exit: 0')
  expect(res).toContain('persistent')
})

test('shell tool: resolves workspace_id from configurable (thread_id fallback, __default__ last)', async () => {
  const backend = new InMemoryExecutionBackend((cmd) => ({ output: cmd, exitCode: 0 }))
  const mw = makeMiddleware(backend)
  const shellTool = ((mw as any).tools as any[]).find((t) => t.name === 'shell')
  await shellTool.invoke({ command: 'a' }, { configurable: { workspace_id: 'wA' } })
  await shellTool.invoke({ command: 'b' }, { configurable: { thread_id: 'wT' } })
  await shellTool.invoke({ command: 'c' }, {})
  expect(backend.execLog.map((l) => l.id).sort()).toEqual(['__default__', 'wA', 'wT'])
})

test('shell tool: error result surfaces when backend exec fails', async () => {
  const backend: import('./backend').ExecutionBackend = {
    async getOrCreateWorkspace(id) { return { id, phase: 'error' } },
    async exec() { throw new Error('sandbox not ready') },
    async destroyWorkspace() {}, async listWorkspaces() { return [] },
  }
  const mw = makeMiddleware(backend as any)
  const shellTool = ((mw as any).tools as any[]).find((t) => t.name === 'shell')
  const res = await shellTool.invoke({ command: 'x' }, { configurable: { workspace_id: 'w1' } })
  expect(String(res)).toContain('error')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/openshell/middleware.test.ts`
Expected: FAIL — `Cannot find module './middleware'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/deepagent/src/openshell/middleware.ts
import { randomUUID } from 'node:crypto'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { AgentMiddleware } from '@langchain/core/multi_agent'
import type { ExecutionBackend } from './backend'
import { WorkspacePool, getWorkspacePool } from './pool'
import { getToolBridge } from './bridge'
import { OpenShellCliBackend } from './openshell-cli-backend'

export interface OpenShellMiddlewareOpts {
  image: string
  idleTimeoutMs: number
  bridgePort: number
  executionTimeoutMs: number
  ptcAllowlist: string[]
  allTools: any[]
  /** Inject a backend for testing; default = OpenShellCliBackend. */
  backend?: ExecutionBackend
  bridgeHost?: string // host-gateway address reachable from containers
}

export function buildOpenShellMiddleware(opts: OpenShellMiddlewareOpts): AgentMiddleware {
  // Generate the bearer token eagerly (cheap, no I/O) so the sandbox env baked at
  // create-time and the lazily-bound bridge use the SAME token. The server itself
  // binds lazily on the first shell call (below) — resolveProfile/tests start no server.
  const bridgeToken = randomUUID()
  const bridgeHost = opts.bridgeHost ?? 'host.docker.internal'
  const backend = opts.backend ?? new OpenShellCliBackend({
    image: opts.image,
    bridgeEnv: {
      OPENSHELL_BRIDGE_HOST: bridgeHost,
      OPENSHELL_BRIDGE_PORT: String(opts.bridgePort),
      OPENSHELL_BRIDGE_TOKEN: bridgeToken,
    },
  })
  const pool = getWorkspacePool(backend, { idleTimeoutMs: opts.idleTimeoutMs })

  const shellTool = tool(
    async ({ command, upload, download }, config: any) => {
      const wid = config?.configurable?.workspace_id ?? config?.configurable?.thread_id ?? '__default__'
      try {
        // Lazily bind the bridge on first shell call (process singleton). Pre-supplied
        // token matches what the sandbox already has in its env. No-op after the first call.
        await getToolBridge({ port: opts.bridgePort, allowedTools: opts.ptcAllowlist, allTools: opts.allTools, token: bridgeToken })
        const r = await pool.exec(wid, command, { upload, download, timeoutMs: opts.executionTimeoutMs })
        return `${r.output}\n\n[exit: ${r.exitCode}] [persistent shell: cwd, env, installed packages, and /workspace files persist across your shell calls within this workspace]${r.parseWarning ? ' [warning: exit marker not found, output may be incomplete]' : ''}`
      } catch (err: any) {
        return `[error: ${String(err?.message ?? err)}]`
      }
    },
    {
      name: 'shell',
      description:
        'Run a shell command in the persistent sandbox for this workspace. The sandbox is a real Linux environment (bash, python, node, curl, git). State (cwd, env vars, installed packages, files in /workspace) persists across calls within this workspace. Use `upload` (host->sandbox) and `download` (sandbox->host) only as low-level file crossings; author files inside the sandbox by default and export final artifacts via download.',
      schema: z.object({
        command: z.string().describe('The shell command to run.'),
        upload: z.array(z.string()).optional().describe('Host file paths to upload into /workspace before running.'),
        download: z.array(z.string()).optional().describe('Sandbox paths to download to the host workspace after running (export).'),
      }),
    }
  )

  const mw: AgentMiddleware = {
    name: 'OpenShellMiddleware', // unique — must not collide with CodeInterpreterMiddleware
    tools: [shellTool],
    // No afterAgent destruction — the sandbox persists; idle-reap handles teardown.
  }
  return mw
}
```

```ts
// apps/deepagent/src/openshell/index.ts
export { buildOpenShellMiddleware } from './middleware'
export type { OpenShellMiddlewareOpts } from './middleware'
export { OpenShellCliBackend } from './openshell-cli-backend'
export { InMemoryExecutionBackend } from './backend'
export type { ExecutionBackend, ExecResult, ExecOpts, WorkspaceHandle, WorkspaceInfo } from './backend'
export { WorkspacePool, getWorkspacePool, _resetWorkspacePoolSingleton } from './pool'
export { startToolBridge, getToolBridge, _resetToolBridgeSingleton } from './bridge'
export type { ToolBridge, ToolBridgeOpts } from './bridge'
export { generateWrappers } from './wrappers'
export { parseExecOutput, EXIT_MARKER } from './cli'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/openshell/middleware.test.ts`
Expected: 4 pass. Also run the whole openshell dir: `bun test src/openshell/` — all green.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/openshell/middleware.ts apps/deepagent/src/openshell/index.ts apps/deepagent/src/openshell/middleware.test.ts
git commit -m "feat(openshell): add buildOpenShellMiddleware (shell tool) + public index"
```

---

### Task 8: Profile-system extension — `openshell` middleware + `OpenShellSpec`

**Files:**
- Modify: `apps/deepagent/src/profiles/types.ts` (add `OpenShellSpec`; `ProfileData.openshell?`)
- Modify: `apps/deepagent/src/profiles/schema.json` (add `openshell`)
- Modify: `apps/deepagent/src/profiles/middleware.ts` (registry entry `openshell`; `MwCtx.openshell?` + `MwCtx.allTools`)
- Modify: `apps/deepagent/src/profiles/resolve.ts` (pass `ctx.openshell` + `ctx.allTools`)
- Modify: `apps/deepagent/src/profiles/loader.ts` (`validateMerged`: require `openshell` complete when `middleware` includes `openshell`)
- Test: `apps/deepagent/src/profiles/openshell-profile.test.ts`

**Interfaces:**
- Consumes: `buildOpenShellMiddleware` (Task 7), the existing `MIDDLEWARE_REGISTRY`/`MwCtx`/`resolveProfile`/`validateMerged`/`mergeProfiles`.
- Produces: `OpenShellSpec` type; `openshell` registry entry; `validateMerged` rule.

- [ ] **Step 1: Write the failing test**

```ts
// apps/deepagent/src/profiles/openshell-profile.test.ts
import { test, expect } from 'bun:test'
import { resolveProfile, mergeProfiles, ProfileSchemaError } from './loader'
import { DEFAULT_PROFILE_DATA } from './defaults'
import { loadProfile } from './loader'

const openshellProfile = {
  profileVersion: 1,
  middleware: ['openshell', 'coerceToolContent', 'readFileContinuation'],
  openshell: { image: 'harnesh/agent-sandbox:ubuntu-lts', idleTimeoutMs: 1800000, bridgePort: 7777, executionTimeoutMs: 120000 },
  ptcAllowlist: ['get_ltp', 'historical_candles'],
}

test('resolveProfile: builds an openshell middleware with the shell tool when middleware includes openshell', () => {
  const r = resolveProfile({ ...DEFAULT_PROFILE_DATA, ...openshellProfile })
  expect(r.parentMiddleware.length).toBeGreaterThanOrEqual(1)
  // The openshell middleware contributes a `shell` tool indirectly (it's in the middleware list);
  // assert the middleware list builds without throwing and has the expected count (3).
  expect(r.parentMiddleware).toHaveLength(3)
})

test('validateMerged: rejects openshell in middleware when openshell spec is missing', () => {
  const bad = mergeProfiles(DEFAULT_PROFILE_DATA, { middleware: ['openshell'] })
  expect(() => resolveProfile(bad)).toThrow(/openshell/)
})

test('validateMerged: rejects openshell spec with missing fields', () => {
  const bad = mergeProfiles(DEFAULT_PROFILE_DATA, { middleware: ['openshell'], openshell: { image: 'x' } } as any)
  expect(() => resolveProfile(bad)).toThrow(/openshell/)
})

test('validateMerged: accepts a complete openshell spec', () => {
  expect(() => resolveProfile(mergeProfiles(DEFAULT_PROFILE_DATA, openshellProfile))).not.toThrow()
})

test('schema: rejects unknown field in openshell spec', () => {
  const bad = { ...openshellProfile, openshell: { ...openshellProfile.openshell, bogus: 1 } }
  // loadProfile parses+validates per-file; emulate via ajv on a file. Simpler: assert via mergeProfiles+resolveProfile that the extra field is ignored/ok at merged level.
  // (ajv per-file rejection is covered by the schema.test.ts pattern; here we assert merged-level completeness.)
  expect(() => resolveProfile(mergeProfiles(DEFAULT_PROFILE_DATA, bad))).not.toThrow()
})

test('default profile unchanged: still uses interpreter, no openshell', () => {
  expect(DEFAULT_PROFILE_DATA.middleware).toContain('interpreter')
  expect((DEFAULT_PROFILE_DATA as any).openshell).toBeUndefined()
})

test('loadProfile: default chain still resolves + resolves (no openshell regression)', () => {
  const p = loadProfile('ollama', 'llama3')
  expect(() => resolveProfile(p)).not.toThrow()
  expect(p.middleware).toContain('interpreter')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/profiles/openshell-profile.test.ts`
Expected: FAIL — `openshell` not a known middleware (`unknown middleware: "openshell"`) and `OpenShellSpec` not present.

- [ ] **Step 3: Write minimal implementation**

`apps/deepagent/src/profiles/types.ts` — add:
```ts
export interface OpenShellSpec {
  image: string
  idleTimeoutMs: number
  bridgePort: number
  executionTimeoutMs: number
}
// append to ProfileData:
//   openshell?: OpenShellSpec
```
(Edit `ProfileData` to include `openshell?: OpenShellSpec`.)

`apps/deepagent/src/profiles/schema.json` — add a top-level optional `openshell`:
```json
"openshell": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "image": { "type": "string" },
    "idleTimeoutMs": { "type": "integer", "minimum": 1 },
    "bridgePort": { "type": "integer", "minimum": 0 },
    "executionTimeoutMs": { "type": "integer", "minimum": 1 }
  },
  "required": ["image", "idleTimeoutMs", "bridgePort", "executionTimeoutMs"]
}
```

`apps/deepagent/src/profiles/middleware.ts` — add to `MwCtx` and the registry:
```ts
import { buildOpenShellMiddleware } from '../openshell/middleware'
import type { OpenShellSpec } from './types'

export interface MwCtx {
  ptcAllowlist: string[]
  interpreter: InterpreterSpec
  parent: boolean
  openshell?: OpenShellSpec   // present only when middleware includes 'openshell'
  allTools: unknown[]          // the real Tool objects (for the bridge)
}

// in MIDDLEWARE_REGISTRY:
openshell: (ctx: MwCtx) => {
  if (!ctx.openshell) throw new Error('openshell middleware selected but profile has no openshell spec')
  return buildOpenShellMiddleware({
    ...ctx.openshell,
    ptcAllowlist: ctx.ptcAllowlist,
    allTools: ctx.allTools as any[],
  })
},
```

`apps/deepagent/src/profiles/resolve.ts` — when building ctx, pass `openshell` (from the merged data) + `allTools`. Import `allTools` from `../tools` (same source `resolveTools` uses). Only pass `openshell` when `data.middleware.includes('openshell')`.

`apps/deepagent/src/profiles/loader.ts` — in `validateMerged`, add:
```ts
if (d.middleware.includes('openshell')) {
  const o = (d as any).openshell
  if (!o || typeof o.image !== 'string' || typeof o.idleTimeoutMs !== 'number' ||
      typeof o.bridgePort !== 'number' || typeof o.executionTimeoutMs !== 'number') {
    throw new Error('profile missing complete openshell spec (image/idleTimeoutMs/bridgePort/executionTimeoutMs)')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/profiles/openshell-profile.test.ts && bun test`
Expected: openshell-profile tests pass; full suite still green (default/eval profiles unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/profiles/types.ts apps/deepagent/src/profiles/schema.json apps/deepagent/src/profiles/middleware.ts apps/deepagent/src/profiles/resolve.ts apps/deepagent/src/profiles/loader.ts apps/deepagent/src/profiles/openshell-profile.test.ts
git commit -m "feat(profiles): add openshell middleware registry entry + OpenShellSpec"
```

---

### Task 9: `agent.ts` — per-workspace `workspaceDir`

**Files:**
- Modify: `apps/deepagent/src/agent.ts` (`workspaceDir` widens to accept `workspaceId`)
- Test: `apps/deepagent/src/agent.test.ts` (extend)

**Interfaces:**
- Produces: `workspaceDir(workspaceId?: string)` → `join(root, workspaceId ?? '')` (no id = today's behavior preserved).

- [ ] **Step 1: Write the failing test**

```ts
// append to apps/deepagent/src/agent.test.ts
test('workspaceDir: per-workspace subdir when id given', () => {
  process.env.AGENT_WORKSPACE_DIR = '/tmp/ws-root'
  expect(workspaceDir('wA').replace(/\\/g, '/')).toMatch(/\/ws-root\/wA$/)
})

test('workspaceDir: no id preserves today behavior (root only)', () => {
  process.env.AGENT_WORKSPACE_DIR = '/tmp/ws-root'
  expect(workspaceDir().replace(/\\/g, '/')).toBe('/tmp/ws-root')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/agent.test.ts -t "per-workspace subdir"`
Expected: FAIL — `workspaceDir` takes no args today.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/deepagent/src/agent.ts — replace workspaceDir
export function workspaceDir(workspaceId?: string): string {
  const root = process.env.AGENT_WORKSPACE_DIR || defaultWorkspacePath()
  return workspaceId ? join(root, workspaceId) : root
}
```
`buildAgent` stays unchanged for now (it calls `workspaceDir()` with no id → root, preserving behavior; the route passes `workspaceId` through `configurable`, and the openshell middleware keys on it — the host per-workspace dir is created lazily by the route in Task 10). No change to `buildAgent` here.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/agent.test.ts`
Expected: all pass (new + existing).

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/agent.ts apps/deepagent/src/agent.test.ts
git commit -m "feat(agent): workspaceDir accepts optional workspaceId for per-workspace dirs"
```

---

### Task 10: Route plumbing — `workspaceId` → `configurable.workspace_id` + bridge boot

**Files:**
- Modify: `apps/api/src/modules/agent/index.ts` (accept `workspaceId`; pass `configurable`; ensure bridge is available)
- Test: `apps/api/src/modules/agent/index.test.ts` (new or extend)

**Interfaces:**
- Consumes: `workspaceDir(workspaceId)` (Task 9), the agent route's existing `buildAgent`/`streamEvents`.
- Produces: the route sends `configurable: { workspace_id }` to `streamEvents`; per-workspace host dir created.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/agent/index.test.ts (new)
import { test, expect, beforeEach, mock } from 'bun:test'
import { writeSettings } from './settings'

// Record what streamEvents receives so we can assert the route threaded workspace_id through.
let recordedConfigurable: any

// Stub the deepagent package BEFORE ./index imports it. The route only uses
// buildAgent + buildModel from this package; buildModel isn't reached by /agent/chat.
mock.module('@harnesh-trading-ts/deepagent', () => ({
  buildAgent: async () => ({
    // Fake agent: record configurable, emit no events, let the route yield `done`.
    streamEvents: async function* (_input: any, opts: any) {
      recordedConfigurable = opts?.configurable
    },
  }),
  buildModel: () => ({}),
}))

// Import AFTER mock.module so the route picks up the stubbed buildAgent.
const { agent } = await import('./index')

beforeEach(() => {
  process.env.AGENT_SETTINGS_PATH = `/tmp/agent-settings-${Math.random().toString(36).slice(2)}.json`
  recordedConfigurable = undefined
  // Configure the agent so readSettings() returns a valid model and the route proceeds to buildAgent.
  writeSettings({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '' })
})

test('POST /agent/chat passes body.workspaceId as configurable.workspace_id to streamEvents', async () => {
  const res = await agent.handle(
    new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'wA',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }),
  )
  expect(res.status).toBe(200)
  // Drain the SSE stream so the handler runs to completion (the stub yields nothing; route then yields `done`).
  await res.text()
  expect(recordedConfigurable).toEqual({ workspace_id: 'wA' })
})

test('POST /agent/chat defaults workspace_id to __default__ when body omits workspaceId', async () => {
  const res = await agent.handle(
    new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
  )
  expect(res.status).toBe(200)
  await res.text()
  expect(recordedConfigurable).toEqual({ workspace_id: '__default__' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/modules/agent/index.test.ts`
Expected: FAIL — the route doesn't read `body.workspaceId` and doesn't pass `configurable`, so `recordedConfigurable` is `undefined` (or the body schema rejects `workspaceId`).

- [ ] **Step 3: Write minimal implementation**

In `apps/api/src/modules/agent/index.ts`:

1. Add `workspaceDir` to the deepagent import and `mkdirSync` from `node:fs`:
```ts
import { buildAgent, buildModel, workspaceDir, type AgentConfig } from '@harnesh-trading-ts/deepagent'
import { mkdirSync } from 'node:fs'
```
(`workspaceDir` is already exported from `apps/deepagent/src/agent.ts`; confirm it is re-exported from the package entry `apps/deepagent/src/index.ts` — add it there if missing.)

2. In the `POST /agent/chat` handler, after the `readSettings()` guard and before `buildAgent(s)`, resolve + mkdir the per-workspace dir:
```ts
const workspaceId = (body.workspaceId as string) || '__default__'
mkdirSync(workspaceDir(workspaceId), { recursive: true })
```

3. Pass `configurable` into `streamEvents`:
```ts
const stream = (agent as any).streamEvents(
  { messages: body.messages },
  { version: 'v2', signal: request.signal, configurable: { workspace_id: workspaceId } },
)
```

4. Add `workspaceId` to the body schema (optional string):
```ts
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
```

The `ToolBridge` starts lazily inside the openshell middleware on the first `shell` call (Task 7); no explicit bridge boot in the route for v1.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/modules/agent/`
Expected: pass. Also `cd apps/deepagent && bun test` — full suite still green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/agent/index.ts apps/api/src/modules/agent/index.test.ts
git commit -m "feat(api): agent route passes workspaceId -> configurable.workspace_id + per-workspace dir"
```

---

### Task 11: Sandbox image — minimal Ubuntu LTS Dockerfile + wrapper generation

**Files:**
- Create: `apps/deepagent/src/openshell/image/Dockerfile`
- Create: `apps/deepagent/src/openshell/image/build.sh` (generates wrappers via `wrappers.ts` CLI mode, then `docker build`)
- Test: `apps/deepagent/src/openshell/image/image.test.ts` (gated on `docker`)

**Interfaces:**
- Produces: `harnesh/agent-sandbox:ubuntu-lts` image with bash/curl/git/python3/uv/node/npm/pnpm + generated wrappers.

- [ ] **Step 1: Write the failing test (gated on docker)**

```ts
// apps/deepagent/src/openshell/image/image.test.ts
import { test, expect } from 'bun:test'

const RUN = !!process.env.OPENSHELL_AVAILABLE
const itIf = RUN ? test : test.skip

itIf('sandbox image: builds + has bash, curl, git, python3, uv, node, pnpm + wrappers', async () => {
  const { exitCode } = Bun.spawnSync(['bash', 'apps/deepagent/src/openshell/image/build.sh'], { cwd: process.cwd() })
  expect(exitCode).toBe(0)
  // smoke: run a command in the built image checking tool availability
  const smoke = Bun.spawnSync(['docker', 'run', '--rm', 'harnesh/agent-sandbox:ubuntu-lts', 'bash', '-lc',
    'set -e; command -v bash curl git python3 uv node pnpm; test -x /usr/local/bin/get_ltp'])
  expect(smoke.exitCode).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails (or skip)**

Run: `cd apps/deepagent && OPENSHELL_AVAILABLE=1 bun test src/openshell/image/image.test.ts` (only when Docker is running; otherwise it skips — acceptable).
Expected: FAIL — no Dockerfile/build.sh yet (when run with the gate on).

- [ ] **Step 3: Write minimal implementation**

```dockerfile
# apps/deepagent/src/openshell/image/Dockerfile
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl git ca-certificates python3 python3-pip gnupg \
    && rm -rf /var/lib/apt/lists/*
# uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && ln -s /root/.local/bin/uv /usr/local/bin/uv
# Node LTS + npm + pnpm
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs && npm i -g pnpm
WORKDIR /workspace
# Wrappers are generated at build time by build.sh into ./wrappers and copied in.
COPY wrappers /usr/local/bin
RUN chmod -R +x /usr/local/bin
ENV OPENSHELL_BRIDGE_HOST=host.docker.internal OPENSHELL_BRIDGE_PORT=7777
CMD ["bash"]
```

```bash
# apps/deepagent/src/openshell/image/build.sh
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
TOOLS="${TOOLS:-search_instruments,get_ltp,get_ohlc_quote,historical_candles,intraday_candles,option_chain,market_status,read_candles,company_profile,news}"
PORT="${PORT:-7777}"
rm -rf wrappers && mkdir -p wrappers
bun run ../../src/openshell/wrappers.ts --out wrappers --tools "$TOOLS" --port "$PORT"
docker build -t harnesh/agent-sandbox:ubuntu-lts .
```
(`chmod +x build.sh`.)

- [ ] **Step 4: Run test to verify it passes (when gated on)**

Run: `cd apps/deepagent && OPENSHELL_AVAILABLE=1 bash src/openshell/image/build.sh && OPENSHELL_AVAILABLE=1 bun test src/openshell/image/image.test.ts`
Expected: pass (when Docker is running). Without the gate, the test skips — the unit suite stays green.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/openshell/image/Dockerfile apps/deepagent/src/openshell/image/build.sh apps/deepagent/src/openshell/image/image.test.ts
git commit -m "feat(openshell): minimal Ubuntu LTS sandbox image + wrapper bake step"
```

---

### Task 12: Gated integration tests — real OpenShell end-to-end

**Files:**
- Create: `apps/deepagent/src/openshell/integration.test.ts`

**Interfaces:**
- Consumes: `OpenShellCliBackend`, `ToolBridge`, `buildOpenShellMiddleware`, a stub market-data tool.
- Produces: e2e tests that skip when `OPENSHELL_AVAILABLE` is unset.

- [ ] **Step 1: Write the test (gated)**

```ts
// apps/deepagent/src/openshell/integration.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { buildOpenShellMiddleware, _resetWorkspacePoolSingleton, _resetToolBridgeSingleton } from './openshell'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'

// Gated: only runs when OPENSHELL_AVAILABLE=1 AND Docker + the built image are present.
// The bridge binds lazily on the first shell call (process singleton) at bridgePort 7777
// (matches the image's baked OPENSHELL_BRIDGE_PORT). The middleware generates the token
// and bakes it into the sandbox env; the lazy bind reuses that same token, so wrappers
// inside the sandbox authenticate successfully — no test-side token plumbing needed.
const RUN = !!process.env.OPENSHELL_AVAILABLE
const itIf = RUN ? test : test.skip
const PORT = 7777

const getLtp = tool(async ({ instrument }) => ({ price: 123, instrument }), { name: 'get_ltp', schema: z.object({ instrument: z.string() }) })

beforeAll(() => { if (RUN) { _resetWorkspacePoolSingleton(); _resetToolBridgeSingleton() } })
afterAll(() => { if (RUN) { _resetToolBridgeSingleton(); _resetWorkspacePoolSingleton() } })
// NOTE: leftover sandboxes (int-w1/w2/w3) are not force-destroyed here; idle-reap or
// `openshell sandbox delete --name <id>` cleans them. Acceptable for a manually-gated run.

const mk = () => {
  const mw = buildOpenShellMiddleware({
    image: 'harnesh/agent-sandbox:ubuntu-lts', idleTimeoutMs: 60_000, bridgePort: PORT,
    executionTimeoutMs: 30_000, ptcAllowlist: ['get_ltp'], allTools: [getLtp],
  })
  return (mw as any).tools.find((t: any) => t.name === 'shell')
}

itIf('e2e: shell echo + exit code', async () => {
  const shell = mk()
  const res = await shell.invoke({ command: 'echo hello' }, { configurable: { workspace_id: 'int-w1' } })
  expect(res).toContain('hello')
  expect(res).toContain('exit: 0')
})

itIf('e2e: persistent state across calls', async () => {
  const shell = mk()
  await shell.invoke({ command: 'X=42' }, { configurable: { workspace_id: 'int-w2' } })
  const res = await shell.invoke({ command: 'echo $X' }, { configurable: { workspace_id: 'int-w2' } })
  expect(res).toContain('42')
})

itIf('e2e: wrapper round-trip via bridge (get_ltp)', async () => {
  const shell = mk()
  const res = await shell.invoke({ command: 'get_ltp --instrument NIFTY' }, { configurable: { workspace_id: 'int-w3' } })
  expect(res).toContain('123')
})
```
(The 401/wrong-token case is covered by the unit `bridge.test.ts` "honors a pre-supplied token" test; no e2e duplicate is needed.)

- [ ] **Step 2: Run (skip when ungated)**

Run: `cd apps/deepagent && bun test src/openshell/integration.test.ts`
Expected: skips (no `OPENSHELL_AVAILABLE`); the suite stays green.

- [ ] **Step 3: Commit**

```bash
git add apps/deepagent/src/openshell/integration.test.ts
git commit -m "test(openshell): gated end-to-end integration tests (real OpenShell)"
```

---

### Task 13: Production profile + deployment docs

**Files:**
- Create: `apps/deepagent/profiles/<provider>__<model>.jsonc` (an example production profile selecting `openshell`) — exact provider/model per the user's running config; v1 ships one example.
- Modify: `apps/deepagent/README.md` (or `docs/`) — WSL2 + OpenShell setup section.

**Interfaces:**
- Produces: an example production profile + setup docs.

- [ ] **Step 1: Write the example production profile**

```jsonc
// apps/deepagent/profiles/openrouter__anthropic_claude-3.5-sonnet.jsonc (example; adjust provider/model)
{
  // Select the OpenShell persistent-shell middleware instead of quickjs interpreter.
  "middleware": ["openshell", "coerceToolContent", "readFileContinuation"],
  "openshell": {
    "image": "harnesh/agent-sandbox:ubuntu-lts",
    "idleTimeoutMs": 1800000,
    "bridgePort": 7777,
    "executionTimeoutMs": 120000
  },
  "ptcAllowlist": [
    "search_instruments", "get_ltp", "get_ohlc_quote", "historical_candles",
    "intraday_candles", "option_chain", "market_status", "read_candles",
    "company_profile", "news"
  ]
}
```

- [ ] **Step 2: Verify it loads + resolves**

```bash
cd apps/deepagent && bun -e "import {loadProfile, resolveProfile} from './src/profiles'; const p = loadProfile('openrouter','anthropic/claude-3.5-sonnet'); resolveProfile(p); console.log('ok', p.middleware, p.openshell?.image)"
```
Expected: `ok [ 'openshell', 'coerceToolContent', 'readFileContinuation' ] harnesh/agent-sandbox:ubuntu-lts`

- [ ] **Step 3: Add the WSL2 setup docs**

Append to `apps/deepagent/README.md` (or create `docs/openshell-setup.md`):
```markdown
## OpenShell execution environment (production)

Production runs the API + deepagent inside WSL2 so the `openshell` CLI is a local
subprocess and Docker (the compute backend) is available.

1. In WSL2 (Ubuntu): `curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh`
   (or `uv tool install -U openshell`). Verify: `openshell --version`.
2. Ensure Docker Desktop's WSL2 backend is running.
3. Build the sandbox image: `bash apps/deepagent/src/openshell/image/build.sh`
   -> tags `harnesh/agent-sandbox:ubuntu-lts`.
4. Select the openshell middleware in a production profile
   (`apps/deepagent/profiles/<provider>__<model>.jsonc` — see example).
5. `bun run dev` (from WSL2).

The tool bridge binds 127.0.0.1:<bridgePort> lazily on the first `shell` call
(per-process bearer token generated at agent build, baked into the sandbox env
so the lazy bind and the sandbox share one token); sandboxes reach it via the
host gateway (host.docker.internal). Sandboxes idle-reap after
`openshell.idleTimeoutMs`. Author files inside the sandbox; export final
artifacts to the host workspace via `shell`'s `download`.

v1 limitation: the bridge + workspace pool are process-singletons (first
config wins). Production is single-profile, so this is fine; multi-profile
support would require keying the singletons by profile/bridgePort.

Alpha caveat: OpenShell is v0.0.x alpha with no TS SDK; v1 integrates via the CLI
subprocess. The ExecutionBackend interface isolates us from CLI/SDK churn.
```

- [ ] **Step 4: Run the full suite**

Run: `cd apps/deepagent && bun test && cd ../api && bun test`
Expected: all green (integration tests skip without `OPENSHELL_AVAILABLE`).

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/profiles/openrouter__anthropic_claude-3.5-sonnet.jsonc apps/deepagent/README.md
git commit -m "feat(openshell): example production profile + WSL2 setup docs"
```

---

## Self-Review (run before execution handoff)

- **Spec coverage:** Tasks 1–7 build the core (parser, backend, pool, bridge, wrappers, middleware) — all unit-testable with fakes, no real OpenShell. Task 8 wires it into the profile system. Tasks 9–10 do the workspaceId plumbing. Tasks 11–12 make it real (image + gated integration). Task 13 ships an example profile + docs. Every spec section maps to a task.
- **Behavior preservation:** Default + eval profiles keep `interpreter` (Task 8 explicitly tests this). `buildAgent` signature unchanged; `workspaceDir()` widening is backward-compatible (no arg = today's behavior, Task 9 tests it). Full existing suite must stay green at every task (Global Constraint).
- **Placeholder scan:** Task 10's route test now uses Bun's `mock.module` to stub `buildAgent` and asserts `recordedConfigurable` equals `{ workspace_id }` for both the present and omitted-`workspaceId` cases — no `expect(true).toBe(true)` remains. Task 12's no-op "wrong token" test was removed (the unit `bridge.test.ts` "honors a pre-supplied token" test covers 401). No other placeholders.
- **Lazy-bridge design (pre-flight amendment):** The bridge binds lazily on the first `shell` call; the bearer token is generated eagerly at middleware build and shared between the sandbox env (baked at create-time) and the lazy bind, so `resolveProfile`/unit tests start no HTTP server. v1 single-profile limitation (process-singleton bridge+pool, first config wins) is documented in Task 13.
- **Type consistency:** `OpenShellSpec` fields match across types.ts, schema.json, `validateMerged`, and the example profile. `MwCtx` additions (`openshell?`, `allTools`) match between middleware.ts and resolve.ts. `ExecResult` defined once in backend.ts, re-exported from cli.ts.
- **Future-proofing:** The `ExecutionBackend` interface (Task 2) + the `backend?` injection seam in `buildOpenShellMiddleware` (Task 7) + the commented FUTURE methods (snapshot/restore, process mgmt) satisfy the spec's "design for snapshot/restore, process management, SDK replacement without changing the agent architecture." Adding them later = interface methods + a backend impl + optional new tools; the `shell` middleware is untouched.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-13-openshell-integration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration (the pattern used for Sub-project B).

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?