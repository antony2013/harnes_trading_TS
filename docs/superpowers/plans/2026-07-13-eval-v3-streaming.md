# Eval v3 Streaming Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the eval harness `captureRun` from v2 raw `streamEvents` events to v3 projections (`run.messages` / `run.toolCalls` / `run.subagents`) so the trajectory captures subagent-internal tool calls, scope-tagged — and fix the latent or-1 bug.

**Architecture:** `captureRun` consumes the three v3 projections concurrently via `Promise.all`; `TrajectoryStep` gains an optional `scope`; `runCase` passes `version: 'v3'` + an `abort` callback (for the `maxTurns` cap); tests use a `v3Stream(...)` fake instead of v2 raw events. `apps/api` agent SSE stays on v2 (untouched).

**Tech Stack:** Bun + TypeScript, `deepagents@1.10.5` (v3 streamEvents, experimental), `bun:test`. No new dependencies.

## Global Constraints

- Eval harness lives at `apps/deepagent/src/eval/` (NOT `apps/deepagent/eval/`) because `apps/deepagent/tsconfig.json` has `include: ["src"]`, `rootDir: "./src"`. Only approved spec deviation.
- LLM-free unit tests with injected fakes (no real model, no API). Deterministic trajectory assertions, no LLM judge.
- `deepagents@1.10.5` is pinned; v3 is experimental ("API may change") — accepted risk for dev tooling.
- `apps/api` agent SSE endpoint stays on v2 — NOT touched by this plan.
- Backward-compat: `scope?: string` is optional on `TrajectoryStep`; the `assertions.ts` grader stays scope-agnostic (matches by `name`).
- `process.env.API_BASE_URL` (tools/http.ts) and `process.env.AGENT_WORKSPACE_DIR` (agent.ts) are the two env vars the runner sets per case (unchanged).
- Main rule: no action without asking. Use `bun add` for any dependency (none needed here).

---

### Task 1: v3 migration of `captureRun` + `runCase` + tests (coordinator-only)

**Files:**
- Modify: `apps/deepagent/src/eval/types.ts` (add `scope?: string` to `TrajectoryStep`)
- Modify: `apps/deepagent/src/eval/run.ts` (`captureRun` rewrite + `runCase` v2→v3 + pass `abort`)
- Modify: `apps/deepagent/src/eval/run.test.ts` (add `v3Stream` helper, rewrite all 8 tests)

**Interfaces:**
- Consumes: `agent.streamEvents({ messages }, { version: 'v3', signal })` → `DeepAgentRunStream` (has `.messages`, `.toolCalls`, `.subagents` async iterables)
- Produces: `captureRun(run, { maxTurns, signal, abort })` → `RunCapture { trajectory, finalAnswer, error? }`; `TrajectoryStep` now carries `scope?: string`

- [ ] **Step 1: Add `scope` to `TrajectoryStep` (`types.ts`)**

Replace the `TrajectoryStep` interface in `apps/deepagent/src/eval/types.ts`:

```ts
export interface TrajectoryStep {
  name: string
  args: Record<string, any>
  tool_call_id: string
  scope?: string   // 'coordinator' (default) or the subagent name; absent == 'coordinator'
}
```

- [ ] **Step 2: Add the `v3Stream` test helper + rewrite the 3 `captureRun` unit tests (`run.test.ts`)**

Replace the top of `apps/deepagent/src/eval/run.test.ts` (the `mockStream` helper and the first 3 tests) with:

```ts
// apps/deepagent/src/eval/run.test.ts
import { test, expect } from 'bun:test'
import { captureRun } from './run'

/** Build an async iterable over a plain array. */
function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return (async function* () {
    for (const x of items) yield x
  })()
}

/**
 * Build a v3-shaped DeepAgentRunStream fake for unit tests (no real model).
 * - messages: each string becomes one message whose `.text` yields it as a single token.
 * - toolCalls: each {name,input} becomes a coordinator tool call.
 * - subagents: each {name,toolCalls} becomes a subagent handle (used by Task 2).
 */
function v3Stream(spec: {
  messages?: string[]
  toolCalls?: Array<{ name: string; input?: any }>
  subagents?: Array<{ name: string; toolCalls?: Array<{ name: string; input?: any }> }>
}): any {
  return {
    messages: asyncIter((spec.messages ?? []).map((text) => ({ text: asyncIter([text]) }))),
    toolCalls: asyncIter(
      (spec.toolCalls ?? []).map((c) => ({
        name: c.name,
        input: c.input ?? {},
        status: Promise.resolve('finished' as const),
        output: Promise.resolve('ok'),
      })),
    ),
    subagents: asyncIter(
      (spec.subagents ?? []).map((s) => ({
        name: s.name,
        toolCalls: asyncIter((s.toolCalls ?? []).map((c) => ({ name: c.name, input: c.input ?? {} }))),
        messages: asyncIter([]),
        subagents: asyncIter([]),
      })),
    ),
  }
}

test('captureRun collects tool starts and final answer', async () => {
  const stream = v3Stream({
    messages: ['Hi ', 'there'],
    toolCalls: [{ name: 'search_instruments', input: { q: 'TCS' } }],
  })
  const cap = await captureRun(stream, { maxTurns: 8 })
  expect(cap.trajectory).toHaveLength(1)
  expect(cap.trajectory[0]).toMatchObject({ name: 'search_instruments', args: { q: 'TCS' }, scope: 'coordinator' })
  expect(cap.finalAnswer).toBe('Hi there')
  expect(cap.error).toBeUndefined()
})

test('captureRun stops at maxTurns', async () => {
  const ac = new AbortController()
  const stream = v3Stream({
    toolCalls: Array.from({ length: 20 }, () => ({ name: 'get_ltp', input: {} })),
  })
  const cap = await captureRun(stream, { maxTurns: 3, signal: ac.signal, abort: () => ac.abort() })
  expect(cap.trajectory).toHaveLength(3)
  expect(cap.trajectory.every((s) => s.scope === 'coordinator')).toBe(true)
  expect(cap.error).toBeUndefined()
})

test('captureRun swallows stream errors into error field', async () => {
  const stream = {
    messages: asyncIter([]),
    toolCalls: (async function* () {
      yield { name: 'x', input: {} }
      throw new Error('stream blew up')
    })(),
    subagents: asyncIter([]),
  }
  const cap = await captureRun(stream, { maxTurns: 8 })
  expect(cap.trajectory).toHaveLength(1)
  expect(cap.error).toBe('stream blew up')
})
```

- [ ] **Step 3: Run the 3 captureRun tests — verify they FAIL**

Run: `cd apps/deepagent && bun test src/eval/run.test.ts`
Expected: FAIL — `captureRun` still expects a v2 raw-event stream; `stream.messages`/`stream.toolCalls` are not consumed.

- [ ] **Step 4: Rewrite `captureRun` (coordinator-only) + `runCase` v2→v3 (`run.ts`)**

Replace the `captureRun` function and the `streamEvents`/`captureRun` call inside `runCase` in `apps/deepagent/src/eval/run.ts`.

New `captureRun` (replaces the existing v2 version):

```ts
export async function captureRun(
  run: any, // DeepAgentRunStream from agent.streamEvents({ messages }, { version: 'v3', signal })
  opts: { maxTurns: number; signal?: AbortSignal; abort?: () => void },
): Promise<RunCapture> {
  const trajectory: TrajectoryStep[] = []
  let finalAnswer = ''
  let capReached = false
  const push = (scope: string, name: string, input: any) => {
    trajectory.push({ name, args: input ?? {}, tool_call_id: String(trajectory.length), scope })
    if (trajectory.length >= opts.maxTurns && !capReached) {
      capReached = true
      opts.abort?.() // runCase passes () => controller.abort() — cancels the v3 stream
    }
  }
  try {
    await Promise.all([
      (async () => {
        for await (const msg of run.messages) {
          if (capReached) break
          for await (const token of msg.text) finalAnswer += token
        }
      })(),
      (async () => {
        for await (const call of run.toolCalls) {
          if (capReached) break
          push('coordinator', call.name, call.input)
        }
      })(),
    ])
  } catch (err: any) {
    // abort (maxTurns cap or timeout) = clean partial stop, no error; real throw = error.
    if (!opts.signal?.aborted) return { trajectory, finalAnswer, error: err?.message ?? String(err) }
  }
  return { trajectory, finalAnswer }
}
```

In `runCase`, change the stream + capture call (the block currently using `{ version: 'v2', signal }`):

```ts
const stream = await agent.streamEvents(
  { messages: [{ role: 'user', content: c.prompt }] },
  { version: 'v3', signal: controller.signal },
)
const cap = await captureRun(stream, {
  maxTurns: c.maxTurns ?? 8,
  signal: controller.signal,
  abort: () => controller.abort(),
})
```

