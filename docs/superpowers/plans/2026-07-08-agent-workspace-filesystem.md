# Agent Workspace Filesystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the trading agent a sandboxed, disk-persisted virtual filesystem via deepagents' `FilesystemBackend` so its built-in `ls`/`read_file`/`write_file`/`edit_file`/`glob`/`grep` tools store files in a workspace directory, with an explicit allow-all permission rule.

**Architecture:** Add a `FilesystemBackend` (`virtualMode: true`) rooted at an env-configurable workspace dir to `createDeepAgent`, plus an explicit `FilesystemPermission[]` allow-all rule. Decompose the wiring into three small exported, unit-testable units — `workspaceDir()`, `buildBackend(root)`, `WORKSPACE_PERMISSIONS` — composed inside `buildAgent`. `buildAgent(cfg)`'s signature is unchanged, so `/agent/chat` needs no edit. The fs tools are always present on a deepagent (batteries-included); the backend only changes where they persist.

**Tech Stack:** TypeScript, Bun (`bun:test`), `deepagents@1.10.5`, `@langchain/*`. Tests run with `bun test` from `apps/deepagent`.

## Global Constraints

- Workspace default dir: `apps/api/data/agent-workspace/` (resolved relative to `apps/deepagent/src/agent.ts`, mirroring the existing `settingsPath()` pattern in the same file).
- Workspace override: `AGENT_WORKSPACE_DIR` env var (absolute path).
- Backend: `new FilesystemBackend({ rootDir, virtualMode: true })` — `virtualMode` sandboxes all paths to `rootDir`; the agent cannot reach anything outside the workspace.
- Permissions: a single explicit allow-all rule `{ operations: ['read','write'], paths: ['/**'], mode: 'allow' }`. Default is already permissive; the explicit rule documents intent and future-proofs deny rules.
- No `execute`/shell tool. No web UI changes. No changes to `/agent/chat`, the web client, `/settings`, or the 12 trading tools.
- Dependency rule: never hand-write `package.json` — use `bun add` if a dep is missing. No new deps are required here (`deepagents` already installed).
- `buildAgent(cfg: AgentConfig)` signature must remain unchanged.

---

## File Structure

- **Modify:** `apps/deepagent/src/agent.ts` — add imports (`FilesystemBackend`, `FilesystemPermission` type, `mkdirSync`), add exported `workspaceDir()`, `buildBackend(root)`, `WORKSPACE_PERMISSIONS`, update `buildAgent` to compose them, append a workspace paragraph to `SYSTEM_PROMPT`.
- **Modify:** `apps/deepagent/src/agent.test.ts` — add tests for the three new units + `buildAgent` dir creation; extend `beforeEach` to clear `AGENT_WORKSPACE_DIR`.

No new files. The deepagent package `exports` map (`apps/deepagent/package.json`) already exports `.` → `./src/agent.ts`, so the new exports are reachable by the API.

---

## Task 1: Workspace path resolver + permissions constant

**Files:**
- Modify: `apps/deepagent/src/agent.ts` (imports + new exports near `resolveAgentConfig`)
- Test: `apps/deepagent/src/agent.test.ts`

**Interfaces:**
- Produces: `workspaceDir(): string` — resolves `process.env.AGENT_WORKSPACE_DIR` or the default path. `WORKSPACE_PERMISSIONS: FilesystemPermission[]` — the allow-all rule.

- [ ] **Step 1: Write the failing tests**

Add to `apps/deepagent/src/agent.test.ts`. First extend the existing `beforeEach` (currently lines 4–9) to also clear the workspace env var:

```ts
beforeEach(() => {
  process.env.AGENT_SETTINGS_PATH = `/tmp/agent-settings-${Math.random().toString(36).slice(2)}.json`
  delete process.env.DEEPAGENT_MODEL
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.AGENT_WORKSPACE_DIR
})
```

Update the import line at the top (line 2) to also bring in the new units:

```ts
import { buildModel, resolveAgentConfig, workspaceDir, WORKSPACE_PERMISSIONS } from './agent'
```

Append two tests at the end of the file:

