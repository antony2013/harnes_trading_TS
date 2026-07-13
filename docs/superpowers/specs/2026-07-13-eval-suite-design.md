# Eval Suite + Ralph-Loop Tuning — Design (Sub-project A: Eval Harness)

**Date:** 2026-07-13
**Status:** Design approved; pending implementation plan
**Scope:** Sub-project A only (eval harness). B (harness profile) and C (ralph loop) get separate specs.

## Background

The deepagent (`apps/deepagent`) is a LangChain Deep Agents trading assistant for the Indian stock market backed by the local Upstox trading API. Today it has 13 tools, a provider-switchable model config (`AgentConfig`), 3 middlewares (code interpreter, coerce-tool-content, read-file-continuation), 3 subagents, a CLI (`src/index.ts`) and an HTTP chat route (`apps/api/src/modules/agent/index.ts`). Behavioral correctness is untested — `agent.test.ts` covers config/middleware/subagent wiring only.

Goal (user request): build an **eval suite** and set up **ralph-loop-style tuning**, inspired by the NVIDIA LangChain Deep Agents harness-profile article. The article's loop needs three things: a way to run evaluations with per-test pass/fail + trajectories, a programmatically-editable harness profile, and a frontier-quality proposer model. This decomposes into three sub-projects:

- **A. Eval harness** — run the agent against cases, capture trajectory, grade pass/fail, report a score. *(this spec)*
- **B. Harness profile** — an editable config (system-prompt suffix, middleware toggles, tool exclusions) that `buildAgent` reads. *(separate spec)*
- **C. Ralph loop** — frontier-model proposer edits the profile → run evals → keep if it passes N× → else roll back → repeat. Needs A + B. *(separate spec)*

Order: A first (delivers a baseline score standalone), then B, then C.

## Decisions (locked during brainstorm)

| Decision | Choice |
|---|---|
| What to evaluate | Tool-selection correctness — offline/stubbed tools, no live Upstox calls, no auth, no market-hours dependency |
| Grading | Deterministic trajectory assertions (no LLM judge) — cheap, reproducible loop fuel |
| Stubbing | Local stub HTTP server (Bun.serve) + real temp workspace; trajectory captured from `streamEvents` `on_tool_start` |
| Case format | Declarative typed TS case files + importable runner lib + CLI |
| v1 coverage | Instrument resolution + quoting; candle sync (esp. expired intervals); read_file pagination; subagent/eval orchestration |

## Architecture

**Location:** `apps/deepagent/eval/` — inside the existing workspace package, not exported from the package main (dev tooling). New `eval` script in `apps/deepagent/package.json`.

```
apps/deepagent/eval/
  types.ts            EvalCase, StubRoute, Assertion, TrajectoryStep, EvalResult
  cases/
    instrument-resolution.ts
    candle-sync.ts
    read-file-pagination.ts
    orchestration.ts
    index.ts          exports all cases (the suite)
  stub-server.ts      ephemeral Bun.serve returning canned routes per case
  workspace.ts        mkdtemp + seed files + cleanup
  assertions.ts       assertion DSL + grader over a trajectory
  run.ts              runSuite({ cfg, cases?, categories? }) -> EvalResult[]
  cli.ts              bun run eval/cli.ts [--provider/--model/...] [--category] [--json]
  report.ts           human + JSON formatter
  eval.test.ts        unit tests for stub-server + assertions (deterministic, no LLM)
```

### Forward seams (so B and C plug in without refactor)

- `runSuite` returns `EvalResult[]` — per-case `passed` + full `trajectory` + per-assertion results. This is exactly the "run evals, get per-test pass/fail + trajectories" interface the ralph loop (C) requires.
- `EvalCase` is a pure data object (the only code in a case is optional `custom` assertion predicates). Declarative assertions are serializable so the loop can name *which assertion* failed.
- B adds an optional `profile?: Profile` param threaded into `buildAgent`; `runSuite`'s signature is written so adding `profile?` later is an additive, non-breaking change. For A, `runSuite({ cfg })` runs the default harness — that's the baseline.

### Why inside `apps/deepagent`, not a new workspace package

The runner imports `buildAgent` + tool schemas; colocating avoids new-package setup. `eval/` is excluded from the package's published entrypoint.