- [ ] **Step 5: Run the 3 captureRun tests — verify PASS**

Run: `cd apps/deepagent && bun test src/eval/run.test.ts -t "captureRun"`
Expected: PASS — 3 captureRun tests green.

- [ ] **Step 6: Rewrite the 5 `runSuite` tests to v3 fakes (`run.test.ts`)**

Replace the `fakeAgent` helper and the 4 `runSuite` tests (the block after the `// append to apps/deepagent/src/eval/run.test.ts` comment) with:

```ts
// append to apps/deepagent/src/eval/run.test.ts
import { runSuite } from './run'
import type { EvalCase } from './types'

function fakeAgent(spec: Parameters<typeof v3Stream>[0]) {
  return {
    streamEvents: async () => v3Stream(spec),
  }
}

test('runSuite: grades a passing case via injected fake agent', async () => {
  const oneCase: EvalCase = {
    id: 't1',
    category: 'ir',
    prompt: 'hi',
    stubRoutes: [],
    assertions: [{ kind: 'calls', tool: 'search_instruments', min: 1 }],
  }
  const results = await runSuite({
    cfg: { provider: 'ollama', apiKey: '', baseUrl: '', model: 'x' },
    cases: [oneCase],
    buildAgentFn: async () => fakeAgent({
      messages: ['done'],
      toolCalls: [{ name: 'search_instruments', input: { q: 'TCS' } }],
    }),
  })
  expect(results).toHaveLength(1)
  expect(results[0].passed).toBe(true)
  expect(results[0].trajectory[0].name).toBe('search_instruments')
  expect(results[0].finalAnswer).toBe('done')
})

test('runSuite: a failing assertion makes the case fail', async () => {
  const oneCase: EvalCase = {
    id: 't2',
    category: 'ir',
    prompt: 'hi',
    stubRoutes: [],
    assertions: [{ kind: 'not_called', tool: 'get_ltp' }],
  }
  const results = await runSuite({
    cfg: { provider: 'ollama', apiKey: '', baseUrl: '', model: 'x' },
    cases: [oneCase],
    buildAgentFn: async () => fakeAgent({ toolCalls: [{ name: 'get_ltp', input: {} }] }),
  })
  expect(results[0].passed).toBe(false)
  expect(results[0].assertionResults[0].passed).toBe(false)
})

test('runSuite: categories filter applies', async () => {
  const a: EvalCase = { id: 'a', category: 'c1', prompt: 'p', stubRoutes: [], assertions: [] }
  const b: EvalCase = { id: 'b', category: 'c2', prompt: 'p', stubRoutes: [], assertions: [] }
  const results = await runSuite({
    cfg: { provider: 'ollama', apiKey: '', baseUrl: '', model: 'x' },
    cases: [a, b],
    categories: ['c1'],
    buildAgentFn: async () => fakeAgent({}),
  })
  expect(results.map((r) => r.caseId)).toEqual(['a'])
})

test('runSuite: restores env and cleans up after run (no leak)', async () => {
  const before = process.env.API_BASE_URL
  await runSuite({
    cfg: { provider: 'ollama', apiKey: '', baseUrl: '', model: 'x' },
    cases: [{ id: 'leak', category: 'x', prompt: 'p', stubRoutes: [], assertions: [] }],
    buildAgentFn: async () => fakeAgent({}),
  })
  expect(process.env.API_BASE_URL).toBe(before)
})
```

- [ ] **Step 7: Run the full eval suite + full deepagent suite — verify PASS**

Run: `cd apps/deepagent && bun test src/eval`
Expected: PASS — all eval tests green (assertions, stub-server, workspace, run, http-routing, cases).

Run: `cd apps/deepagent && bun test`
Expected: PASS — full deepagent suite green (was 57; the rewritten tests keep the count — 3 captureRun + 4 runSuite = 7 in run.test.ts, plus the new subagent test in Task 2).

- [ ] **Step 8: Commit**