```ts
test('workspaceDir: honors AGENT_WORKSPACE_DIR', () => {
  process.env.AGENT_WORKSPACE_DIR = '/tmp/ws-x'
  expect(workspaceDir()).toBe('/tmp/ws-x')
})

test('workspaceDir: default ends with api/data/agent-workspace', () => {
  expect(workspaceDir().replace(/\\/g, '/')).toMatch(/\/api\/data\/agent-workspace$/)
})

test('WORKSPACE_PERMISSIONS: single allow-all rule', () => {
  expect(WORKSPACE_PERMISSIONS).toEqual([
    { operations: ['read', 'write'], paths: ['/**'], mode: 'allow' },
  ])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `apps/deepagent`:
```
bun test src/agent.test.ts
```
Expected: FAIL — `workspaceDir` and `WORKSPACE_PERMISSIONS` are not exported (import error / undefined).

- [ ] **Step 3: Implement the resolver + constant**

In `apps/deepagent/src/agent.ts`:

Add `mkdirSync` to the existing `node:fs` import (line 6):
```ts
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
```

Add a type-only import for `FilesystemPermission` right after the `deepagents` import (line 1). The `FilesystemBackend` runtime import is added in Task 2; here only the type:
```ts
import type { FilesystemPermission } from 'deepagents'
```

Add these exports just above `resolveAgentConfig` (after the `OLLAMA_DEFAULT` constant, near line 30):

```ts
/** Default workspace root: apps/api/data/agent-workspace (mirrors settingsPath()). */
function defaultWorkspacePath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../api/data/agent-workspace')
}

/** Resolve the agent workspace dir: AGENT_WORKSPACE_DIR env, else the default. */
export function workspaceDir(): string {
  return process.env.AGENT_WORKSPACE_DIR || defaultWorkspacePath()
}

/** Allow-all within the workspace. virtualMode already confines paths to rootDir;
 *  this explicit rule documents intent and makes future deny rules a one-liner. */
export const WORKSPACE_PERMISSIONS: FilesystemPermission[] = [
  { operations: ['read', 'write'], paths: ['/**'], mode: 'allow' },
]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/agent.test.ts`
Expected: PASS — all tests green (existing 5 + new 3).

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/agent.ts apps/deepagent/src/agent.test.ts
git commit -m "feat(deepagent): workspace path resolver + allow-all permissions constant"
```

---

## Task 2: `buildBackend` helper

**Files:**
- Modify: `apps/deepagent/src/agent.ts` (add `FilesystemBackend` import + `buildBackend`)
- Test: `apps/deepagent/src/agent.test.ts`

**Interfaces:**
- Produces: `buildBackend(root: string): FilesystemBackend` — returns `new FilesystemBackend({ rootDir: root, virtualMode: true })`. Later composed by `buildAgent`.

- [ ] **Step 1: Write the failing test**