## Case format + assertion DSL (`types.ts`)

```ts
type HttpMethod = 'GET' | 'POST'

interface StubRoute {
  method: HttpMethod
  path: string                       // exact, e.g. '/instruments/search'
  query?: Record<string, string>     // optional query match; omit = match any query
  status?: number                    // default 200
  body: unknown                      // canned JSON returned
}

interface WorkspaceSeedFile { path: string; content: string }

interface TrajectoryStep {
  name: string
  args: Record<string, any>
  tool_call_id: string
}

type Assertion =
  | { kind: 'calls'; tool: string; min?: number; max?: number }
  | { kind: 'not_called'; tool: string }
  | { kind: 'order'; sequence: string[] }            // these tools called in this relative order
  | { kind: 'arg_in'; tool: string; arg: string; values: unknown[] }
  | { kind: 'arg_not_in'; tool: string; arg: string; values: unknown[] }
  | { kind: 'arg_matches'; tool: string; arg: string; regex: string }
  | { kind: 'first_is'; tool: string }              // first tool call overall == this
  | {
      kind: 'custom'
      label: string
      check: (t: TrajectoryStep[]) => { passed: boolean; detail?: string }
    }

interface EvalCase {
  id: string
  category: string
  prompt: string
  stubRoutes: StubRoute[]
  workspaceSeed?: WorkspaceSeedFile[]
  assertions: Assertion[]
  maxTurns?: number        // default 8 tool calls
  timeoutMs?: number       // default 60_000
}

interface EvalResult {
  caseId: string
  category: string
  passed: boolean
  trajectory: TrajectoryStep[]
  assertionResults: Array<{ assertion: Assertion; passed: boolean; detail?: string }>
  finalAnswer?: string
  error?: string
  durationMs: number
}
```

The `custom` predicate is the escape hatch for cross-tool/count checks (e.g. "read_file offset strictly increases across calls", "fewer than N direct tool calls before a `task`") that don't fit a neat declarative kind. Declarative kinds cover the 80% and stay serializable so the loop can name what failed.

## Runner internals (`run.ts`, `stub-server.ts`, `workspace.ts`)

`runSuite({ cfg, cases?, categories? })` runs each matching case:

1. `startStubServer(case.stubRoutes)` → ephemeral port; set `process.env.API_BASE_URL` to its URL. Unmatched routes → 404 `{ error: 'no stub for <method> <path>' }`.
2. `mkdtemp` workspace, seed `case.workspaceSeed` files; set `process.env.AGENT_WORKSPACE_DIR`. Filesystem tools (`read_file`, etc.) hit this real temp dir — so `read_file` pagination is genuine, and the `ReadFileContinuationNoticeMiddleware` fires on real large files.
3. `buildAgent(cfg)` (default harness; profile slot added in B).
4. `agent.streamEvents({ messages: [{ role: 'user', content: case.prompt }] }, { version: 'v2', signal })` — capture `on_tool_start` → `TrajectoryStep` (`name` + `input`); capture the final assistant text. Enforce `maxTurns` (count `on_tool_start`, call `stream.return()` at cap) and `timeoutMs` (AbortSignal).
5. `finally`: stop the stub server, `rm -rf` the temp workspace. Never leaks.
6. Grade: run `assertions` over the trajectory → `assertionResults`; `passed = all(assertionResults.passed)`.
7. Return `EvalResult`.

