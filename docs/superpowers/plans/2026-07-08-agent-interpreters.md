# Agent Interpreters (eval + PTC) Implementation Plan — Phase A

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-memory JavaScript interpreter (`eval` tool via `@langchain/quickjs`) to the trading agent, with PTC exposing the 10 read-only market-data tools inside the interpreter, so the agent can run loops/batches/parallel fetches and deterministic transforms from code.

**Architecture:** Decompose into small exported, unit-testable units — `PTC_ALLOWLIST` (the permission boundary) and `buildInterpreterMiddleware()` — composed inside `buildAgent` via the `middleware` array. `buildAgent(cfg)` signature unchanged. The `eval` tool flows through the existing SSE `tool_call`/`tool_result` path; no SSE/UI changes. Mirrors the decomposition pattern of the workspace-filesystem phase.

**Tech Stack:** TypeScript, Bun (`bun:test`), `deepagents@1.10.5`, `@langchain/quickjs` (to be installed). Tests run with `bun test` from `apps/deepagent`.

## Global Constraints

- PTC allowlist = exactly these 10 read-only tool names: `search_instruments`, `get_ltp`, `get_ohlc_quote`, `historical_candles`, `intraday_candles`, `option_chain`, `market_status`, `read_candles`, `company_profile`, `news`. **Exclude** `sync_candles` and `call_api`.
- Interpreter limits: `executionTimeoutMs: 30000`; other defaults kept (`maxResultChars: 4000`, `maxPtcCalls: 256`, `memoryLimitBytes: 64MB`, `captureConsole: true`).
- Always-on — `middleware: [buildInterpreterMiddleware()]` is always passed in `buildAgent`. No toggle.
- `buildAgent(cfg: AgentConfig)` signature must remain unchanged.
- No SSE/endpoint changes, no web UI changes, no trading-tool changes, no subagents (Phase B), no v3 streaming (Phase C).
- Dependency rule: install `@langchain/quickjs` via `bun add @langchain/quickjs` — never hand-write `package.json`.
- The named import is `createCodeInterpreterMiddleware` from `'@langchain/quickjs'` (per the deepagents docs). If the installed version exposes it under a different name, adjust the import — same public behavior; note the actual export name in the task report.

---

## File Structure

- **Modify:** `apps/deepagent/src/agent.ts` — add `PTC_ALLOWLIST` export, `buildInterpreterMiddleware()` export, `middleware` key in `buildAgent`'s `createDeepAgent` call, interpreter paragraph in `SYSTEM_PROMPT`.
- **Modify:** `apps/deepagent/package.json` (+ `bun.lock`) — `bun add @langchain/quickjs` (Task 2).
- **Modify:** `apps/deepagent/src/agent.test.ts` — tests for `PTC_ALLOWLIST`, `buildInterpreterMiddleware`, and regression of `buildAgent`.

No new source files. The deepagent package `exports` map already exports `.` → `./src/agent.ts`, so new exports are reachable by the API.

---

## Task 1: `PTC_ALLOWLIST` constant

**Files:**
- Modify: `apps/deepagent/src/agent.ts` (new export near `WORKSPACE_PERMISSIONS`/`buildBackend`)
- Test: `apps/deepagent/src/agent.test.ts`

**Interfaces:**
- Produces: `PTC_ALLOWLIST: string[]` — the 10 read-only tool names. Consumed by `buildInterpreterMiddleware` in Task 2.

- [ ] **Step 1: Write the failing tests**

In `apps/deepagent/src/agent.test.ts`, add `PTC_ALLOWLIST` to the `./agent` import (currently):
```ts
import { buildModel, resolveAgentConfig, workspaceDir, WORKSPACE_PERMISSIONS, buildBackend, buildAgent, PTC_ALLOWLIST } from './agent'
```

