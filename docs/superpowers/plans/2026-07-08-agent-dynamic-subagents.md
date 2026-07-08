# Agent Dynamic Subagents Implementation Plan — Phase B

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 3 specialist subagents (general-purpose, quant, reporter) with restricted tool sets to the trading agent, wired into `buildAgent`, so the parent can delegate via the `task` tool and the `eval` `task()` global for fan-out/multi-symbol orchestration.

**Architecture:** Decompose into small exported, unit-testable units — `READ_ONLY_TOOLS` (the 10-tool read-only subset of `allTools`), an options arg on `buildInterpreterMiddleware` (to disable nested `task()` dispatch for the quant), and a `SUBAGENTS` array — composed inside `buildAgent` via the `subagents` key. `buildAgent(cfg)` signature unchanged. Dynamic `task()` dispatch is default-on via the existing Phase A interpreter middleware; no SSE/UI changes (subagent events flow through v2 unlabeled; per-subagent attribution is Phase C). Mirrors the decomposition pattern of the interpreter (Phase A) and workspace-filesystem phases.

**Tech Stack:** TypeScript, Bun (`bun:test`), `deepagents@1.10.5`, `@langchain/quickjs@0.5.1` (installed in Phase A). Tests run with `bun test` from `apps/deepagent`.

## Global Constraints

- Roster = exactly 3 subagents named `general-purpose`, `quant`, `reporter`. No duplicates. `general-purpose` is defined by us (named) to suppress the framework's auto general-purpose (which would inherit `sync_candles` + `call_api`).
- `READ_ONLY_TOOLS` = `allTools` filtered to the `PTC_ALLOWLIST` names (the Phase A boundary — single source of truth, no drift). Excludes `sync_candles` and `call_api`.
- Tool boundaries: `general-purpose` and `quant` `tools` = `READ_ONLY_TOOLS`; `reporter` `tools` = `[]` (filesystem tools only — always-present batteries-included, shared backend). The parent keeps all 12 tools (sole holder of `sync_candles`/`call_api`).
- `quant` middleware = `[buildInterpreterMiddleware({ subagents: false })]` (eval + PTC, but no nested `task()` dispatch — bounds recursion). `general-purpose` and `reporter` have no `middleware`.
- `buildInterpreterMiddleware(opts?: { subagents?: boolean })` — default (no arg) preserves Phase A parent behavior (task() enabled); `opts.subagents === false` adds `subagents: false` to `createCodeInterpreterMiddleware`.
- Permissions inherit the parent's `WORKSPACE_PERMISSIONS` for all 3 (no per-subagent permissions). Model inherits the parent's for all 3 (no per-subagent model).
- Always-on — `subagents: SUBAGENTS` is always passed in `buildAgent`. No toggle.
- `buildAgent(cfg: AgentConfig)` signature must remain unchanged.
- No SSE/endpoint changes, no web UI changes, no trading-tool changes, no workspace/permissions changes, no v3 streaming (Phase C).
- No new dependencies (`@langchain/quickjs` already installed in Phase A). Never hand-write `package.json`.

---

## File Structure

- **Modify:** `apps/deepagent/src/agent.ts` — add `READ_ONLY_TOOLS` export, options arg on `buildInterpreterMiddleware`, 3 prompt constants + `SUBAGENTS` export, `subagents` key in `buildAgent`'s `createDeepAgent` call, subagents paragraph in `SYSTEM_PROMPT`.
- **Modify:** `apps/deepagent/src/agent.test.ts` — tests for `READ_ONLY_TOOLS`, the `buildInterpreterMiddleware` option, `SUBAGENTS` shape/boundaries/middleware, and a `buildAgent`-with-subagents regression guard.

No new source files. The deepagent package `exports` map already exports `.` → `./src/agent.ts`, so new exports are reachable by the API.

---

## Task 1: `READ_ONLY_TOOLS` constant + `buildInterpreterMiddleware` options arg

**Files:**
- Modify: `apps/deepagent/src/agent.ts` (new `READ_ONLY_TOOLS` export after `PTC_ALLOWLIST`; options arg on `buildInterpreterMiddleware`)
- Test: `apps/deepagent/src/agent.test.ts`

**Interfaces:**
- Consumes: `allTools` (already imported in `agent.ts`), `PTC_ALLOWLIST` (Phase A).
- Produces: `READ_ONLY_TOOLS` (a `StructuredTool[]` subset of `allTools`) and `buildInterpreterMiddleware(opts?: { subagents?: boolean })`. Both consumed by `SUBAGENTS` in Task 2.

- [ ] **Step 1: Write the failing tests**

