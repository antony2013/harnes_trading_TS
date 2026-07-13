# Eval Harness v3 Streaming Upgrade — Design

**Date:** 2026-07-13
**Status:** Design approved by user ("ok pannu")
**Scope:** Upgrade `apps/deepagent/src/eval/` `captureRun` from LangChain Deep Agents streamEvents **v2** (raw `on_tool_start` / `on_chat_model_stream` events) to **v3** (projection-oriented `run.messages` / `run.toolCalls` / `run.subagents`), so the trajectory captures **subagent-internal tool calls**, scope-tagged.

## Background

Sub-project A (eval harness) merged to main at `325c666`. Its `captureRun` consumes `agent.streamEvents({ messages }, { version: 'v2', signal })` and reads raw events. The LangChain Deep Agents event-streaming docs describe a v3 projection API available in the installed `deepagents@1.10.5` (type defs: *"Pass `version: "v3"` to opt into this projection-oriented stream… This v3 stream is experimental and its API may change in future releases"*). v3 returns a `DeepAgentRunStream` exposing:

- `run.messages` — async iterable of coordinator messages; each `msg.text` is an async iterable of token strings.
- `run.toolCalls` — async iterable of `{ name, input (sync), status (Promise), output (Promise), error (Promise) }` (coordinator-level tool calls).
- `run.subagents` — async iterable of `{ name, messages, toolCalls, subagents (nested), output }` (each delegated `task`).

The user chose to upgrade `captureRun` to v3 (not the chat UI; `apps/api` agent SSE stays on v2, untouched). The load-bearing decision, approved by the user: the trajectory captures **subagent-internal tool calls, scope-tagged** (not coordinator-only).

## Why upgrade (the latent or-1 bug)

v2 `streamEvents` fires `on_tool_start` for **all** tool calls in the execution graph, including tool calls made **inside a delegated subagent** (they carry a subgraph namespace, which v2 `captureRun` ignores). So the current `captureRun` already captures subagent-internal calls — but **untagged**. The or-1 `delegated-or-batched` assertion counts every `marketTools`-named call as "direct":

```ts
const direct = t.filter((s) => marketTools.has(s.name)).length
return direct >= 5 ? { passed: false, detail: … } : { passed: true }
```

If the agent delegates the 5-stock RSI compute to the `quant` subagent (the desired behavior), the quant subagent makes ~5 internal market-data calls; v2 captures them untagged → `direct >= 5` → the case **FAILS the very delegation it is meant to reward**. This never surfaced because no eval case has run against a real LLM (no key in env; unit tests use injected fakes with no subagents). The v3 upgrade scope-tags calls so or-1 can count only coordinator-level direct calls and treat subagent-internal calls as delegated.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Trajectory scope | **Full, scope-tagged** — coordinator + every subagent's tool calls, each tagged with `scope` ('coordinator' or subagent name) |
| `TrajectoryStep` change | Add `scope?: string` (default 'coordinator') — backward-compatible |
| Grader (`assertions.ts`) | Unchanged — stays scope-agnostic (matches by `name`); scope-aware filtering is done in `custom` assertions (or-1) |
| maxTurns / timeout | One shared `AbortController` (already in `runCase`); reaching `maxTurns` calls `controller.abort()`; abort (cap or timeout) = clean partial stop, no `error`; real stream throw = `error` set |
| `apps/api` agent SSE | Untouched (stays v2) |
| v3 experimental risk | Accepted — eval harness is dev tooling; `deepagents@1.10.5` pinned; fix-on-upgrade if v3 breaks |

## Architecture

### `types.ts` — `TrajectoryStep`

```ts
export interface TrajectoryStep {
  name: string
  args: Record<string, any>
  tool_call_id: string
  scope?: string   // 'coordinator' (default) or the subagent name; absent == 'coordinator'
}
```

Optional, so existing assertions and the grader work unchanged. Only `custom` assertions that need to distinguish delegation read `scope`.

### `run.ts` — `captureRun` rewrite

```ts
export async function captureRun(
  run: any, // DeepAgentRunStream from agent.streamEvents({ messages }, { version: 'v3', signal })
  opts: { maxTurns: number; signal?: AbortSignal; abort?: () => void },
): Promise<RunCapture> {
  const trajectory: TrajectoryStep[] = []
  let finalAnswer = ''
  let abortedByCap = false

  const push = (scope: string, name: string, input: any) => {
    trajectory.push({ name, args: input ?? {}, tool_call_id: String(trajectory.length), scope })
    if (trajectory.length >= opts.maxTurns && !abortedByCap) {
      abortedByCap = true
      opts.abort?.() // runCase passes () => controller.abort() — cancels the v3 stream
    }
  }
```