**Offline scope:** "offline" = no Upstox network. The LLM is real (the model under test — that's what we evaluate). `cfg` is an `AgentConfig` (provider/model/key/baseUrl), supplied via CLI flags or read from `agent-settings.json`.

### Stub server matching

Routes matched by `method` + exact `path` + optional `query` (all specified query params must match; unspecified query = match any). Returns canned `body` as JSON with `status`. Unmatched → 404 JSON error. The agent's tools build URLs as `new URL(API_BASE_URL + path)` then set query params, so the stub receives path + query string directly.

## Seed cases (v1 suite)

One entry per case in its category file.

### `cases/instrument-resolution.ts`
- **`ir-1`** — "Get the LTP of Tata Consultancy Services." → `order ['search_instruments','get_ltp']`. Stubs `/instruments/search` (returns TCS, key `NSE_EQ|INE002A01018`) and `/market-quote/v3/ltp`.
- **`ir-2`** — "What's the LTP of NSE_EQ|INE002A01018?" (key given) → `not_called search_instruments`; `arg_in get_ltp.instrument_keys ['NSE_EQ|INE002A01018']`; `first_is get_ltp`.

### `cases/candle-sync.ts`
- **`cs-1`** — "Store daily candles for the expired NIFTY 26JUN60000 CE." → `calls sync_expired_candles`; `arg_in sync_expired_candles.interval ['1minute','3minute','5minute','15minute','30minute','day']`; `arg_not_in sync_expired_candles.interval ['week','month']`; `not_called sync_candles`. Locks in the expired-interval fix.
- **`cs-2`** — "Sync 5-min candles for NIFTY 50 live, store them." → `calls sync_candles`; `arg_in sync_candles.source ['v3']`; `arg_in sync_candles.unit ['minutes']`; `arg_matches sync_candles.interval /^5$/`.
- **`cs-3`** — "Read back the daily candles I synced for the expired contract." → `calls read_candles`; `arg_in read_candles.timeframe ['1minute','3minute','5minute','15minute','30minute','day']`.

### `cases/read-file-pagination.ts`
- **`rf-1`** — workspace seeded with a 250-line `notes.md`; "Read `notes.md` and summarize all of it." → `calls read_file min 2`; `custom` asserts at least one `read_file` call has `offset > 0` (paged). Locks in the `ReadFileContinuationNoticeMiddleware`.
- **`rf-2`** — workspace with a 40-line `small.md`; "Summarize `small.md`." → `calls read_file`; `custom` asserts no `read_file` call has `offset > 0` (no needless paging).

### `cases/orchestration.ts`
- **`or-1`** — "Compute 14-day RSI for RELIANCE, TCS, INFY, HDFCBANK, ITC." → `calls task` (delegates to quant) OR `calls eval` (batches); `custom` asserts the agent did NOT make ≥5 direct market-data tool calls (i.e. it delegated/batched rather than 5× single-turn fetches). Stubs return canned candle JSON.

## CLI + output

**CLI** (`bun run eval/cli.ts`): flags `--provider --model --apiKey --baseUrl` (or `--from-settings` to read `agent-settings.json`), `--category <cat>`, `--case <id>`, `--json`, `--out <file>`. Default runs all cases, prints a human summary, and writes `eval/results-latest.json`.

**Human output** — per case: `PASS/FAIL <id> (<category>) — K assertions, Xms`; on FAIL, the failing assertion's `detail` + the captured trajectory (`name(args)` list). Summary: `X/Y passed (Zms)`.

**JSON output** — full `EvalResult[]`.

## Error handling + timeouts

- Per-case `timeoutMs` (default 60s) via `AbortSignal` on `streamEvents`.
- Per-case `maxTurns` cap (default 8 tool calls) via counting `on_tool_start` and calling `stream.return()` at the cap.
- Agent throw → `passed: false`, `error` set, partial trajectory kept up to the throw.
- Stub server stopped + temp workspace removed in `finally` — never leaks across pass/fail/throw/timeout.
- Unstubbed route → 404 with a helpful message; the agent sees the error and can correct (this itself is observable in the trajectory).

## Testing the harness (`eval.test.ts`)

Deterministic unit tests, no LLM:
- Stub-server route matching (method + path + query) and 404 for unmatched.
- Every assertion kind's pass and fail path (`calls`, `not_called`, `order`, `arg_in`, `arg_not_in`, `arg_matches`, `first_is`, `custom`).
- The grader aggregates `passed` correctly (all-must-pass; one fail → case fail).

An end-to-end smoke run is a CLI invocation, not a unit test — guarded by an `EVAL_SMOKE_MODEL` env so it's opt-in (no LLM in the default test run).

## Out of scope (deferred to B / C)

- Harness `Profile` type, `buildAgent` profile param, profile file format (B).
- Ralph loop: proposer agent, snapshot/rollback, verify-runs, iteration caps (C).
- LLM-judge grading (not needed for v1; deterministic assertions suffice).
- Recorded Upstox fixtures / live-API eval modes (deferred; v1 is offline/stubbed only).