In `apps/deepagent/src/agent.test.ts`, add imports at top of file:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
```

Add `buildBackend` to the agent import (line 2):
```ts
import { buildModel, resolveAgentConfig, workspaceDir, WORKSPACE_PERMISSIONS, buildBackend } from './agent'
```

Append the test:

```ts
test('buildBackend: write/read round-trips through rootDir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'da-'))
  const b = buildBackend(root)
  await b.write('notes.txt', 'hello')
  const r: any = await b.read('notes.txt')
  expect(r.content).toBe('hello')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent.test.ts`
Expected: FAIL — `buildBackend` is not exported.

- [ ] **Step 3: Implement `buildBackend`**

In `apps/deepagent/src/agent.ts`, change the `deepagents` import (line 1) to also pull in the runtime class:

```ts
import { createDeepAgent, FilesystemBackend } from 'deepagents'
```

Add the helper just below `WORKSPACE_PERMISSIONS`:

```ts
/** Build the sandboxed filesystem backend rooted at `root`. */
export function buildBackend(root: string): FilesystemBackend {
  return new FilesystemBackend({ rootDir: root, virtualMode: true })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/agent.test.ts`
Expected: PASS — round-trip test green; `r.content === 'hello'`.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/agent.ts apps/deepagent/src/agent.test.ts
git commit -m "feat(deepagent): buildBackend helper for sandboxed FilesystemBackend"
```

---

## Task 3: Wire backend + permissions into `buildAgent`; system prompt

**Files:**
- Modify: `apps/deepagent/src/agent.ts` (`buildAgent` body + `SYSTEM_PROMPT`)
- Test: `apps/deepagent/src/agent.test.ts`

**Interfaces:**
- Consumes: `workspaceDir()`, `buildBackend(root)`, `WORKSPACE_PERMISSIONS` (from Tasks 1–2).
- Produces: `buildAgent(cfg)` now constructs the agent with `backend` + `permissions` and ensures the workspace dir exists. Signature unchanged.

- [ ] **Step 1: Write the failing test**

In `apps/deepagent/src/agent.test.ts`, add `existsSync` to the `node:fs` import and `buildAgent` to the agent import:

```ts
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildModel, resolveAgentConfig, workspaceDir, WORKSPACE_PERMISSIONS, buildBackend, buildAgent } from './agent'
```

Append the test (uses an ollama config — `ChatOllama` construction is local, no network):

```ts
test('buildAgent: creates workspace dir if missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'da-')) + '/missing'
  process.env.AGENT_WORKSPACE_DIR = root
  await buildAgent({ provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama3' })
  expect(existsSync(root)).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent.test.ts`
Expected: FAIL — the `missing` subdir does not exist after `buildAgent` (current `buildAgent` never creates a dir).

- [ ] **Step 3: Wire `buildAgent` and update the system prompt**

In `apps/deepagent/src/agent.ts`, replace the body of `buildAgent` (currently lines 45–51):

```ts
export async function buildAgent(cfg: AgentConfig) {
  if (!cfg.model) {
    throw new Error('Agent config missing model')
  }
  const model = buildModel(cfg)

  const root = workspaceDir()
  mkdirSync(root, { recursive: true })

  return createDeepAgent({
    model,
    tools: allTools,
    systemPrompt: SYSTEM_PROMPT,
    backend: buildBackend(root),
    permissions: WORKSPACE_PERMISSIONS,
  })
}
```

Append a workspace paragraph to `SYSTEM_PROMPT` (after the final `Be concise. Prefer tools over guessing.` line):

```ts
You have a virtual filesystem (ls, read_file, write_file, edit_file, glob, grep) rooted at a workspace directory. Use it to persist analysis, notes, and intermediate results across the conversation. Prefer write_file for new artifacts and edit_file for small changes.
```

So the `SYSTEM_PROMPT` template literal ends with:

```
Be concise. Prefer tools over guessing.
You have a virtual filesystem (ls, read_file, write_file, edit_file, glob, grep) rooted at a workspace directory. Use it to persist analysis, notes, and intermediate results across the conversation. Prefer write_file for new artifacts and edit_file for small changes.`
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/agent.test.ts`
Expected: PASS — the new test green (workspace dir created) and all prior tests still green.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/agent.ts apps/deepagent/src/agent.test.ts
git commit -m "feat(deepagent): wire FilesystemBackend + permissions into buildAgent"
```

---

## Task 4: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full deepagent test suite**

From `apps/deepagent`:
```
bun test
```
Expected: all tests PASS (existing + new).

- [ ] **Step 2: Typecheck the package**

From `apps/deepagent`:
```
bunx tsc --noEmit
```
Expected: no type errors. (If `tsc` is unavailable, run `bun build src/index.ts --outdir /tmp/da-build --target bun` and confirm it compiles.)

- [ ] **Step 3: Smoke-check the workspace is created on API boot (manual)**

Start the API (`bun run dev` from repo root, or `bun run dev` in `apps/api`) and confirm `apps/api/data/agent-workspace/` now exists. This is a manual confirmation that the default path resolves correctly at runtime; the unit test in Task 3 already proves dir creation in isolation.

- [ ] **Step 4: Final commit (if any verification produced changes)**

No code changes are expected from verification. If `tsc`/build surfaced a fix, commit it:
```bash
git add -A
git commit -m "fix(deepagent): verification follow-ups"
```
Otherwise skip.

---

## Self-Review

**Spec coverage:**
- Backend = `FilesystemBackend({ rootDir, virtualMode: true })` → Task 2 (`buildBackend`) + Task 3 (wired in `buildAgent`). ✓
- Workspace path env-configurable (`AGENT_WORKSPACE_DIR`, default `apps/api/data/agent-workspace`) → Task 1 (`workspaceDir`). ✓
- Ensure dir exists → Task 3 (`mkdirSync(root, { recursive: true })`), tested in Task 3. ✓
- Explicit allow-all `permissions` rule → Task 1 (`WORKSPACE_PERMISSIONS`) + Task 3 (passed to `createDeepAgent`). ✓
- System prompt guidance → Task 3. ✓
- `buildAgent` signature unchanged → Task 3 preserves it; `/agent/chat` untouched (not in any task = correct). ✓
- No web UI / settings / trading-tool changes → none of the tasks touch them. ✓
- Hermetic tests (tmp dir, no real workspace pollution) → Tasks 1–3 use `mkdtempSync(tmpdir())`. ✓
- Deviation from spec: the spec's "assert the agent's tool list includes fs tools" test is dropped — the deepagents README confirms fs tools are always present (batteries-included) and introspecting a compiled LangGraph graph's tool list is fragile; the backend round-trip test (Task 2) + dir-creation test (Task 3) cover the actual wiring. This is a stricter, more reliable test of the same intent. ✓

**Placeholder scan:** none — every code step contains the exact code.

**Type consistency:** `workspaceDir()`, `buildBackend(root)`, `WORKSPACE_PERMISSIONS` are defined in Task 1–2 and consumed identically in Task 3. `FilesystemPermission` imported as type, `FilesystemBackend` as runtime. `buildAgent` signature unchanged. ✓