In `apps/deepagent/src/agent.test.ts`, add `READ_ONLY_TOOLS` to the `./agent` import. The current import line is:
```ts
import { buildModel, resolveAgentConfig, workspaceDir, WORKSPACE_PERMISSIONS, buildBackend, buildAgent, PTC_ALLOWLIST, buildInterpreterMiddleware } from './agent'
```
Change it to:
```ts
import { buildModel, resolveAgentConfig, workspaceDir, WORKSPACE_PERMISSIONS, buildBackend, buildAgent, PTC_ALLOWLIST, buildInterpreterMiddleware, READ_ONLY_TOOLS } from './agent'
```

Append the tests:
```ts
test('READ_ONLY_TOOLS: 10 read-only data tools from allTools, excludes sync_candles + call_api', () => {
  const names = READ_ONLY_TOOLS.map((t: any) => t.name)
  expect(names.sort()).toEqual([...PTC_ALLOWLIST].sort())
  expect(names).not.toContain('sync_candles')
  expect(names).not.toContain('call_api')
})

test('buildInterpreterMiddleware: { subagents: false } returns truthy without throwing', () => {
  const mw = buildInterpreterMiddleware({ subagents: false })
  expect(mw).toBeTruthy()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `apps/deepagent`:
```
bun test src/agent.test.ts
```
Expected: FAIL — `READ_ONLY_TOOLS` is not exported (import error), and `buildInterpreterMiddleware` does not accept an argument (the second test may fail at runtime if the arg is ignored, but the import error fails the file first).

- [ ] **Step 3: Implement `READ_ONLY_TOOLS` and the options arg**

In `apps/deepagent/src/agent.ts`, add `READ_ONLY_TOOLS` immediately after the `PTC_ALLOWLIST` array (after its closing `]`), before `buildInterpreterMiddleware`:
```ts
/** Read-only market-data tools = allTools filtered to the PTC_ALLOWLIST names.
 *  Reuses the Phase A boundary as the single source of truth (no name drift).
 *  Excludes sync_candles + call_api — subagents never get the write/passthrough tools. */
export const READ_ONLY_TOOLS = allTools.filter((t: any) => PTC_ALLOWLIST.includes(t.name))
```

Change `buildInterpreterMiddleware` from:
```ts
export function buildInterpreterMiddleware() {
  return createCodeInterpreterMiddleware({
    ptc: PTC_ALLOWLIST,
    executionTimeoutMs: 30_000,
  })
}
```
to:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/agent.test.ts`
Expected: PASS — the 2 new tests green; all 14 prior tests still green (the options arg is backward-compatible — no-arg calls behave identically).

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/agent.ts apps/deepagent/src/agent.test.ts
git commit -m "feat(deepagent): READ_ONLY_TOOLS + buildInterpreterMiddleware subagents option"
```

---

## Task 2: `SUBAGENTS` array (3 specialists + prompts)

**Files:**
- Modify: `apps/deepagent/src/agent.ts` (3 prompt constants + `SUBAGENTS` export, after `buildInterpreterMiddleware`)
- Test: `apps/deepagent/src/agent.test.ts`

**Interfaces:**
- Consumes: `READ_ONLY_TOOLS` and `buildInterpreterMiddleware({ subagents: false })` (Task 1).
- Produces: `SUBAGENTS` — an array of 3 subagent definition objects. Consumed by `buildAgent` in Task 3.

- [ ] **Step 1: Write the failing tests**

In `apps/deepagent/src/agent.test.ts`, add `SUBAGENTS` to the `./agent` import. The current import line (after Task 1) is:
```ts
import { buildModel, resolveAgentConfig, workspaceDir, WORKSPACE_PERMISSIONS, buildBackend, buildAgent, PTC_ALLOWLIST, buildInterpreterMiddleware, READ_ONLY_TOOLS } from './agent'
```
Change it to:
```ts
import { buildModel, resolveAgentConfig, workspaceDir, WORKSPACE_PERMISSIONS, buildBackend, buildAgent, PTC_ALLOWLIST, buildInterpreterMiddleware, READ_ONLY_TOOLS, SUBAGENTS } from './agent'
```

Append the tests:
```ts
test('SUBAGENTS: exactly 3 named subagents, no duplicates, general-purpose present', () => {
  const names = SUBAGENTS.map((s: any) => s.name)
  expect(names).toHaveLength(3)
  expect(new Set(names).size).toBe(3)
  expect(names).toContain('general-purpose')
  expect(names).toContain('quant')
  expect(names).toContain('reporter')
})