```bash
git add apps/deepagent/src/eval/types.ts apps/deepagent/src/eval/run.ts apps/deepagent/src/eval/run.test.ts
git commit -m "feat(eval): migrate captureRun to v3 streamEvents (coordinator-only)

Rewrite captureRun to consume the v3 DeepAgentRunStream projections
(run.messages, run.toolCalls) concurrently; TrajectoryStep gains scope?
(coordinator). runCase passes version:'v3' + an abort callback for the
maxTurns cap. Tests use a v3Stream fake instead of v2 raw events.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Subagent recursion in `captureRun` (scope-tagged)

**Files:**
- Modify: `apps/deepagent/src/eval/run.ts` (add subagent consumption to `captureRun`)
- Modify: `apps/deepagent/src/eval/run.test.ts` (add subagent-trajectory test)

**Interfaces:**
- Consumes: `run.subagents` → each `{ name, toolCalls, subagents (nested) }`
- Produces: `TrajectoryStep` entries with `scope: <subagent.name>` for delegated tool calls

- [ ] **Step 1: Write the failing subagent-trajectory test (`run.test.ts`)**

Append to `apps/deepagent/src/eval/run.test.ts`:

```ts
test('captureRun captures subagent-internal tool calls, scope-tagged', async () => {
  const stream = v3Stream({
    toolCalls: [{ name: 'task', input: { subagent_type: 'quant' } }],
    subagents: [
      {
        name: 'quant',
        toolCalls: [
          { name: 'historical_candles', input: { instrument_key: 'NSE_EQ|RELIANCE' } },
          { name: 'read_candles', input: {} },
        ],
      },
    ],
  })
  const cap = await captureRun(stream, { maxTurns: 8 })
  expect(cap.trajectory.map((s) => s.name)).toEqual(['task', 'historical_candles', 'read_candles'])
  expect(cap.trajectory[0].scope).toBe('coordinator')
  expect(cap.trajectory[1].scope).toBe('quant')
  expect(cap.trajectory[2].scope).toBe('quant')
  expect(cap.error).toBeUndefined()
})
```

- [ ] **Step 2: Run the test — verify FAIL**

Run: `cd apps/deepagent && bun test src/eval/run.test.ts -t "subagent-internal"`
Expected: FAIL — Task-1 `captureRun` does not consume `run.subagents`; trajectory is only `['task']`.

- [ ] **Step 3: Add subagent recursion to `captureRun` (`run.ts`)**

Add a recursive subagent consumer and wire it into the `Promise.all`. Replace the `Promise.all` block in `captureRun` with:

```ts
  const consumeSubagent = async (sub: any) => {
    for await (const call of sub.toolCalls) {
      if (capReached) break
      push(sub.name, call.name, call.input)
    }
    for await (const nested of sub.subagents) {
      if (capReached) break
      await consumeSubagent(nested)
    }
  }
  try {
    await Promise.all([
      (async () => {
        for await (const msg of run.messages) {
          if (capReached) break
          for await (const token of msg.text) finalAnswer += token
        }
      })(),
      (async () => {
        for await (const call of run.toolCalls) {
          if (capReached) break
          push('coordinator', call.name, call.input)
        }
      })(),
      (async () => {
        for await (const sub of run.subagents) {
          if (capReached) break
          await consumeSubagent(sub)
        }
      })(),
    ])
  } catch (err: any) {
    if (!opts.signal?.aborted) return { trajectory, finalAnswer, error: err?.message ?? String(err) }
  }
  return { trajectory, finalAnswer }
```

- [ ] **Step 4: Run the subagent test — verify PASS**

Run: `cd apps/deepagent && bun test src/eval/run.test.ts -t "subagent-internal"`
Expected: PASS.

- [ ] **Step 5: Run the full eval suite + full deepagent suite — verify PASS**

Run: `cd apps/deepagent && bun test src/eval`
Expected: PASS (now +1 test = the subagent test; run.test.ts has 8 tests).
Run: `cd apps/deepagent && bun test`
Expected: PASS — full deepagent suite green (was 57 → 58).

- [ ] **Step 6: Commit**

```bash
git add apps/deepagent/src/eval/run.ts apps/deepagent/src/eval/run.test.ts
git commit -m "feat(eval): capture subagent-internal tool calls in trajectory

captureRun now consumes run.subagents recursively, tagging each
delegated tool call with scope = subagent name. Full scope-tagged
trajectory fuel for the ralph loop.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: or-1 re-scope (coordinator-only direct-call count)

**Files:**
- Modify: `apps/deepagent/src/eval/cases/orchestration.ts` (re-scope the `delegated-or-batched` count)
- Create: `apps/deepagent/src/eval/cases/orchestration.test.ts` (lock the re-scoped behavior)