`captureRun` cannot abort via `signal` alone (you can only abort a signal through its owning controller, which lives in `runCase`). So `runCase` passes `abort: () => controller.abort()` alongside `signal`. When `maxTurns` is reached, `push` calls `opts.abort()`; the v3 iterables throw on their next yield; `Promise.all` rejects; the catch sees `signal.aborted === true` → clean partial stop, no `error`.

Three concurrent consumers via `Promise.all`:

1. **Messages** (coordinator final answer):
   ```ts
   for await (const msg of run.messages) {
     for await (const token of msg.text) finalAnswer += token
   }
   ```
2. **Coordinator tool calls**:
   ```ts
   for await (const call of run.toolCalls) push('coordinator', call.name, call.input)
   ```
3. **Subagents** (recursive):
   ```ts
   for await (const sub of run.subagents) consumeSubagent(sub, sub.name)
   // consumeSubagent: for await (call of sub.toolCalls) push(subName, call.name, call.input);
   //                  for await (nested of sub.subagents) consumeSubagent(nested, nested.name)
   ```

On `Promise.all` rejection: if `opts.signal?.aborted` → clean partial stop, no `error` (covers maxTurns cap + timeout). Else → `error = err.message`. Returns `{ trajectory, finalAnswer, error? }`.

### `run.ts` — `runCase` change

Single line: `{ version: 'v2', signal }` → `{ version: 'v3', signal }`. The resulting `DeepAgentRunStream` is passed to `captureRun` (was the v2 raw stream). The shared `AbortController` already in `runCase` is reused for both `timeoutMs` and the new `maxTurns` cap. `runCase` passes `captureRun` an extra `abort: () => controller.abort()` alongside `signal` so `captureRun` can trigger the cap (it cannot abort the signal it merely observes).

### `cases/orchestration.ts` — or-1 re-scope

```ts
const direct = t.filter((s) => marketTools.has(s.name) && s.scope === 'coordinator').length
return direct >= 5
  ? { passed: false, detail: `${direct} direct coordinator market-data calls — should delegate/batch via task/eval` }
  : { passed: true }
```

Delegation via `task` → coordinator sees only the `task` call (not in `marketTools`) → passes. Five direct coordinator market-data calls → fails. Subagent-internal market-data calls (scope = 'quant' etc.) are delegated → excluded from the count.

### `run.test.ts` — test seam rewrite

Replace the v2 raw-event `fakeAgent(events)` with a `v3Stream(...)` helper returning the projection shape:

```ts
function v3Stream(spec: {
  messages?: string[]              // coordinator message tokens (concatenated → finalAnswer)
  toolCalls?: Array<{ name: string; input?: any }>
  subagents?: Array<{ name: string; toolCalls?: Array<{ name: string; input?: any }> }>
}): any
```

- `messages` is an async iterable of `{ text: AsyncIterable<string> }` — the helper emits one message whose `.text` async-iterable yields each `string[]` entry as a token (concatenated → `finalAnswer`).
- `toolCalls` is an async iterable of `{ name, input, status: Promise<"finished">, output: Promise<...> }`.
- `subagents` is an async iterable of `{ name, toolCalls: AsyncIterable, messages: AsyncIterable, subagents: AsyncIterable }`.

Rewrite the 8 existing tests (`captureRun collects tool starts + final answer`, `stops at maxTurns`, `swallows stream errors`, `runSuite passing/failing/categories/leak`) to v3-shaped fakes. The assertions stay the same (trajectory names/args, finalAnswer, maxTurns cap, error field, env restore). Add one new test: `captureRun` captures subagent-internal tool calls tagged with the subagent name (locks the v3 benefit).

## What does NOT change

`assertions.ts` grader, `report.ts`, `cli.ts`, `stub-server.ts`, `workspace.ts`, the 7 non-orchestration cases (no subagents → trajectory identical to v2), `EvalCase` / `EvalResult` shapes (only `TrajectoryStep` gains an optional field), `apps/api` agent SSE (stays v2), `apps/web` chat (untouched).

## Testing

- LLM-free unit tests (the existing pattern): `run.test.ts` with `v3Stream` fakes. 8 existing tests rewritten + 1 new subagent-trajectory test. Deterministic, no LLM.
- `bun test src/eval` green; `bun test` (full deepagent) green.
- End-to-end smoke (real LLM) remains deferred (no key) — unchanged from sub-project A.

## Out of scope

- Chat UI subagent streaming (`stream.subagents` → coordinator/subagent cards) — deferred (separate decision).
- `apps/api` agent SSE v2→v3 migration — untouched.
- Capturing tool `output`/`status` in the trajectory (we capture `name` + `input` only, matching v2 semantics) — could be a later enhancement if a future assertion needs tool results.
- Scope-aware filtering in the declarative assertion kinds (`calls`, `not_called`, `order`, …) — kept scope-agnostic; scope-aware logic lives in `custom` assertions for now.