test('SUBAGENTS: general-purpose + quant use READ_ONLY_TOOLS; reporter tools empty', () => {
  const byName = Object.fromEntries(SUBAGENTS.map((s: any) => [s.name, s]))
  expect(byName['general-purpose'].tools).toBe(READ_ONLY_TOOLS)
  expect(byName['quant'].tools).toBe(READ_ONLY_TOOLS)
  expect(byName['reporter'].tools).toEqual([])
})

test('SUBAGENTS: quant has middleware; general-purpose + reporter have none', () => {
  const byName = Object.fromEntries(SUBAGENTS.map((s: any) => [s.name, s]))
  expect(Array.isArray(byName['quant'].middleware)).toBe(true)
  expect(byName['quant'].middleware.length).toBeGreaterThan(0)
  expect(byName['general-purpose'].middleware).toBeUndefined()
  expect(byName['reporter'].middleware).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent.test.ts`
Expected: FAIL — `SUBAGENTS` is not exported (import error).

- [ ] **Step 3: Implement the prompts and `SUBAGENTS`**

In `apps/deepagent/src/agent.ts`, add the 3 prompt constants and the `SUBAGENTS` array immediately after `buildInterpreterMiddleware` (and before `buildModel`):
```ts
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/agent.test.ts`
Expected: PASS — the 3 new tests green; all prior tests still green.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/agent.ts apps/deepagent/src/agent.test.ts
git commit -m "feat(deepagent): SUBAGENTS roster (general-purpose, quant, reporter)"
```

---

## Task 3: Wire `subagents` into `buildAgent`; system prompt

**Files:**
- Modify: `apps/deepagent/src/agent.ts` (`buildAgent` body + `SYSTEM_PROMPT`)
- Test: `apps/deepagent/src/agent.test.ts`

**Interfaces:**
- Consumes: `SUBAGENTS` (Task 2).
- Produces: `buildAgent(cfg)` now passes `subagents: SUBAGENTS` to `createDeepAgent`. Signature unchanged.

- [ ] **Step 1: Write the failing test**

Append a new test (regression guard — may already pass pre-wiring; the failure signal is if the wiring edit breaks construction):
```ts
test('buildAgent: constructs with subagents without throwing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'da-')) + '/sub'
  process.env.AGENT_WORKSPACE_DIR = root
  const agent = await buildAgent({ provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama3' })
  expect(agent).toBeTruthy()
  expect(existsSync(root)).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent.test.ts`
Expected: This test may already PASS before wiring (`buildAgent` currently returns a truthy agent). That is acceptable — it is a regression guard. The RED/GREEN evidence is: confirm it passes both before and after the wiring edit; if the wiring edit breaks it, that is the failure signal. Record the actual outcome honestly in the report.

- [ ] **Step 3: Wire `buildAgent` and update the system prompt**

In `apps/deepagent/src/agent.ts`, add the `subagents` key to the `createDeepAgent` call inside `buildAgent`. The current call is:
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
Change it to:
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

Append the subagents paragraph to `SYSTEM_PROMPT` (after the existing `eval` paragraph, before the closing backtick). The paragraph text (verbatim):
```
You can delegate to specialist subagents with the `task` tool, or from inside `eval` via the `task()` global: `task({ description, subagentType, responseSchema })` runs a full agentic loop on a subagent and resolves to its result. Subagents: `general-purpose` (research/fetch market data), `quant` (fetch candles + compute indicators in its own eval), `reporter` (write reports/artifacts to the workspace filesystem). Use `Promise.all` in `eval` to fan out across instruments, then synthesize. Prefer `task()` orchestration for multi-step, multi-symbol analysis instead of doing it all yourself turn-by-turn.
```
(Note: the surrounding `SYSTEM_PROMPT` is a template literal; escape backticks as `\`` inside it, matching the Phase A eval paragraph's style.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/agent.test.ts`
Expected: PASS — the new regression-guard test green, the existing `buildAgent: creates workspace dir if missing` and `buildAgent: constructs with interpreter middleware without throwing` tests still green, all prior tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/agent.ts apps/deepagent/src/agent.test.ts
git commit -m "feat(deepagent): wire subagents into buildAgent + system prompt"
```

---

## Task 4: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full deepagent test suite**

From `apps/deepagent`:
```
bun test
```
Expected: all tests PASS (existing 14 + Task 1's 2 + Task 2's 3 + Task 3's 1 = 20).

- [ ] **Step 2: Typecheck the package**

From `apps/deepagent`:
```
bunx tsc --noEmit
```
Expected: the only error is the pre-existing `Cannot find type definition file for 'bun-types'` config error (tsconfig `types: ["bun-types"]`, unresolvable, unrelated to this work). Zero errors mentioning `agent`, `subagents`, `READ_ONLY_TOOLS`, `SUBAGENTS`, or `buildInterpreterMiddleware`. If `createDeepAgent` rejects the `subagents` key or `createCodeInterpreterMiddleware` rejects the `subagents` boolean, errors will appear here — investigate and fix before committing. (This confirms the Task 1/2/3 ⚠️ items: `createDeepAgent` accepts `subagents`, `createCodeInterpreterMiddleware` accepts `subagents: false`.)

- [ ] **Step 3: Verify `reporter` `tools: []` retains the filesystem tools**

The spec risk: a subagent `tools` array "overrides the inherited tools entirely" — confirm `tools: []` does NOT strip the always-present batteries-included fs tools (ls, read_file, write_file, edit_file, glob, grep), since the reporter depends on them. Verify by reading the installed `deepagents` source:
```
grep -rn "general-purpose\|defaultTools\|filesystem\|read_file" apps/deepagent/node_modules/deepagents/dist | head -40
```
Look for how subagent tools are assembled — whether fs tools are added independently of the `tools` override. If the source shows fs tools are injected regardless of `tools`, the reporter design holds. If instead `tools: []` would leave the reporter with NO tools (fs stripped), then the reporter must explicitly receive the fs tools — in that case, stop and escalate to the controller (this contradicts the approved spec's "batteries-included" assumption); do not silently change the design. Record what the source shows in the task report.

- [ ] **Step 4: Verify auto `general-purpose` suppression**

Confirm the framework suppresses its auto general-purpose when a synchronous subagent named `general-purpose` is provided:
```
grep -rn "general-purpose\|general_purpose\|GeneralPurpose" apps/deepagent/node_modules/deepagents/dist | head -30
```
Look for the conditional that skips auto-addition when a provided subagent already has that name. Record the finding in the task report. If the installed version does NOT suppress (it would add a duplicate), stop and escalate — do not ship a duplicate-name roster.

- [ ] **Step 5: Final commit (only if verification produced changes)**

No code changes expected from verification. If Step 2 surfaced a type fix, commit it:
```bash
git add -A
git commit -m "fix(deepagent): verification follow-ups"
```
Otherwise skip.

---

## Self-Review

**Spec coverage:**
- 3 subagents (general-purpose, quant, reporter) with restricted tools → Task 2, tested by shape + tools + middleware tests. ✓
- `READ_ONLY_TOOLS` = allTools ∩ PTC_ALLOWLIST, excludes sync_candles/call_api → Task 1, tested by name-set + not.toContain. ✓
- `general-purpose` named to suppress auto → Task 2 (defined) + Task 4 Step 4 (verified in deepagents source). ✓
- `quant` middleware = `[buildInterpreterMiddleware({ subagents: false })]`; others none → Task 1 (option) + Task 2 (wired), tested. ✓
- `buildInterpreterMiddleware` options arg, default unchanged → Task 1, tested (no-arg calls still pass — backward compat). ✓
- `subagents: SUBAGENTS` wired into `buildAgent`, signature unchanged → Task 3, regression-guard test. ✓
- `SYSTEM_PROMPT` subagents paragraph → Task 3. ✓
- Always-on, no SSE/UI/trading-tool/workspace/v3 changes → none of the tasks touch them. ✓
- `reporter` `tools: []` keeps fs tools → Task 4 Step 3 (source-verified; escalates if not). ✓
- Hermetic tests (no LLM key) → Tasks 1–3 use only local construction (name filters, object shape, buildAgent with ollama config). ✓
- Real `task()` orchestration unverified without LLM key → noted in spec risks; hermetic tests cover roster + boundaries + wiring. ✓

**Placeholder scan:** none — every code step contains the exact code. Task 4 Steps 3–4 are concrete grep commands with a defined escalate-if-contradicted path, not placeholders.

**Type consistency:** `READ_ONLY_TOOLS` (Task 1) consumed identically in Task 2's `SUBAGENTS` (referenced by identity — `tools: READ_ONLY_TOOLS`). `buildInterpreterMiddleware(opts?)` (Task 1) consumed in Task 2's quant (`{ subagents: false }`) and Task 3's parent (no arg). `SUBAGENTS` (Task 2) consumed in Task 3's `buildAgent`. `buildAgent(cfg)` signature unchanged across all tasks. The test import line is updated cumulatively (Task 1 adds `READ_ONLY_TOOLS`, Task 2 adds `SUBAGENTS`) — each task shows the exact before/after import line. ✓