**Interfaces:**
- Consumes: `TrajectoryStep[]` (now scope-tagged)
- Produces: or-1 `custom` assertion that counts only `scope === 'coordinator'` market-data calls

- [ ] **Step 1: Write the failing or-1 assertion tests (`cases/orchestration.test.ts`)**

Create `apps/deepagent/src/eval/cases/orchestration.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { orchestrationCases } from './orchestration'
import type { TrajectoryStep } from '../types'

const or1 = orchestrationCases.find((c) => c.id === 'or-1')!
const check = (or1.assertions[0] as { check: (t: TrajectoryStep[]) => { passed: boolean; detail?: string } }).check

test('or-1 delegated-or-batched: delegation to a subagent passes', () => {
  // Coordinator delegates via task; the quant subagent makes 5 internal market-data calls.
  const t: TrajectoryStep[] = [
    { name: 'task', args: { subagent_type: 'quant' }, tool_call_id: '0', scope: 'coordinator' },
    { name: 'historical_candles', args: {}, tool_call_id: '1', scope: 'quant' },
    { name: 'historical_candles', args: {}, tool_call_id: '2', scope: 'quant' },
    { name: 'historical_candles', args: {}, tool_call_id: '3', scope: 'quant' },
    { name: 'historical_candles', args: {}, tool_call_id: '4', scope: 'quant' },
    { name: 'historical_candles', args: {}, tool_call_id: '5', scope: 'quant' },
  ]
  expect(check(t).passed).toBe(true)
})

test('or-1 delegated-or-batched: 5 direct coordinator market-data calls fails', () => {
  const t: TrajectoryStep[] = Array.from({ length: 5 }, (_, i) => ({
    name: 'historical_candles',
    args: {},
    tool_call_id: String(i),
    scope: 'coordinator',
  }))
  expect(check(t).passed).toBe(false)
})
```

- [ ] **Step 2: Run the or-1 tests — verify FAIL (the delegation case)**

Run: `cd apps/deepagent && bun test src/eval/cases/orchestration.test.ts`
Expected: FAIL — the current or-1 count is scope-agnostic; the delegation case (5 internal quant calls) counts as `direct >= 5` → `passed: false`, but the test expects `true`.

- [ ] **Step 3: Re-scope the or-1 count to coordinator-only (`cases/orchestration.ts`)**

In `apps/deepagent/src/eval/cases/orchestration.ts`, change the `direct` line inside the `delegated-or-batched` `check`:

```ts
          const direct = t.filter((s) => marketTools.has(s.name) && s.scope === 'coordinator').length
          return direct >= 5
            ? { passed: false, detail: `${direct} direct coordinator market-data calls — should delegate/batch via task/eval` }
            : { passed: true }
```

- [ ] **Step 4: Run the or-1 tests — verify PASS**

Run: `cd apps/deepagent && bun test src/eval/cases/orchestration.test.ts`
Expected: PASS — 2 tests green.

- [ ] **Step 5: Run the full eval suite + full deepagent suite — verify PASS**

Run: `cd apps/deepagent && bun test src/eval`
Expected: PASS (now +2 tests in the new orchestration.test.ts).
Run: `cd apps/deepagent && bun test`
Expected: PASS — full deepagent suite green (was 58 → 60).

- [ ] **Step 6: Commit**

```bash
git add apps/deepagent/src/eval/cases/orchestration.ts apps/deepagent/src/eval/cases/orchestration.test.ts
git commit -m "fix(eval): or-1 counts only coordinator-scope direct market-data calls

Subagent-internal market-data calls are delegated, not direct — exclude
them from the or-1 delegated-or-batched count. Fixes the latent v2 bug
where delegation to the quant subagent failed the case.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review (run before handoff)

- **Spec coverage:** v3 migration (Task 1), subagent scope-tagging (Task 2), or-1 fix (Task 3) — all spec sections covered.
- **Type consistency:** `scope?: string` (types.ts) read in or-1 (`s.scope === 'coordinator'`) and asserted in tests. `captureRun(run, { maxTurns, signal, abort })` signature consistent across runCase call and all tests.
- **Placeholder scan:** none — every step has complete code.
- **Green-at-each-commit:** Task 1 ends with the full suite green (coordinator-only trajectory = identical to v2 for the 7 non-subagent cases). Tasks 2 and 3 are additive (+1 and +2 tests).

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-13-eval-v3-streaming.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**