Append the test:
```ts
test('PTC_ALLOWLIST: 10 read-only data tools, excludes sync_candles + call_api', () => {
  expect(PTC_ALLOWLIST).toEqual([
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
  ])
  expect(PTC_ALLOWLIST).not.toContain('sync_candles')
  expect(PTC_ALLOWLIST).not.toContain('call_api')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `apps/deepagent`:
```
bun test src/agent.test.ts
```
Expected: FAIL — `PTC_ALLOWLIST` is not exported.

- [ ] **Step 3: Implement the constant**

In `apps/deepagent/src/agent.ts`, add just below `buildBackend` (and above `buildModel`):

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/agent.test.ts`
Expected: PASS — all tests green (existing 11 + new 1).

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/agent.ts apps/deepagent/src/agent.test.ts
git commit -m "feat(deepagent): PTC_ALLOWLIST constant for interpreter tool exposure"
```

---

## Task 2: Install `@langchain/quickjs` + `buildInterpreterMiddleware`

**Files:**
- Modify: `apps/deepagent/package.json` (+ `bun.lock`) — `bun add @langchain/quickjs`
- Modify: `apps/deepagent/src/agent.ts` (import + `buildInterpreterMiddleware`)
- Test: `apps/deepagent/src/agent.test.ts`

**Interfaces:**
- Produces: `buildInterpreterMiddleware()` — returns `createCodeInterpreterMiddleware({ ptc: PTC_ALLOWLIST, executionTimeoutMs: 30_000 })`. Consumed by `buildAgent` in Task 3.

- [ ] **Step 1: Write the failing test**

In `apps/deepagent/src/agent.test.ts`, add `buildInterpreterMiddleware` to the `./agent` import:
```ts
import { buildModel, resolveAgentConfig, workspaceDir, WORKSPACE_PERMISSIONS, buildBackend, buildAgent, PTC_ALLOWLIST, buildInterpreterMiddleware } from './agent'
```

Append the test:
```ts
test('buildInterpreterMiddleware: returns a truthy middleware object without throwing', () => {
  const mw = buildInterpreterMiddleware()
  expect(mw).toBeTruthy()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent.test.ts`
Expected: FAIL — `buildInterpreterMiddleware` is not exported (import error).

- [ ] **Step 3: Install the dependency**

From the repo root (`D:\Harnesh_trading_ts`):
```
cd apps/deepagent && bun add @langchain/quickjs
```
Note the resolved version in the task report (the interpreter API is beta; pin/record it). Confirm `createCodeInterpreterMiddleware` is an export of `@langchain/quickjs` (check `apps/deepagent/node_modules/@langchain/quickjs` package.json `exports`/types, or a quick `bun -e "import('@langchain/quickjs').then(m=>console.log(Object.keys(m)))"`). If the export name differs, use the actual one and note it.

- [ ] **Step 4: Implement `buildInterpreterMiddleware`**

In `apps/deepagent/src/agent.ts`, add the import at the top with the other external imports (after the `deepagents` import):
```ts
import { createCodeInterpreterMiddleware } from '@langchain/quickjs'
```

Add the helper just below `PTC_ALLOWLIST`:
```ts
/** Build the code-interpreter middleware: eval tool + PTC over the read-only data tools,
 *  with a 30s timeout to allow multi-tool network orchestration from a single eval. */
export function buildInterpreterMiddleware() {
  return createCodeInterpreterMiddleware({
    ptc: PTC_ALLOWLIST,
    executionTimeoutMs: 30_000,
  })
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/agent.test.ts`
Expected: PASS — the new test green; all prior tests still green.

- [ ] **Step 6: Commit**

```bash
git add apps/deepagent/src/agent.ts apps/deepagent/src/agent.test.ts apps/deepagent/package.json bun.lock
git commit -m "feat(deepagent): buildInterpreterMiddleware + @langchain/quickjs (eval + PTC)"
```
(If `bun.lock` lives at the repo root rather than `apps/deepagent`, `git add` the path where `bun add` actually modified it — confirm with `git status` before committing.)

---

## Task 3: Wire middleware into `buildAgent`; system prompt

**Files:**
- Modify: `apps/deepagent/src/agent.ts` (`buildAgent` body + `SYSTEM_PROMPT`)
- Test: `apps/deepagent/src/agent.test.ts`

**Interfaces:**
- Consumes: `buildInterpreterMiddleware()` (Task 2).
- Produces: `buildAgent(cfg)` now passes `middleware: [buildInterpreterMiddleware()]` to `createDeepAgent`. Signature unchanged.

- [ ] **Step 1: Write the failing test**

The existing `buildAgent: creates workspace dir if missing` test already calls `buildAgent(...)` and asserts the workspace dir is created. After wiring the middleware, that test must still pass — if the middleware wiring breaks agent construction, it fails. Add an explicit assertion-strengthening test that the agent build does not throw with the middleware, by extending the existing test (or adding a new one):

Append a new test:
```ts
test('buildAgent: constructs with interpreter middleware without throwing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'da-')) + '/mw'
  process.env.AGENT_WORKSPACE_DIR = root
  const agent = await buildAgent({ provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama3' })
  expect(agent).toBeTruthy()
  expect(existsSync(root)).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent.test.ts`
Expected: This test may already PASS before wiring (buildAgent currently returns a truthy agent). That is acceptable — the test is a regression guard for Task 3's wiring. The RED/GREEN evidence for this task is: confirm the test passes both before and after the wiring edit; if the wiring edit breaks it, that's the failure signal. Record the actual outcome honestly in the report.

- [ ] **Step 3: Wire `buildAgent` and update the system prompt**

In `apps/deepagent/src/agent.ts`, add the `middleware` key to the `createDeepAgent` call inside `buildAgent`. The current call is:
```ts
  return createDeepAgent({
    model,
    tools: allTools,
    systemPrompt: SYSTEM_PROMPT,
    backend: buildBackend(root),
    permissions: WORKSPACE_PERMISSIONS,
  })
```
Change it to:
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

Append the interpreter paragraph to `SYSTEM_PROMPT` (after the existing workspace paragraph, before the closing backtick). The paragraph text (verbatim):
```
You have an `eval` tool that runs JavaScript in a sandboxed QuickJS interpreter (no filesystem, network, or shell access). The read-only market-data tools are available inside `eval` as `tools.*` (e.g. `tools.get_ltp`, `tools.historical_candles`, `tools.search_instruments`). Use `eval` for loops, parallel/batched fetches, and deterministic transforms (indicators, aggregation, filtering) instead of one tool call per turn. For multi-step data work, write a workflow in `eval`.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/agent.test.ts`
Expected: PASS — the new regression-guard test green, the existing `buildAgent: creates workspace dir if missing` test still green, all prior tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/agent.ts apps/deepagent/src/agent.test.ts
git commit -m "feat(deepagent): wire interpreter middleware into buildAgent + system prompt"
```

---

## Task 4: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full deepagent test suite**

From `apps/deepagent`:
```
bun test
```
Expected: all tests PASS (existing 11 + new 3 = 14).

- [ ] **Step 2: Typecheck the package**

From `apps/deepagent`:
```
bunx tsc --noEmit
```
Expected: the only error is the pre-existing `Cannot find type definition file for 'bun-types'` config error (tsconfig `types: ["bun-types"]`, unresolvable, unrelated to this work). Zero errors mentioning `agent`, `quickjs`, `createCodeInterpreterMiddleware`, or `middleware`. If `@langchain/quickjs` types are missing or the `middleware`/`ptc` keys are rejected by `createDeepAgent`'s param type, errors will appear here — investigate and fix before committing.

- [ ] **Step 3: Confirm the dependency is recorded**

`git show --stat HEAD` (Task 2's commit) should list `apps/deepagent/package.json` and the lockfile. Confirm `@langchain/quickjs` is present in `apps/deepagent/package.json` `dependencies`.

- [ ] **Step 4: Final commit (only if verification produced changes)**

No code changes expected from verification. If `tsc` surfaced a fix, commit it:
```bash
git add -A
git commit -m "fix(deepagent): verification follow-ups"
```
Otherwise skip.

---

## Self-Review

**Spec coverage:**
- `@langchain/quickjs` installed via `bun add` → Task 2 Step 3. ✓
- `PTC_ALLOWLIST` = 10 read-only tools, excludes `sync_candles`/`call_api` → Task 1, tested by deep-equal + `not.toContain`. ✓
- `buildInterpreterMiddleware()` = `createCodeInterpreterMiddleware({ ptc: PTC_ALLOWLIST, executionTimeoutMs: 30_000 })` → Task 2. ✓
- `middleware: [buildInterpreterMiddleware()]` wired into `buildAgent`, signature unchanged → Task 3. ✓
- `SYSTEM_PROMPT` interpreter paragraph → Task 3. ✓
- Always-on, no SSE/UI/trading-tool/subagent/v3 changes → none of the tasks touch them. ✓
- Hermetic tests (no LLM key) → Tasks 1–3 use only local construction (PTC_ALLOWLIST deep-equal, middleware truthy, buildAgent with ollama config). ✓
- Real `eval` execution unverified without LLM key → noted in spec risks; hermetic tests cover wiring. ✓

**Placeholder scan:** none — every code step contains the exact code. The Task 2 "confirm export name" instruction is a concrete verification action with a fallback, not a placeholder.

**Type consistency:** `PTC_ALLOWLIST: string[]` (Task 1) consumed identically in Task 2's `buildInterpreterMiddleware`. `buildInterpreterMiddleware()` (Task 2) consumed in Task 3's `buildAgent`. `buildAgent(cfg)` signature unchanged across all tasks. ✓

**Test-strength note:** The `buildInterpreterMiddleware` truthy test is intentionally weak (the middleware object's internal shape belongs to `@langchain/quickjs`). The strong test is `PTC_ALLOWLIST` deep-equal (the actual permission boundary), plus the buildAgent regression guard proving the middleware doesn't break construction. This matches the spec's "hermetic tests cover the wiring" stance; live `eval` behavior is verified when an LLM key is available.