# Eval Harness (Sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an offline, deterministic tool-selection eval harness for the deepagent in `apps/deepagent/src/eval/`, with an importable `runSuite` + CLI that returns per-case pass/fail and trajectories — the foundation for harness-profile (B) and ralph-loop (C) tuning.

**Architecture:** Declarative TS eval cases feed a local stub HTTP server (Bun.serve) + a seeded temp workspace. The runner builds the agent and iterates `streamEvents` (v2), capturing `on_tool_start` (tool name + args) into a trajectory and `on_chat_model_stream` into a final answer. A deterministic assertion DSL (8 declarative kinds + a `custom` escape hatch) grades the trajectory. `runSuite` is both a CLI (`bun run src/eval/cli.ts`) and an importable lib so the future ralph loop calls it directly.

**Tech Stack:** Bun, TypeScript, `bun:test`, `deepagents`/`langchain` (`agent.streamEvents`), `node:fs`/`node:os`/`node:path`.

## Global Constraints

- **Location:** `apps/deepagent/src/eval/` (NOT `apps/deepagent/eval/` as the spec loosely said — `tsconfig.json` has `include: ["src"]`, `rootDir: "./src"`, so the harness must live under `src/` to be typechecked and discovered by `bun test`). This is the only deviation from the spec; everything else matches `docs/superpowers/specs/2026-07-13-eval-suite-design.md`.
- **Offline:** no Upstox network. The LLM is real (the model under test) — `cfg` is an `AgentConfig`.
- **Defaults:** `maxTurns` 8 tool calls; `timeoutMs` 60_000 ms; stub server returns 404 for unmatched routes.
- **No leaks:** stub server stopped + temp workspace `rm -rf`'d in `finally` on pass/fail/throw/timeout. Process env (`API_BASE_URL`, `AGENT_WORKSPACE_DIR`) restored in `finally`.
- **No LLM in unit tests:** every unit test is deterministic (mock streams, injected fake `buildAgentFn`). End-to-end smoke is a manual CLI run, not a unit test.
- **Tool arg field names** come straight from each tool's zod schema (snake_case): `search_instruments.q`, `get_ltp.instrument_keys`, `sync_candles.{source,unit,interval}`, `sync_expired_candles.interval`, `read_candles.timeframe`, `read_file.offset`.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/deepagent/src/eval/types.ts` | All shared types: `StubRoute`, `WorkspaceSeedFile`, `TrajectoryStep`, `Assertion`, `EvalCase`, `EvalResult`. No imports from `../agent` (keeps the type module dependency-free). |
| `apps/deepagent/src/eval/stub-server.ts` | `startStubServer(routes) -> { url, stop }`. Ephemeral Bun.serve, decodes pathname, matches method+path+optional query, 404 otherwise. |
| `apps/deepagent/src/eval/workspace.ts` | `createSeededWorkspace(seed) -> { dir, cleanup }`. mkdtemp + write seed files + rm cleanup. |
| `apps/deepagent/src/eval/assertions.ts` | `gradeAssertion(a, traj)` + `gradeCase(assertions, traj)` — the 8 assertion kinds + `custom`. |
| `apps/deepagent/src/eval/cases/instrument-resolution.ts` | `ir-1`, `ir-2`. |
| `apps/deepagent/src/eval/cases/candle-sync.ts` | `cs-1`, `cs-2`, `cs-3`. |
| `apps/deepagent/src/eval/cases/read-file-pagination.ts` | `rf-1`, `rf-2`. |
| `apps/deepagent/src/eval/cases/orchestration.ts` | `or-1`. |
| `apps/deepagent/src/eval/cases/index.ts` | `ALL_CASES` — concatenation of all category files. |
| `apps/deepagent/src/eval/run.ts` | `captureRun(stream, opts)` + `runSuite({ cfg, cases?, categories?, buildAgentFn? })`. |
| `apps/deepagent/src/eval/report.ts` | `summarize(results)` (human) + `toJson(results)`. |
| `apps/deepagent/src/eval/cli.ts` | `parseArgs` + `main()`. Reads `--provider/--model/--apiKey/--baseUrl` or `--from-settings`, `--category/--case/--json/--out`. |
| `apps/deepagent/package.json` | Add `"eval": "bun run src/eval/cli.ts"` script. |
| `apps/deepagent/src/eval/*.test.ts` | One test file per module (next to it), deterministic. |

---

### Task 1: Shared types

**Files:**
- Create: `apps/deepagent/src/eval/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `StubRoute`, `WorkspaceSeedFile`, `TrajectoryStep`, `Assertion` (discriminated union), `EvalCase`, `EvalResult` — imported by every later task as `import type { ... } from './types'` (or `'../types'` from `cases/`).

- [ ] **Step 1: Write the types**

```ts
// apps/deepagent/src/eval/types.ts
export type HttpMethod = 'GET' | 'POST'

export interface StubRoute {
  method: HttpMethod
  path: string                       // exact decoded path, e.g. '/instruments/search'
  query?: Record<string, string>     // optional query match; omit = match any query
  status?: number                    // default 200
  body?: unknown                     // canned JSON returned
}

export interface WorkspaceSeedFile {
  path: string
  content: string
}

export interface TrajectoryStep {
  name: string
  args: Record<string, any>
  tool_call_id: string
}

export type Assertion =
  | { kind: 'calls'; tool: string; min?: number; max?: number }
  | { kind: 'not_called'; tool: string }
  | { kind: 'order'; sequence: string[] }
  | { kind: 'arg_in'; tool: string; arg: string; values: unknown[] }
  | { kind: 'arg_not_in'; tool: string; arg: string; values: unknown[] }
  | { kind: 'arg_matches'; tool: string; arg: string; regex: string }
  | { kind: 'first_is'; tool: string }
  | {
      kind: 'custom'
      label: string
      check: (t: TrajectoryStep[]) => { passed: boolean; detail?: string }
    }

export interface EvalCase {
  id: string
  category: string
  prompt: string
  stubRoutes: StubRoute[]
  workspaceSeed?: WorkspaceSeedFile[]
  assertions: Assertion[]
  maxTurns?: number
  timeoutMs?: number
}

export interface AssertionResult {
  assertion: Assertion
  passed: boolean
  detail?: string
}

export interface EvalResult {
  caseId: string
  category: string
  passed: boolean
  trajectory: TrajectoryStep[]
  assertionResults: AssertionResult[]
  finalAnswer?: string
  error?: string
  durationMs: number
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd apps/deepagent && bun build src/eval/types.ts --outdir .tmp/typecheck --target bun`
Expected: builds with no errors (pure type file, no runtime).

- [ ] **Step 3: Commit**

```bash
git add apps/deepagent/src/eval/types.ts
git commit -m "feat(eval): shared types for eval harness"
```

---

### Task 2: Stub HTTP server

**Files:**
- Create: `apps/deepagent/src/eval/stub-server.ts`
- Test: `apps/deepagent/src/eval/stub-server.test.ts`

**Interfaces:**
- Consumes: `StubRoute` from `./types`.
- Produces: `startStubServer(routes: StubRoute[]): Promise<{ url: string; stop: () => Promise<void> }>`. The agent's `http.ts` constructs `new URL(API_BASE_URL + path)` and sets query params, so the stub receives decoded pathname + query string. Pathname is **decoded** before matching so case authors write natural paths (e.g. `/backtest/data/candles/NSE_FO|54452|24-04-2025/day`).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/deepagent/src/eval/stub-server.test.ts
import { test, expect } from 'bun:test'
import { startStubServer } from './stub-server'

test('matches method+path and returns canned body', async () => {
  const s = await startStubServer([
    { method: 'GET', path: '/instruments/search', body: { data: [{ instrument_key: 'NSE_EQ|INE002A01018', name: 'TCS' }] } },
  ])
  try {
    const res = await fetch(`${s.url}/instruments/search?q=tcs`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [{ instrument_key: 'NSE_EQ|INE002A01018', name: 'TCS' }] })
  } finally {
    await s.stop()
  }
})

test('returns 404 for unmatched routes', async () => {
  const s = await startStubServer([])
  try {
    const res = await fetch(`${s.url}/nope`)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toContain('no stub')
  } finally {
    await s.stop()
  }
})

test('query match selects between same-path routes', async () => {
  const s = await startStubServer([
    { method: 'GET', path: '/x', query: { a: '1' }, body: { hit: 'a1' } },
    { method: 'GET', path: '/x', query: { a: '2' }, body: { hit: 'a2' } },
  ])
  try {
    expect(await (await fetch(`${s.url}/x?a=1`)).json()).toEqual({ hit: 'a1' })
    expect(await (await fetch(`${s.url}/x?a=2`)).json()).toEqual({ hit: 'a2' })
    expect((await fetch(`${s.url}/x?a=3`)).status).toBe(404)
  } finally {
    await s.stop()
  }
})

test('decodes encoded pathnames (e.g. instrument keys with pipes)', async () => {
  const s = await startStubServer([
    { method: 'GET', path: '/backtest/data/candles/NSE_FO|54452|24-04-2025/day', body: [{ ts: 1 }] },
  ])
  try {
    const res = await fetch(`${s.url}/backtest/data/candles/NSE_FO%7C54452%7C24-04-2025/day`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ ts: 1 }])
  } finally {
    await s.stop()
  }
})

test('honours custom status', async () => {
  const s = await startStubServer([{ method: 'GET', path: '/boom', status: 422, body: { message: 'bad' } }])
  try {
    const res = await fetch(`${s.url}/boom`)
    expect(res.status).toBe(422)
  } finally {
    await s.stop()
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/deepagent && bun test src/eval/stub-server.test.ts`
Expected: FAIL — `Cannot resolve module './stub-server'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/deepagent/src/eval/stub-server.ts
import type { StubRoute } from './types'

export interface StubServer {
  url: string
  stop: () => Promise<void>
}

function queryMatches(route: StubRoute, params: URLSearchParams): boolean {
  if (!route.query) return true
  for (const [k, v] of Object.entries(route.query)) {
    if (params.get(k) !== v) return false
  }
  return true
}

export async function startStubServer(routes: StubRoute[]): Promise<StubServer> {
  const byKey = new Map<string, StubRoute[]>()
  for (const r of routes) {
    const key = `${r.method} ${r.path}`
    const list = byKey.get(key) ?? []
    list.push(r)
    byKey.set(key, list)
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const pathname = decodeURIComponent(url.pathname)
      const candidates = byKey.get(`${req.method} ${pathname}`) ?? []
      const route = candidates.find((r) => queryMatches(r, url.searchParams))
      if (!route) {
        return new Response(
          JSON.stringify({ error: `no stub for ${req.method} ${pathname}` }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify(route.body ?? null), {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  return {
    url: `http://localhost:${server.port}`,
    stop: async () => {
      server.stop()
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/deepagent && bun test src/eval/stub-server.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/eval/stub-server.ts apps/deepagent/src/eval/stub-server.test.ts
git commit -m "feat(eval): stub HTTP server for offline tool execution"
```

---

### Task 3: Seeded temp workspace

**Files:**
- Create: `apps/deepagent/src/eval/workspace.ts`
- Test: `apps/deepagent/src/eval/workspace.test.ts`

**Interfaces:**
- Consumes: `WorkspaceSeedFile` from `./types`.
- Produces: `createSeededWorkspace(seed?: WorkspaceSeedFile[]): { dir: string; cleanup: () => void }`. The agent's `agent.ts` reads `process.env.AGENT_WORKSPACE_DIR`, so the runner sets that env to `dir`. `read_file` etc. then hit this real temp dir — `read_file` pagination is genuine.

- [ ] **Step 1: Write the failing test**

```ts
// apps/deepagent/src/eval/workspace.test.ts
import { test, expect } from 'bun:test'
import { createSeededWorkspace } from './workspace'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

test('creates dir + writes seed files; cleanup removes dir', () => {
  const ws = createSeededWorkspace([{ path: 'a.txt', content: 'hello' }, { path: 'sub/b.txt', content: 'nested' }])
  expect(existsSync(join(ws.dir, 'a.txt'))).toBe(true)
  expect(readFileSync(join(ws.dir, 'a.txt'), 'utf8')).toBe('hello')
  // nested path: ensure parent dir is created
  expect(existsSync(join(ws.dir, 'sub', 'b.txt'))).toBe(true)
  ws.cleanup()
  expect(existsSync(ws.dir)).toBe(false)
})

test('cleanup is idempotent (no throw on missing dir)', () => {
  const ws = createSeededWorkspace([])
  ws.cleanup()
  expect(() => ws.cleanup()).not.toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/eval/workspace.test.ts`
Expected: FAIL — `Cannot resolve module './workspace'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/deepagent/src/eval/workspace.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { WorkspaceSeedFile } from './types'

export interface SeededWorkspace {
  dir: string
  cleanup: () => void
}

export function createSeededWorkspace(seed: WorkspaceSeedFile[] = []): SeededWorkspace {
  const dir = mkdtempSync(join(tmpdir(), 'eval-ws-'))
  for (const f of seed) {
    const full = join(dir, f.path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, f.content)
  }
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/eval/workspace.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/eval/workspace.ts apps/deepagent/src/eval/workspace.test.ts
git commit -m "feat(eval): seeded temp workspace helper"
```

---

### Task 4: Assertion DSL + grader

**Files:**
- Create: `apps/deepagent/src/eval/assertions.ts`
- Test: `apps/deepagent/src/eval/assertions.test.ts`

**Interfaces:**
- Consumes: `Assertion`, `TrajectoryStep`, `AssertionResult` from `./types`.
- Produces: `gradeAssertion(a: Assertion, traj: TrajectoryStep[]): AssertionResult` and `gradeCase(assertions: Assertion[], traj: TrajectoryStep[]): AssertionResult[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/deepagent/src/eval/assertions.test.ts
import { test, expect } from 'bun:test'
import { gradeAssertion, gradeCase } from './assertions'
import type { TrajectoryStep } from './types'

const traj = (names: string[]): TrajectoryStep[] =>
  names.map((n, i) => ({ name: n, args: {}, tool_call_id: String(i) }))

test('calls: min/max bounds', () => {
  expect(gradeAssertion({ kind: 'calls', tool: 'x', min: 1 }, traj(['x'])).passed).toBe(true)
  expect(gradeAssertion({ kind: 'calls', tool: 'x', min: 2 }, traj(['x'])).passed).toBe(false)
  expect(gradeAssertion({ kind: 'calls', tool: 'x', max: 1 }, traj(['x', 'x'])).passed).toBe(false)
})

test('not_called', () => {
  expect(gradeAssertion({ kind: 'not_called', tool: 'x' }, traj(['y'])).passed).toBe(true)
  expect(gradeAssertion({ kind: 'not_called', tool: 'x' }, traj(['x'])).passed).toBe(false)
})

test('order: relative subsequence', () => {
  expect(gradeAssertion({ kind: 'order', sequence: ['a', 'c'] }, traj(['a', 'b', 'c'])).passed).toBe(true)
  expect(gradeAssertion({ kind: 'order', sequence: ['c', 'a'] }, traj(['a', 'b', 'c'])).passed).toBe(false)
})

test('arg_in / arg_not_in', () => {
  const t: TrajectoryStep[] = [{ name: 'get_ltp', args: { instrument_keys: 'NSE_EQ|INE002A01018' }, tool_call_id: '0' }]
  expect(gradeAssertion({ kind: 'arg_in', tool: 'get_ltp', arg: 'instrument_keys', values: ['NSE_EQ|INE002A01018'] }, t).passed).toBe(true)
  expect(gradeAssertion({ kind: 'arg_in', tool: 'get_ltp', arg: 'instrument_keys', values: ['other'] }, t).passed).toBe(false)
  expect(gradeAssertion({ kind: 'arg_not_in', tool: 'get_ltp', arg: 'instrument_keys', values: ['week'] }, t).passed).toBe(true)
  expect(gradeAssertion({ kind: 'arg_not_in', tool: 'get_ltp', arg: 'instrument_keys', values: ['NSE_EQ|INE002A01018'] }, t).passed).toBe(false)
})

test('arg_matches', () => {
  const t: TrajectoryStep[] = [{ name: 'sync_candles', args: { interval: '5' }, tool_call_id: '0' }]
  expect(gradeAssertion({ kind: 'arg_matches', tool: 'sync_candles', arg: 'interval', regex: '^5$' }, t).passed).toBe(true)
  expect(gradeAssertion({ kind: 'arg_matches', tool: 'sync_candles', arg: 'interval', regex: '^30$' }, t).passed).toBe(false)
})

test('first_is', () => {
  expect(gradeAssertion({ kind: 'first_is', tool: 'a' }, traj(['a', 'b'])).passed).toBe(true)
  expect(gradeAssertion({ kind: 'first_is', tool: 'b' }, traj(['a', 'b'])).passed).toBe(false)
  expect(gradeAssertion({ kind: 'first_is', tool: 'a' }, traj([])).passed).toBe(false)
})

test('custom', () => {
  const t = traj(['x', 'y'])
  expect(gradeAssertion({ kind: 'custom', label: 'len2', check: (tr) => tr.length === 2 ? { passed: true } : { passed: false, detail: 'len!=2' } }, t).passed).toBe(true)
  expect(gradeAssertion({ kind: 'custom', label: 'len3', check: (tr) => tr.length === 3 ? { passed: true } : { passed: false, detail: 'len!=3' } }, t).passed).toBe(false)
})

test('gradeCase: all-must-pass', () => {
  const t = traj(['a'])
  const results = gradeCase(
    [{ kind: 'calls', tool: 'a', min: 1 }, { kind: 'calls', tool: 'b', min: 1 }],
    t,
  )
  expect(results).toHaveLength(2)
  expect(results[0].passed).toBe(true)
  expect(results[1].passed).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/deepagent && bun test src/eval/assertions.test.ts`
Expected: FAIL — `Cannot resolve module './assertions'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/deepagent/src/eval/assertions.ts
import type { Assertion, TrajectoryStep, AssertionResult } from './types'

function callsFor(traj: TrajectoryStep[], tool: string): TrajectoryStep[] {
  return traj.filter((t) => t.name === tool)
}

export function gradeAssertion(a: Assertion, traj: TrajectoryStep[]): AssertionResult {
  switch (a.kind) {
    case 'calls': {
      const n = callsFor(traj, a.tool).length
      const ok = (a.min === undefined || n >= a.min) && (a.max === undefined || n <= a.max)
      return { assertion: a, passed: ok, detail: `${a.tool} called ${n} time(s)` }
    }
    case 'not_called': {
      const n = callsFor(traj, a.tool).length
      return { assertion: a, passed: n === 0, detail: n ? `${a.tool} called ${n} time(s)` : undefined }
    }
    case 'order': {
      let idx = 0
      for (const step of traj) {
        if (step.name === a.sequence[idx]) idx++
        if (idx === a.sequence.length) break
      }
      return { assertion: a, passed: idx === a.sequence.length, detail: `matched ${idx}/${a.sequence.length} of ${a.sequence.join(' -> ')}` }
    }
    case 'arg_in': {
      const hits = callsFor(traj, a.tool).filter((t) => a.values.includes(t.args[a.arg]))
      return { assertion: a, passed: hits.length > 0, detail: hits.length ? undefined : `${a.tool}.${a.arg} not in ${JSON.stringify(a.values)}` }
    }
    case 'arg_not_in': {
      const bad = callsFor(traj, a.tool).filter((t) => a.values.includes(t.args[a.arg]))
      return { assertion: a, passed: bad.length === 0, detail: bad.length ? `${a.tool}.${a.arg} was ${JSON.stringify(bad[0].args[a.arg])}` : undefined }
    }
    case 'arg_matches': {
      const re = new RegExp(a.regex)
      const hits = callsFor(traj, a.tool).filter((t) => re.test(String(t.args[a.arg] ?? '')))
      return { assertion: a, passed: hits.length > 0, detail: hits.length ? undefined : `${a.tool}.${a.arg} did not match /${a.regex}/` }
    }
    case 'first_is': {
      const first = traj[0]?.name
      return { assertion: a, passed: first === a.tool, detail: `first call was ${first ?? '(none)'}` }
    }
    case 'custom': {
      const r = a.check(traj)
      return { assertion: a, passed: r.passed, detail: r.detail }
    }
  }
}

export function gradeCase(assertions: Assertion[], traj: TrajectoryStep[]): AssertionResult[] {
  return assertions.map((a) => gradeAssertion(a, traj))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/deepagent && bun test src/eval/assertions.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/eval/assertions.ts apps/deepagent/src/eval/assertions.test.ts
git commit -m "feat(eval): deterministic trajectory assertion DSL + grader"
```

---

### Task 5: Seed cases

**Files:**
- Create: `apps/deepagent/src/eval/cases/instrument-resolution.ts`
- Create: `apps/deepagent/src/eval/cases/candle-sync.ts`
- Create: `apps/deepagent/src/eval/cases/read-file-pagination.ts`
- Create: `apps/deepagent/src/eval/cases/orchestration.ts`
- Create: `apps/deepagent/src/eval/cases/index.ts`
- Test: `apps/deepagent/src/eval/cases/cases.test.ts`

**Interfaces:**
- Consumes: `EvalCase` from `../types`.
- Produces: `ALL_CASES: EvalCase[]` (from `cases/index.ts`), imported by `run.ts` (default suite) and `cli.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/deepagent/src/eval/cases/cases.test.ts
import { test, expect } from 'bun:test'
import { ALL_CASES } from './index'

test('ALL_CASES non-empty with unique ids and required fields', () => {
  expect(ALL_CASES.length).toBeGreaterThan(0)
  const ids = ALL_CASES.map((c) => c.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const c of ALL_CASES) {
    expect(c.prompt.length).toBeGreaterThan(0)
    expect(Array.isArray(c.stubRoutes)).toBe(true)
    expect(c.assertions.length).toBeGreaterThan(0)
  }
})

test('all four categories are represented', () => {
  const cats = new Set(ALL_CASES.map((c) => c.category))
  expect(cats).toEqual(new Set(['instrument-resolution', 'candle-sync', 'read-file-pagination', 'orchestration']))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/eval/cases/cases.test.ts`
Expected: FAIL — `Cannot resolve module './index'`.

- [ ] **Step 3: Write the cases**

```ts
// apps/deepagent/src/eval/cases/instrument-resolution.ts
import type { EvalCase } from '../types'

export const instrumentResolutionCases: EvalCase[] = [
  {
    id: 'ir-1',
    category: 'instrument-resolution',
    prompt: 'Get the last traded price of Tata Consultancy Services.',
    stubRoutes: [
      {
        method: 'GET',
        path: '/instruments/search',
        body: { data: [{ instrument_key: 'NSE_EQ|INE002A01018', name: 'Tata Consultancy Services', trading_symbol: 'TCS' }] },
      },
      {
        method: 'GET',
        path: '/market-quote/v3/ltp',
        body: { data: { 'NSE_EQ|INE002A01018': { last_price: 3850.5 } } },
      },
    ],
    assertions: [
      { kind: 'order', sequence: ['search_instruments', 'get_ltp'] },
      { kind: 'calls', tool: 'get_ltp', min: 1 },
    ],
  },
  {
    id: 'ir-2',
    category: 'instrument-resolution',
    prompt: "What's the last traded price of NSE_EQ|INE002A01018?",
    stubRoutes: [
      { method: 'GET', path: '/market-quote/v3/ltp', body: { data: { 'NSE_EQ|INE002A01018': { last_price: 3850.5 } } } },
    ],
    assertions: [
      { kind: 'not_called', tool: 'search_instruments' },
      { kind: 'first_is', tool: 'get_ltp' },
      { kind: 'arg_in', tool: 'get_ltp', arg: 'instrument_keys', values: ['NSE_EQ|INE002A01018'] },
    ],
  },
]
```

```ts
// apps/deepagent/src/eval/cases/candle-sync.ts
import type { EvalCase } from '../types'

export const candleSyncCases: EvalCase[] = [
  {
    id: 'cs-1',
    category: 'candle-sync',
    prompt: 'Store daily candles for the expired NIFTY 26JUN60000 call option.',
    stubRoutes: [
      { method: 'POST', path: '/backtest/data/sync-expired', body: { stored: 30, chunks: 1, file: 'x.sqlite' } },
    ],
    assertions: [
      { kind: 'calls', tool: 'sync_expired_candles', min: 1 },
      { kind: 'arg_in', tool: 'sync_expired_candles', arg: 'interval', values: ['1minute', '3minute', '5minute', '15minute', '30minute', 'day'] },
      { kind: 'arg_not_in', tool: 'sync_expired_candles', arg: 'interval', values: ['week', 'month'] },
      { kind: 'not_called', tool: 'sync_candles' },
    ],
  },
  {
    id: 'cs-2',
    category: 'candle-sync',
    prompt: 'Sync 5-minute candles for NIFTY 50 (live) and store them locally.',
    stubRoutes: [
      { method: 'POST', path: '/backtest/data/sync', body: { stored: 100, chunks: 1, file: 'y.sqlite' } },
    ],
    assertions: [
      { kind: 'calls', tool: 'sync_candles', min: 1 },
      { kind: 'arg_in', tool: 'sync_candles', arg: 'source', values: ['v3'] },
      { kind: 'arg_in', tool: 'sync_candles', arg: 'unit', values: ['minutes'] },
      { kind: 'arg_matches', tool: 'sync_candles', arg: 'interval', regex: '^5$' },
    ],
  },
  {
    id: 'cs-3',
    category: 'candle-sync',
    prompt: 'Read back the daily candles I synced for the expired instrument NSE_FO|54452|24-04-2025.',
    stubRoutes: [
      {
        method: 'GET',
        path: '/backtest/data/candles/NSE_FO|54452|24-04-2025/day',
        body: [{ ts: 1, open: 100, high: 101, low: 99, close: 100.5, volume: 1000, oi: 50 }],
      },
    ],
    assertions: [
      { kind: 'calls', tool: 'read_candles', min: 1 },
      { kind: 'arg_in', tool: 'read_candles', arg: 'timeframe', values: ['day'] },
      { kind: 'arg_not_in', tool: 'read_candles', arg: 'timeframe', values: ['week', 'month'] },
    ],
  },
]
```

```ts
// apps/deepagent/src/eval/cases/read-file-pagination.ts
import type { EvalCase } from '../types'

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `Line ${i + 1}: research note ${i + 1}.`).join('\n')
}

export const readFilePaginationCases: EvalCase[] = [
  {
    id: 'rf-1',
    category: 'read-file-pagination',
    prompt: 'Read the file notes.md and give me a one-line summary of all its content.',
    workspaceSeed: [{ path: 'notes.md', content: lines(250) }],
    stubRoutes: [],
    assertions: [
      { kind: 'calls', tool: 'read_file', min: 2 },
      {
        kind: 'custom',
        label: 'paged-forward',
        check: (t) => {
          const reads = t.filter((s) => s.name === 'read_file')
          const paged = reads.some((s) => Number(s.args.offset) > 0)
          return paged ? { passed: true } : { passed: false, detail: 'no read_file call had offset > 0' }
        },
      },
    ],
  },
  {
    id: 'rf-2',
    category: 'read-file-pagination',
    prompt: 'Read the file small.md and summarize it.',
    workspaceSeed: [{ path: 'small.md', content: lines(40) }],
    stubRoutes: [],
    assertions: [
      { kind: 'calls', tool: 'read_file', min: 1 },
      {
        kind: 'custom',
        label: 'no-needless-paging',
        check: (t) => {
          const reads = t.filter((s) => s.name === 'read_file')
          const paged = reads.some((s) => Number(s.args.offset) > 0)
          return paged ? { passed: false, detail: 'paged a 40-line file unnecessarily' } : { passed: true }
        },
      },
    ],
  },
]
```

```ts
// apps/deepagent/src/eval/cases/orchestration.ts
import type { EvalCase } from '../types'

const candleBody = {
  data: { candles: Array.from({ length: 30 }, (_, i) => [i, 100, 101, 99, 100.5, 1000, 0]) },
}

export const orchestrationCases: EvalCase[] = [
  {
    id: 'or-1',
    category: 'orchestration',
    prompt: 'Compute the 14-day RSI for RELIANCE, TCS, INFY, HDFCBANK, and ITC. Return the five values.',
    stubRoutes: [
      { method: 'GET', path: '/historical-data/v2/candles', body: candleBody },
      { method: 'GET', path: '/instruments/search', body: { data: [{ instrument_key: 'NSE_EQ|RELIANCE', name: 'Reliance' }] } },
    ],
    assertions: [
      {
        kind: 'custom',
        label: 'delegated-or-batched',
        check: (t) => {
          const marketTools = new Set([
            'search_instruments', 'get_ltp', 'get_ohlc_quote', 'historical_candles',
            'intraday_candles', 'option_chain', 'market_status', 'read_candles',
            'company_profile', 'news', 'sync_candles', 'sync_expired_candles',
          ])
          const direct = t.filter((s) => marketTools.has(s.name)).length
          return direct >= 5
            ? { passed: false, detail: `${direct} direct market-data calls — should delegate/batch via task/eval` }
            : { passed: true }
        },
      },
    ],
  },
]
```

```ts
// apps/deepagent/src/eval/cases/index.ts
import type { EvalCase } from '../types'
import { instrumentResolutionCases } from './instrument-resolution'
import { candleSyncCases } from './candle-sync'
import { readFilePaginationCases } from './read-file-pagination'
import { orchestrationCases } from './orchestration'

export const ALL_CASES: EvalCase[] = [
  ...instrumentResolutionCases,
  ...candleSyncCases,
  ...readFilePaginationCases,
  ...orchestrationCases,
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/eval/cases/cases.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/eval/cases
git commit -m "feat(eval): seed cases for 4 behavior categories"
```

---

### Task 6: Trajectory capture (`captureRun`)

**Files:**
- Create: `apps/deepagent/src/eval/run.ts` (this task adds `captureRun` + `RunCapture`; Task 7 adds `runSuite`)
- Test: `apps/deepagent/src/eval/run.test.ts`

**Interfaces:**
- Consumes: `TrajectoryStep` from `./types`.
- Produces: `captureRun(stream: AsyncIterable<any>, opts: { maxTurns: number; signal?: AbortSignal }): Promise<RunCapture>` where `RunCapture = { trajectory: TrajectoryStep[]; finalAnswer: string; error?: string }`. Iterates a `streamEvents`-shaped async iterable, pushing `on_tool_start` events (name=`ev.name`, args=`ev.data.input`) to the trajectory, appending `on_chat_model_stream` text (`ev.data.chunk.content`) to `finalAnswer`, and stopping at `maxTurns` (calls `stream.return()` then breaks) or on abort.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/deepagent/src/eval/run.test.ts
import { test, expect } from 'bun:test'
import { captureRun } from './run'

async function* mockStream(events: any[]) {
  for (const e of events) yield e
}

test('captureRun collects tool starts and final answer', async () => {
  const events = [
    { event: 'on_chat_model_stream', data: { chunk: { content: 'Hi ' } } },
    { event: 'on_tool_start', name: 'search_instruments', data: { input: { q: 'TCS' } } },
    { event: 'on_chat_model_stream', data: { chunk: { content: 'there' } } },
  ]
  const cap = await captureRun(mockStream(events), { maxTurns: 8 })
  expect(cap.trajectory).toHaveLength(1)
  expect(cap.trajectory[0]).toMatchObject({ name: 'search_instruments', args: { q: 'TCS' } })
  expect(cap.finalAnswer).toBe('Hi there')
  expect(cap.error).toBeUndefined()
})

test('captureRun stops at maxTurns', async () => {
  const events = Array.from({ length: 20 }, () => ({ event: 'on_tool_start', name: 'get_ltp', data: { input: {} } }))
  const cap = await captureRun(mockStream(events), { maxTurns: 3 })
  expect(cap.trajectory).toHaveLength(3)
})

test('captureRun swallows stream errors into error field', async () => {
  async function* boom() {
    yield { event: 'on_tool_start', name: 'x', data: { input: {} } }
    throw new Error('stream blew up')
  }
  const cap = await captureRun(boom(), { maxTurns: 8 })
  expect(cap.trajectory).toHaveLength(1)
  expect(cap.error).toBe('stream blew up')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/deepagent && bun test src/eval/run.test.ts`
Expected: FAIL — `captureRun is not exported from './run'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/deepagent/src/eval/run.ts (Task 6 portion)
import type { TrajectoryStep } from './types'

export interface RunCapture {
  trajectory: TrajectoryStep[]
  finalAnswer: string
  error?: string
}

export async function captureRun(
  stream: AsyncIterable<any>,
  opts: { maxTurns: number; signal?: AbortSignal },
): Promise<RunCapture> {
  const trajectory: TrajectoryStep[] = []
  let finalAnswer = ''
  try {
    for await (const ev of stream) {
      if (opts.signal?.aborted) break
      if (ev.event === 'on_tool_start') {
        trajectory.push({
          name: ev.name,
          args: ev.data?.input ?? {},
          tool_call_id: ev.data?.tool_call_id ?? String(trajectory.length),
        })
        if (trajectory.length >= opts.maxTurns) {
          try {
            await (stream as any)?.return?.()
          } catch {
            /* ignore */
          }
          break
        }
      } else if (ev.event === 'on_chat_model_stream') {
        const chunk = ev.data?.chunk
        const text = typeof chunk?.content === 'string' ? chunk.content : ''
        if (text) finalAnswer += text
      }
    }
  } catch (err: any) {
    return { trajectory, finalAnswer, error: err?.message ?? String(err) }
  }
  return { trajectory, finalAnswer }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/deepagent && bun test src/eval/run.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/eval/run.ts apps/deepagent/src/eval/run.test.ts
git commit -m "feat(eval): streamEvents trajectory + final-answer capture"
```

---

### Task 7: Runner orchestration (`runSuite`)

**Files:**
- Modify: `apps/deepagent/src/eval/run.ts` (add `runSuite`, `runCase`, `RunSuiteOptions`)
- Test: append to `apps/deepagent/src/eval/run.test.ts`

**Interfaces:**
- Consumes: `startStubServer` (`./stub-server`), `createSeededWorkspace` (`./workspace`), `gradeCase` (`./assertions`), `captureRun` (Task 6), `ALL_CASES` (`./cases`), `buildAgent` + `AgentConfig` (`../agent`), `EvalCase`/`EvalResult` (`./types`).
- Produces: `runSuite({ cfg, cases?, categories?, buildAgentFn? }): Promise<EvalResult[]>`. `buildAgentFn` defaults to the real `buildAgent`; tests inject a fake. Sets `process.env.API_BASE_URL` + `process.env.AGENT_WORKSPACE_DIR` per case, restores them in `finally`. The `profile?` seam for sub-project B is documented as a future additive param — not added now (YAGNI for A).

- [ ] **Step 1: Write the failing tests (append to run.test.ts)**

```ts
// append to apps/deepagent/src/eval/run.test.ts
import { runSuite } from './run'
import type { EvalCase } from './types'

function fakeAgent(events: any[]) {
  return {
    streamEvents: async function* () {
      for (const e of events) yield e
    },
  }
}

test('runSuite: grades a passing case via injected fake agent', async () => {
  const events = [
    { event: 'on_tool_start', name: 'search_instruments', data: { input: { q: 'TCS' } } },
    { event: 'on_chat_model_stream', data: { chunk: { content: 'done' } } },
  ]
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
    buildAgentFn: async () => fakeAgent(events),
  })
  expect(results).toHaveLength(1)
  expect(results[0].passed).toBe(true)
  expect(results[0].trajectory[0].name).toBe('search_instruments')
  expect(results[0].finalAnswer).toBe('done')
})

test('runSuite: a failing assertion makes the case fail', async () => {
  const events = [{ event: 'on_tool_start', name: 'get_ltp', data: { input: {} } }]
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
    buildAgentFn: async () => fakeAgent(events),
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
    buildAgentFn: async () => fakeAgent([]),
  })
  expect(results.map((r) => r.caseId)).toEqual(['a'])
})

test('runSuite: restores env and cleans up after run (no leak)', async () => {
  const before = process.env.API_BASE_URL
  await runSuite({
    cfg: { provider: 'ollama', apiKey: '', baseUrl: '', model: 'x' },
    cases: [{ id: 'leak', category: 'x', prompt: 'p', stubRoutes: [], assertions: [] }],
    buildAgentFn: async () => fakeAgent([]),
  })
  expect(process.env.API_BASE_URL).toBe(before)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/deepagent && bun test src/eval/run.test.ts`
Expected: FAIL — `runSuite is not exported`.

- [ ] **Step 3: Append the implementation to run.ts**

```ts
// append to apps/deepagent/src/eval/run.ts (Task 7 portion)
import { startStubServer } from './stub-server'
import { createSeededWorkspace } from './workspace'
import { gradeCase } from './assertions'
import { ALL_CASES } from './cases'
import { buildAgent, type AgentConfig } from '../agent'
import type { EvalCase, EvalResult } from './types'

export interface RunSuiteOptions {
  cfg: AgentConfig
  cases?: EvalCase[]
  categories?: string[]
  /** Test seam: defaults to the real buildAgent. The ralph loop (C) will add a `profile?` here. */
  buildAgentFn?: (cfg: AgentConfig) => Promise<any>
}

async function runCase(c: EvalCase, cfg: AgentConfig, build: (cfg: AgentConfig) => Promise<any>): Promise<EvalResult> {
  const started = Date.now()
  const server = await startStubServer(c.stubRoutes)
  const ws = createSeededWorkspace(c.workspaceSeed)
  const prevApi = process.env.API_BASE_URL
  const prevWs = process.env.AGENT_WORKSPACE_DIR
  process.env.API_BASE_URL = server.url
  process.env.AGENT_WORKSPACE_DIR = ws.dir
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), c.timeoutMs ?? 60_000)
  try {
    const agent = await build(cfg)
    const stream = agent.streamEvents(
      { messages: [{ role: 'user', content: c.prompt }] },
      { version: 'v2', signal: controller.signal },
    )
    const cap = await captureRun(stream, { maxTurns: c.maxTurns ?? 8, signal: controller.signal })
    const assertionResults = gradeCase(c.assertions, cap.trajectory)
    return {
      caseId: c.id,
      category: c.category,
      passed: assertionResults.every((r) => r.passed) && !cap.error,
      trajectory: cap.trajectory,
      assertionResults,
      finalAnswer: cap.finalAnswer || undefined,
      error: cap.error,
      durationMs: Date.now() - started,
    }
  } catch (err: any) {
    return {
      caseId: c.id,
      category: c.category,
      passed: false,
      trajectory: [],
      assertionResults: [],
      error: err?.message ?? String(err),
      durationMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
    await server.stop()
    ws.cleanup()
    process.env.API_BASE_URL = prevApi
    process.env.AGENT_WORKSPACE_DIR = prevWs
  }
}

export async function runSuite(opts: RunSuiteOptions): Promise<EvalResult[]> {
  const all = opts.cases ?? ALL_CASES
  const filtered = opts.categories ? all.filter((c) => opts.categories!.includes(c.category)) : all
  const build = opts.buildAgentFn ?? buildAgent
  const results: EvalResult[] = []
  for (const c of filtered) {
    results.push(await runCase(c, opts.cfg, build))
  }
  return results
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/deepagent && bun test src/eval/run.test.ts`
Expected: PASS — 7 tests (3 from Task 6 + 4 here).

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/eval/run.ts apps/deepagent/src/eval/run.test.ts
git commit -m "feat(eval): runSuite orchestration (stub server + workspace + grading)"
```

---

### Task 8: Report formatters

**Files:**
- Create: `apps/deepagent/src/eval/report.ts`
- Test: `apps/deepagent/src/eval/report.test.ts`

**Interfaces:**
- Consumes: `EvalResult` from `./types`.
- Produces: `summarize(results: EvalResult[]): string` (human-readable, per-case PASS/FAIL + failing assertion detail + trajectory, summary line) and `toJson(results: EvalResult[]): string` (pretty JSON).

- [ ] **Step 1: Write the failing test**

```ts
// apps/deepagent/src/eval/report.test.ts
import { test, expect } from 'bun:test'
import { summarize, toJson } from './report'
import type { EvalResult } from './types'

const results: EvalResult[] = [
  {
    caseId: 'ir-1',
    category: 'instrument-resolution',
    passed: true,
    trajectory: [{ name: 'get_ltp', args: { instrument_keys: 'X' }, tool_call_id: '0' }],
    assertionResults: [{ assertion: { kind: 'calls', tool: 'get_ltp', min: 1 }, passed: true, detail: 'get_ltp called 1 time(s)' }],
    durationMs: 12,
  },
  {
    caseId: 'cs-1',
    category: 'candle-sync',
    passed: false,
    trajectory: [{ name: 'sync_candles', args: { source: 'v2' }, tool_call_id: '0' }],
    assertionResults: [{ assertion: { kind: 'not_called', tool: 'sync_candles' }, passed: false, detail: 'sync_candles called 1 time(s)' }],
    durationMs: 9,
  },
]

test('summarize: PASS line, FAIL line with detail + trajectory, summary', () => {
  const out = summarize(results)
  expect(out).toContain('PASS ir-1 (instrument-resolution)')
  expect(out).toContain('FAIL cs-1 (candle-sync)')
  expect(out).toContain('sync_candles called 1 time(s)')
  expect(out).toContain('sync_candles({"source":"v2"})')
  expect(out).toContain('1/2 passed')
})

test('toJson: valid JSON with expected keys', () => {
  const parsed = JSON.parse(toJson(results))
  expect(parsed).toHaveLength(2)
  expect(parsed[0].caseId).toBe('ir-1')
  expect(parsed[0].passed).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/eval/report.test.ts`
Expected: FAIL — `Cannot resolve module './report'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/deepagent/src/eval/report.ts
import type { EvalResult } from './types'

export function summarize(results: EvalResult[]): string {
  const passed = results.filter((r) => r.passed).length
  const blocks = results.map((r) => {
    const head = `${r.passed ? 'PASS' : 'FAIL'} ${r.caseId} (${r.category}) — ${r.assertionResults.length} assertions, ${r.durationMs}ms`
    if (r.passed) return head
    const fails = r.assertionResults
      .filter((a) => !a.passed)
      .map((a) => `    ✗ ${a.detail ?? '(no detail)'}`)
      .join('\n')
    const traj = r.trajectory
      .map((t) => `    ${t.name}(${JSON.stringify(t.args)})`)
      .join('\n')
    const err = r.error ? `\n  error: ${r.error}` : ''
    return `${head}\n  failing assertions:\n${fails}\n  trajectory:\n${traj}${err}`
  })
  return `${blocks.join('\n')}\n\n${passed}/${results.length} passed`
}

export function toJson(results: EvalResult[]): string {
  return JSON.stringify(results, null, 2)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/eval/report.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/eval/report.ts apps/deepagent/src/eval/report.test.ts
git commit -m "feat(eval): human + JSON report formatters"
```

---

### Task 9: CLI + `eval` script

**Files:**
- Create: `apps/deepagent/src/eval/cli.ts`
- Test: `apps/deepagent/src/eval/cli.test.ts`
- Modify: `apps/deepagent/package.json` (add `eval` script)

**Interfaces:**
- Consumes: `runSuite` (`./run`), `summarize`/`toJson` (`./report`), `ALL_CASES` (`./cases`), `resolveAgentConfig` + `AgentConfig` (`../agent`).
- Produces: `parseArgs(argv: string[]): CliArgs` (pure, testable) + `main()` (side-effectful). Flags: `--provider --model --apiKey --baseUrl`, `--from-settings`, `--category <cat>` (repeatable), `--case <id>`, `--json`, `--out <file>`. Exits 1 if any case failed.

- [ ] **Step 1: Write the failing test**

```ts
// apps/deepagent/src/eval/cli.test.ts
import { test, expect } from 'bun:test'
import { parseArgs } from './cli'

test('parseArgs: model + provider + json + out', () => {
  const a = parseArgs(['--provider', 'ollama', '--model', 'llama3', '--json', '--out', 'r.json'])
  expect(a).toMatchObject({ provider: 'ollama', model: 'llama3', json: true, out: 'r.json' })
})

test('parseArgs: repeatable --category', () => {
  const a = parseArgs(['--category', 'candle-sync', '--category', 'orchestration'])
  expect(a.categories).toEqual(['candle-sync', 'orchestration'])
})

test('parseArgs: --case selects one id', () => {
  const a = parseArgs(['--case', 'cs-1'])
  expect(a.caseId).toBe('cs-1')
})

test('parseArgs: --from-settings flag', () => {
  expect(parseArgs(['--from-settings']).fromSettings).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/eval/cli.test.ts`
Expected: FAIL — `parseArgs is not exported`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/deepagent/src/eval/cli.ts
import { writeFileSync } from 'node:fs'
import { runSuite } from './run'
import { summarize, toJson } from './report'
import { ALL_CASES } from './cases'
import { resolveAgentConfig, type AgentConfig } from '../agent'

export interface CliArgs {
  provider?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  fromSettings?: boolean
  categories: string[]
  caseId?: string
  json?: boolean
  out?: string
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { categories: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--provider': out.provider = argv[++i]; break
      case '--model': out.model = argv[++i]; break
      case '--apiKey': out.apiKey = argv[++i]; break
      case '--baseUrl': out.baseUrl = argv[++i]; break
      case '--from-settings': out.fromSettings = true; break
      case '--category': out.categories.push(argv[++i]); break
      case '--case': out.caseId = argv[++i]; break
      case '--json': out.json = true; break
      case '--out': out.out = argv[++i]; break
    }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let cfg: AgentConfig
  if (args.fromSettings) {
    cfg = resolveAgentConfig()!
    if (!cfg) {
      console.error('No agent settings. Configure via apps/web /settings (writes apps/api/data/agent-settings.json).')
      process.exit(1)
    }
  } else {
    cfg = {
      provider: (args.provider as AgentConfig['provider']) ?? 'ollama',
      apiKey: args.apiKey ?? '',
      baseUrl: args.baseUrl ?? '',
      model: args.model ?? '',
    }
    if (!cfg.model) {
      console.error('--model is required (or use --from-settings)')
      process.exit(1)
    }
  }
  const cases = args.caseId ? ALL_CASES.filter((c) => c.id === args.caseId) : ALL_CASES
  const results = await runSuite({ cfg, cases, categories: args.categories.length ? args.categories : undefined })
  console.log(args.json ? toJson(results) : summarize(results))
  writeFileSync(args.out ?? 'src/eval/results-latest.json', toJson(results))
  process.exit(results.some((r) => !r.passed) ? 1 : 0)
}

main()
```

- [ ] **Step 4: Add the eval script to package.json**

In `apps/deepagent/package.json`, add to `scripts` (keep existing keys):

```json
"eval": "bun run src/eval/cli.ts"
```

The resulting `scripts` block:

```json
"scripts": {
  "dev": "bun run --watch src/index.ts",
  "build": "bun build src/index.ts --outdir dist --target bun",
  "start": "bun run src/index.ts",
  "eval": "bun run src/eval/cli.ts"
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/eval/cli.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Run the whole eval test suite to confirm everything passes**

Run: `cd apps/deepagent && bun test src/eval`
Expected: PASS — all tests across stub-server, workspace, assertions, cases, run, report, cli.

- [ ] **Step 7: Smoke-verify the CLI wires together (dry, no LLM required for parse-only)**

Run: `cd apps/deepagent && bun run src/eval/cli.ts --help 2>&1 || true`
Expected: runs without a module-resolution error (parseArgs ignores unknown `--help`; main then errors on missing `--model` with the expected message). Confirms the import graph (`run` → `cases` → `report` → `agent`) resolves.

- [ ] **Step 8: Commit**

```bash
git add apps/deepagent/src/eval/cli.ts apps/deepagent/src/eval/cli.test.ts apps/deepagent/package.json
git commit -m "feat(eval): CLI + eval script for running the suite"
```

---

## End-to-end smoke run (manual, after all tasks)

Once a model is configured (e.g. ollama running `llama3`, or a hosted provider via `--from-settings`), run the real suite:

```bash
cd apps/deepagent
bun run src/eval/cli.ts --from-settings
# or: bun run src/eval/cli.ts --provider ollama --model llama3
# or one category: bun run src/eval/cli.ts --from-settings --category candle-sync --json
```

Expected: per-case PASS/FAIL lines + `X/8 passed`; `src/eval/results-latest.json` written; exit 0 if all pass, 1 otherwise. The first run establishes the **baseline score** (sub-project A's standalone deliverable) that sub-project C will try to improve.

## Notes for B and C (out of scope here)

- **B (harness profile):** add `Profile` type + `buildAgent(cfg, profile?)` (system-prompt suffix, middleware toggles, tool exclusions); add `profile?` to `RunSuiteOptions` and thread it into `buildAgentFn`. The `runSuite` seam is already in place.
- **C (ralph loop):** a script that imports `runSuite`, gives a frontier-model proposer agent write access to a profile file, runs the suite, keeps the profile only if it passes `verify-runs` consecutive times, else rolls back; iterate to `max-iters`. Reuses `runSuite`'s `EvalResult[]` exactly.