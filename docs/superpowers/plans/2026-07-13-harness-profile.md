# Harness Profile System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Externalize the deepagent harness configuration from hardcoded `agent.ts` into JSONC profile files loaded by `buildAgent` keyed by provider+model, so the profile file becomes the sole writable target for the future Ralph loop.

**Architecture:** A 4-level resolution chain (compiled-in `DEFAULT_PROFILE_DATA` → `profiles/default.jsonc` → `profiles/<provider>__default.jsonc` → `profiles/<provider>__<model>.jsonc`) deep-merged into a validated `ProfileData`, then resolved (`resolveProfile`) into real Tool objects + built middleware, then assembled into the system prompt. Two stages: `loadProfile` (validated pure data) → `resolveProfile` (objects + middleware). Runtime (`buildModel`/`buildBackend`/workspace/tool+middleware *implementations*) stays code; only the tunable *configuration* moves to data. `buildAgent(cfg: AgentConfig)` signature unchanged.

**Tech Stack:** Bun 1.3.14 + TypeScript, `deepagents@1.10.5`, `@langchain/quickjs`, `bun:test`. **New dep:** `ajv` (JSON Schema draft 2020-12 validation).

## Global Constraints

- Location: new code under `apps/deepagent/src/profiles/`; data under `apps/deepagent/profiles/` (outside `src/`, loaded via fs at runtime — deepagent tsconfig `include: ["src"]`, `rootDir: "./src"`).
- New dependency: `ajv` only, added via `bun add ajv` (never hand-write `package.json`). No other new deps.
- Behavior-preserving: loading `default.jsonc` and resolving must produce an agent identical to today's (locked by a byte-for-byte `assembleBase` test + a "load default → equals today's invariants" test).
- No `apps/api` change (`buildAgent` signature unchanged). No `apps/web` change. Eval suite (`apps/deepagent/src/eval/*`) unchanged.
- `buildAgent(cfg: AgentConfig)` signature unchanged — CLI (`src/index.ts`) and eval (`src/eval/run.ts` via `buildAgentFn`) callers untouched.
- Security boundary stays code: `WORKSPACE_PERMISSIONS`, `workspaceDir`, `buildBackend` are NOT ralph-tunable. Profile references registered names only — never `eval` of profile content.
- `profileVersion` is metadata (`const: 1`), not ralph-tunable.
- Existing invariants preserved: `PTC_ALLOWLIST` = 10 tools excluding `sync_candles`+`call_api`; `READ_ONLY_TOOLS` derived from it; 3 named subagents; quant has middleware, general-purpose+reporter none; `readFileContinuation` notice behavior.
- Spec: `docs/superpowers/specs/2026-07-13-harness-profile-design.md` (approved, commit `2618ade`). Spec's block list ("~11") is approximate — the plan splits blocks one-per-source-line (12) to preserve byte-for-byte fidelity to today's `SYSTEM_PROMPT`; the byte-for-byte test is authoritative.

---

## File Structure

```
apps/deepagent/
  profiles/                              # data dir (outside src/)
    default.jsonc                        # seeded verbatim from today's hardcoded values (Task 6)
  src/
    agent.ts                             # thinned in Task 7: buildModel, buildAgent, resolveAgentConfig, workspace, buildBackend, todayIST
    profiles/                            # NEW
      schema.json                        # JSON Schema (Task 2)
      types.ts                           # ProfileData, ResolvedProfile, SubagentSpec, PromptSpec(future) (Task 2)
      parse-jsonc.ts                     # comment-strip + JSON.parse (Task 1)
      blocks.ts                          # BLOCKS registry + BASE_BLOCK_ORDER + assembleBase (Task 3)
      prompt.ts                          # assembleSystemPrompt — the evolution seam (Task 3)
      implementations.ts                 # 3 middleware impls moved from agent.ts, unchanged (Task 4)
      middleware.ts                      # MIDDLEWARE_REGISTRY (Task 4)
      defaults.ts                        # DEFAULT_PROFILE_DATA compiled-in floor (Task 5)
      resolve.ts                         # resolveProfile + resolveTools (Task 5)
      loader.ts                           # loadProfile: 4-level chain + merge + validation (Task 6)
      index.ts                           # re-exports (Task 6)
      parse-jsonc.test.ts                # Task 1
      blocks.test.ts                     # Task 3
      middleware.test.ts                 # Task 4
      resolve.test.ts                    # Task 5
      loader.test.ts                     # Task 6
    agent.test.ts                        # updated Task 4 (imports) + Task 7 (assert via default profile)
```

---

### Task 1: JSONC parser

**Files:**
- Create: `apps/deepagent/src/profiles/parse-jsonc.ts`
- Test: `apps/deepagent/src/profiles/parse-jsonc.test.ts`

**Interfaces:**
- Produces: `parseJsonc(text: string): unknown` — strips `//` line comments and `/* */` block comments (not inside strings), then `JSON.parse`. Throws on malformed JSON after stripping.

- [ ] **Step 1: Write the failing test**

```ts
// apps/deepagent/src/profiles/parse-jsonc.test.ts
import { test, expect } from 'bun:test'
import { parseJsonc } from './parse-jsonc'

test('parseJsonc: parses plain JSON', () => {
  expect(parseJsonc('{"a":1}')).toEqual({ a: 1 })
})

test('parseJsonc: strips // line comments', () => {
  expect(parseJsonc('{\n  // a comment\n  "a": 1\n}')).toEqual({ a: 1 })
})

test('parseJsonc: strips /* block */ comments', () => {
  expect(parseJsonc('{\n  /* multi\n     line */\n  "a": 1\n}')).toEqual({ a: 1 })
})

test('parseJsonc: does not strip // or /* inside strings', () => {
  expect(parseJsonc('{"url":"https://x/y","c":"a // b"}')).toEqual({ url: 'https://x/y', c: 'a // b' })
})

test('parseJsonc: throws on malformed JSON after stripping', () => {
  expect(() => parseJsonc('{\n  // comment\n  "a":\n}')).toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/profiles/parse-jsonc.test.ts`
Expected: FAIL — `Cannot find module './parse-jsonc'`

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/deepagent/src/profiles/parse-jsonc.ts
/** Parse JSONC (JSON with comments) by stripping // and /* */ comments that are
 *  not inside strings, then JSON.parse. No dependency. */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 2; continue }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') { inString = true; out += ch; i += 1; continue }
    if (ch === '/' && next === '/') {
      // line comment: skip to end of line
      i += 2
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      // block comment: skip to */
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return JSON.parse(out)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/profiles/parse-jsonc.test.ts`
Expected: PASS — 5 pass

- [ ] **Step 5: Commit**

```bash
git add apps/deepagent/src/profiles/parse-jsonc.ts apps/deepagent/src/profiles/parse-jsonc.test.ts
git commit -m "feat(profiles): add JSONC parser (comment-strip + JSON.parse)"
```

---

### Task 2: Types + JSON Schema + ajv

**Files:**
- Create: `apps/deepagent/src/profiles/types.ts`
- Create: `apps/deepagent/src/profiles/schema.json`
- Test: `apps/deepagent/src/profiles/schema.test.ts`

**Interfaces:**
- Produces: `ProfileData`, `ResolvedProfile`, `SubagentSpec`, `ToolSetSpec`, `InterpreterSpec`, `ProfileFlags`, `PromptSpec` (types); `schema.json` (the JSON Schema contract). Introduces `ajv` dep.
- Consumes: `ajv` (new).

- [ ] **Step 1: Add ajv dependency**

Run: `cd apps/deepagent && bun add ajv`
Expected: `ajv` added to `apps/deepagent/package.json` + `bun.lock` updated.

- [ ] **Step 2: Write types**

```ts
// apps/deepagent/src/profiles/types.ts
/** Validated plain data — names, not objects. Output of loadProfile. */
export interface InterpreterSpec {
  executionTimeoutMs: number
  subagents: boolean
}

/** "readOnly" | "all" | "none" | explicit tool-name list. */
export type ToolSetSpec = 'readOnly' | 'all' | 'none' | string[]

export interface SubagentSpec {
  name: string
  description: string
  systemPrompt: string
  tools: ToolSetSpec
  middleware: string[]      // names; "interpreter" here forces subagents:false at resolve time
}

export interface ProfileFlags {
  injectTodayDate: boolean
}

export interface ProfileData {
  profileVersion: number
  systemPromptSuffix: string
  ptcAllowlist: string[]
  interpreter: InterpreterSpec
  middleware: string[]      // parent middleware names, in order
  subagents: SubagentSpec[]
  flags: ProfileFlags
}

/** Names resolved to real Tool objects + built middleware. Output of resolveProfile. */
export interface ResolvedSubagent {
  name: string
  description: string
  systemPrompt: string
  tools: unknown[]         // StructuredTool[] from deepagents
  middleware: unknown[]    // built middleware objects
}

export interface ResolvedProfile {
  profileVersion: number
  systemPromptSuffix: string
  ptcAllowlist: string[]
  interpreter: InterpreterSpec
  parentMiddleware: unknown[]   // built, in order
  subagents: ResolvedSubagent[]
  flags: ProfileFlags
}

/** FUTURE evolution (not built in B). Documented so the additive widening is
 *  designed, not retrofitted. systemPromptSuffix widens string -> string | PromptSpec. */
export interface PromptSpec {
  include?: string[]                  // base blocks to use (default: all in BASE_BLOCK_ORDER)
  exclude?: string[]                  // base blocks to drop
  overrides?: Record<string, string>  // replace a named block's content
  suffix?: string                     // the old free-text suffix
}
```

- [ ] **Step 3: Write the JSON Schema**

```jsonc
// apps/deepagent/src/profiles/schema.json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://harnesh-trading-ts/profiles/profile.v1.json",
  "title": "Deep Agent Harness Profile",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "profileVersion": { "type": "integer", "const": 1 },
    "systemPromptSuffix": { "type": "string" },
    "ptcAllowlist": { "type": "array", "items": { "type": "string" }, "uniqueItems": true },
    "interpreter": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "executionTimeoutMs": { "type": "integer", "minimum": 1 },
        "subagents": { "type": "boolean" }
      }
    },
    "middleware": { "type": "array", "items": { "type": "string" } },
    "subagents": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name"],
        "properties": {
          "name": { "type": "string" },
          "description": { "type": "string" },
          "systemPrompt": { "type": "string" },
          "tools": {
            "oneOf": [
              { "type": "string", "enum": ["readOnly", "all", "none"] },
              { "type": "array", "items": { "type": "string" }, "uniqueItems": true }
            ]
          },
          "middleware": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "flags": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "injectTodayDate": { "type": "boolean" }
      }
    }
  }
}
```

- [ ] **Step 4: Write the failing test**

```ts
// apps/deepagent/src/profiles/schema.test.ts
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'

const here = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(join(here, 'schema.json'), 'utf8'))
const ajv = new Ajv2020({ allErrors: true })
const validate = ajv.compile(schema)

function ok(data: unknown) { return validate(data) === true }
function errs() { return (validate.errors ?? []).map((e: any) => `${e.instancePath} ${e.keyword} ${e.message}`).join('; ') }

test('schema: a complete valid profile passes', () => {
  expect(ok({
    profileVersion: 1,
    systemPromptSuffix: 'Be concise.',
    ptcAllowlist: ['get_ltp', 'news'],
    interpreter: { executionTimeoutMs: 30000, subagents: true },
    middleware: ['interpreter', 'coerceToolContent'],
    subagents: [{ name: 'quant', description: 'd', systemPrompt: 's', tools: 'readOnly', middleware: ['interpreter'] }],
    flags: { injectTodayDate: true },
  })).toBe(true)
})

test('schema: a partial override (only systemPromptSuffix) passes', () => {
  expect(ok({ systemPromptSuffix: 'x' })).toBe(true)
})

test('schema: unknown top-level field rejected (additionalProperties false)', () => {
  expect(ok({ oops: 1 })).toBe(false)
  expect(errs()).toContain('additionalProperties')
})

test('schema: profileVersion must be const 1', () => {
  expect(ok({ profileVersion: 2 })).toBe(false)
})

test('schema: unknown tools enum rejected', () => {
  expect(ok({ subagents: [{ name: 'q', tools: 'writable' }] })).toBe(false)
})

test('schema: subagent item requires name', () => {
  expect(ok({ subagents: [{ description: 'd' }] })).toBe(false)
})

test('schema: unknown flag rejected (additionalProperties false on flags)', () => {
  expect(ok({ flags: { unknownFlag: true } })).toBe(false)
})

test('schema: executionTimeoutMs minimum 1', () => {
  expect(ok({ interpreter: { executionTimeoutMs: 0, subagents: true } })).toBe(false)
})
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/profiles/schema.test.ts`
Expected: FAIL — `Cannot find module 'ajv/dist/2020.js'` OR schema file missing (if ajv not yet installed in this run; Step 1 installed it). If ajv present but schema/types not written: FAIL on missing schema.json.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/profiles/schema.test.ts`
Expected: PASS — 8 pass

- [ ] **Step 7: Commit**

```bash
git add apps/deepagent/src/profiles/types.ts apps/deepagent/src/profiles/schema.json apps/deepagent/src/profiles/schema.test.ts apps/deepagent/package.json ../bun.lock
git commit -m "feat(profiles): add ProfileData types + JSON Schema (ajv)"
```

---

### Task 3: Prompt blocks + assembler

**Files:**
- Create: `apps/deepagent/src/profiles/blocks.ts`
- Create: `apps/deepagent/src/profiles/prompt.ts`
- Test: `apps/deepagent/src/profiles/blocks.test.ts`

**Interfaces:**
- Consumes: `ResolvedProfile`, `ProfileFlags` from `./types` (Task 2).
- Produces: `BLOCKS` (Record<string,string>), `BASE_BLOCK_ORDER` (string[]), `assembleBase()` → string; `assembleSystemPrompt(profile, today)` → string.

**Note:** Blocks are split one-per-source-line (12 blocks) so `assembleBase()` reproduces today's `SYSTEM_PROMPT` byte-for-byte. `BASELINE` in the test is today's exact `SYSTEM_PROMPT` (agent.ts:14-25); the test is authoritative.

- [ ] **Step 1: Write the failing test**

```ts
// apps/deepagent/src/profiles/blocks.test.ts
import { test, expect } from 'bun:test'
import { BLOCKS, BASE_BLOCK_ORDER, assembleBase } from './blocks'
import { assembleSystemPrompt } from './prompt'
import type { ResolvedProfile } from './types'

// Today's exact SYSTEM_PROMPT (agent.ts:14-25). The byte-for-byte contract.
const BASELINE = [
  'You are a trading assistant for the Indian stock market, backed by the local Upstox trading API.',
  'Use the provided tools to answer the user\'s question.',
  '- Instrument keys look like "NSE_EQ|INE002A01018" or "NSE_INDEX|Nifty 50". Use search_instruments if you don\'t know the key.',
  '- Timeframes are canonical labels: v2 raw (1minute, 30minute, day, week, month) or v3 {interval}{unit} (e.g. 5minutes, 1days).',
  '- Dates are YYYY-MM-DD.',
  '- To store candles for a backtest, use sync_candles (source=v2|v3) or sync_expired_candles for EXPIRED instruments (interval 1minute|3minute|5minute|15minute|30minute|day — no week/month, no unit); to read stored candles, use read_candles (timeframe=interval, e.g. "3minute" or "day" for expired).',
  '- If a tool returns an error object, read it and retry with corrected parameters.',
  '- If the API is unreachable, tell the user to start apps/api (bun run dev in apps/api).',
  'Be concise. Prefer tools over guessing.',
  'You have a virtual filesystem (ls, read_file, write_file, edit_file, glob, grep) rooted at a workspace directory. Use it to persist analysis, notes, and intermediate results across the conversation. Prefer write_file for new artifacts and edit_file for small changes.',
  'You have an `eval` tool that runs JavaScript in a sandboxed QuickJS interpreter (no filesystem, network, or shell access). The read-only market-data tools are available inside `eval` as `tools.*` (e.g. `tools.get_ltp`, `tools.historical_candles`, `tools.search_instruments`). Use `eval` for loops, parallel/batched fetches, and deterministic transforms (indicators, aggregation, filtering) instead of one tool call per turn. For multi-step data work, write a workflow in `eval`.',
  'You can delegate to specialist subagents with the `task` tool, or from inside `eval` via the `task()` global: `task({ description, subagentType, responseSchema })` runs a full agentic loop on a subagent and resolves to its result. Subagents: `general-purpose` (research/fetch market data), `quant` (fetch candles + compute indicators in its own eval), `reporter` (write reports/artifacts to the workspace filesystem). Use `Promise.all` in `eval` to fan out across instruments, then synthesize. Prefer `task()` orchestration for multi-step, multi-symbol analysis instead of doing it all yourself turn-by-turn.',
].join('\n')

function fakeProfile(over: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    profileVersion: 1,
    systemPromptSuffix: '',
    ptcAllowlist: [],
    interpreter: { executionTimeoutMs: 30000, subagents: true },
    parentMiddleware: [],
    subagents: [],
    flags: { injectTodayDate: true },
    ...over,
  } as ResolvedProfile
}

test('blocks: every BASE_BLOCK_ORDER entry exists in BLOCKS', () => {
  for (const b of BASE_BLOCK_ORDER) expect(BLOCKS[b]).toBeTypeOf('string')
})

test('blocks: BASE_BLOCK_ORDER has no duplicates', () => {
  expect(new Set(BASE_BLOCK_ORDER).size).toBe(BASE_BLOCK_ORDER.length)
})

test('blocks: assembleBase reproduces today\'s SYSTEM_PROMPT byte-for-byte', () => {
  expect(assembleBase()).toBe(BASELINE)
})

test('prompt: assembleSystemPrompt with injectTodayDate + empty suffix = date prefix + base', () => {
  const out = assembleSystemPrompt(fakeProfile(), '2026-07-13')
  expect(out.startsWith('Today\'s date is 2026-07-13 (IST, Indian market calendar).')).toBe(true)
  expect(out).toContain(BASELINE)
  expect(out).toBe(`Today's date is 2026-07-13 (IST, Indian market calendar). Treat this as the real current date for "current date"/"today" questions and as the default toDate for recent data.\n\n${BASELINE}`)
})

test('prompt: injectTodayDate=false omits the date prefix', () => {
  const out = assembleSystemPrompt(fakeProfile({ flags: { injectTodayDate: false } }), '2026-07-13')
  expect(out.startsWith(BASELINE)).toBe(true)
  expect(out).not.toContain('Today\'s date is')
})

test('prompt: non-empty suffix appended after base', () => {
  const out = assembleSystemPrompt(fakeProfile({ systemPromptSuffix: 'Prefer tools.' }), '2026-07-13')
  expect(out.endsWith(BASELINE + '\n\nPrefer tools.')).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/profiles/blocks.test.ts`
Expected: FAIL — `Cannot find module './blocks'`

- [ ] **Step 3: Write blocks.ts**

```ts
// apps/deepagent/src/profiles/blocks.ts
/** Modular base prompt. Split one-per-source-line so assembleBase() reproduces
 *  today's SYSTEM_PROMPT byte-for-byte (locked by blocks.test.ts BASELINE).
 *  The evolution seam is prompt.ts:assembleSystemPrompt; a future additive
 *  widening (systemPromptSuffix -> string | PromptSpec) plugs in there. */
export const BLOCKS: Record<string, string> = {
  identity:          'You are a trading assistant for the Indian stock market, backed by the local Upstox trading API.',
  'use-tools':      'Use the provided tools to answer the user\'s question.',
  instruments:      '- Instrument keys look like "NSE_EQ|INE002A01018" or "NSE_INDEX|Nifty 50". Use search_instruments if you don\'t know the key.',
  timeframes:       '- Timeframes are canonical labels: v2 raw (1minute, 30minute, day, week, month) or v3 {interval}{unit} (e.g. 5minutes, 1days).',
  dates:             '- Dates are YYYY-MM-DD.',
  'candle-storage': '- To store candles for a backtest, use sync_candles (source=v2|v3) or sync_expired_candles for EXPIRED instruments (interval 1minute|3minute|5minute|15minute|30minute|day — no week/month, no unit); to read stored candles, use read_candles (timeframe=interval, e.g. "3minute" or "day" for expired).',
  'error-retry':    '- If a tool returns an error object, read it and retry with corrected parameters.',
  'api-unreachable':'- If the API is unreachable, tell the user to start apps/api (bun run dev in apps/api).',
  behavior:         'Be concise. Prefer tools over guessing.',
  filesystem:       'You have a virtual filesystem (ls, read_file, write_file, edit_file, glob, grep) rooted at a workspace directory. Use it to persist analysis, notes, and intermediate results across the conversation. Prefer write_file for new artifacts and edit_file for small changes.',
  eval:             'You have an `eval` tool that runs JavaScript in a sandboxed QuickJS interpreter (no filesystem, network, or shell access). The read-only market-data tools are available inside `eval` as `tools.*` (e.g. `tools.get_ltp`, `tools.historical_candles`, `tools.search_instruments`). Use `eval` for loops, parallel/batched fetches, and deterministic transforms (indicators, aggregation, filtering) instead of one tool call per turn. For multi-step data work, write a workflow in `eval`.',
  subagents:        'You can delegate to specialist subagents with the `task` tool, or from inside `eval` via the `task()` global: `task({ description, subagentType, responseSchema })` runs a full agentic loop on a subagent and resolves to its result. Subagents: `general-purpose` (research/fetch market data), `quant` (fetch candles + compute indicators in its own eval), `reporter` (write reports/artifacts to the workspace filesystem). Use `Promise.all` in `eval` to fan out across instruments, then synthesize. Prefer `task()` orchestration for multi-step, multi-symbol analysis instead of doing it all yourself turn-by-turn.',
}

export const BASE_BLOCK_ORDER = [
  'identity', 'use-tools', 'instruments', 'timeframes', 'dates', 'candle-storage',
  'error-retry', 'api-unreachable', 'behavior', 'filesystem', 'eval', 'subagents',
]

export function assembleBase(): string {
  return BASE_BLOCK_ORDER.map((b) => BLOCKS[b]).join('\n')
}
```

- [ ] **Step 4: Write prompt.ts**

```ts
// apps/deepagent/src/profiles/prompt.ts
import type { ResolvedProfile } from './types'
import { assembleBase } from './blocks'

/** The prompt loader / evolution seam. Today: datePrefix + base blocks (fixed
 *  order) + suffix. The ONLY place prompt composition lives. Future block-control
 *  (PromptSpec) plugs in here by widening systemPromptSuffix — no format change. */
export function assembleSystemPrompt(profile: ResolvedProfile, today: string): string {
  const datePrefix = profile.flags.injectTodayDate
    ? `Today's date is ${today} (IST, Indian market calendar). Treat this as the real current date for "current date"/"today" questions and as the default toDate for recent data.\n\n`
    : ''
  const base = assembleBase()
  const suffix = profile.systemPromptSuffix
  return datePrefix + base + (suffix ? `\n\n${suffix}` : '')
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/profiles/blocks.test.ts`
Expected: PASS — 6 pass

- [ ] **Step 6: Commit**

```bash
git add apps/deepagent/src/profiles/blocks.ts apps/deepagent/src/profiles/prompt.ts apps/deepagent/src/profiles/blocks.test.ts
git commit -m "feat(profiles): modular prompt blocks + assembleSystemPrompt seam"
```

---

### Task 4: Middleware implementations + registry

**Files:**
- Create: `apps/deepagent/src/profiles/implementations.ts` (the 3 impls moved from `agent.ts`, unchanged)
- Create: `apps/deepagent/src/profiles/middleware.ts` (MIDDLEWARE_REGISTRY)
- Modify: `apps/deepagent/src/agent.ts` (import the 3 impls from `./profiles/implementations` instead of defining them; delete the local impls + their helper comments; keep `SUBAGENTS`/`PTC_ALLOWLIST`/`READ_ONLY_TOOLS` for now — removed in Task 7)
- Modify: `apps/deepagent/src/agent.test.ts` (import the 3 middleware builders from `./profiles/implementations` instead of `./agent`)
- Test: `apps/deepagent/src/profiles/middleware.test.ts`

**Interfaces:**
- Consumes: `InterpreterSpec`, `ProfileData` from `./types` (Task 2); `@langchain/quickjs`, `@langchain/core/messages` (existing).
- Produces: `buildInterpreterMiddleware`, `buildCoerceToolContentMiddleware`, `buildReadFileContinuationMiddleware` (moved, unchanged signatures); `MIDDLEWARE_REGISTRY: Record<string, (ctx: MwCtx) => unknown>`; `MwCtx`.
- Behavior-preserving: `agent.ts` keeps working (SUBAGENTS + buildAgent still call the impls, now imported).

- [ ] **Step 1: Write the failing registry test**

```ts
// apps/deepagent/src/profiles/middleware.test.ts
import { test, expect } from 'bun:test'
import { ToolMessage } from '@langchain/core/messages'
import { MIDDLEWARE_REGISTRY } from './middleware'
import { buildReadFileContinuationMiddleware } from './implementations'

const ctx = {
  ptcAllowlist: ['get_ltp'],
  interpreter: { executionTimeoutMs: 30000, subagents: true },
  parent: true,
}

test('registry: exactly interpreter + coerceToolContent + readFileContinuation', () => {
  expect(Object.keys(MIDDLEWARE_REGISTRY).sort()).toEqual(['coerceToolContent', 'interpreter', 'readFileContinuation'])
})

test('registry: interpreter builds a truthy middleware (parent)', () => {
  expect(MIDDLEWARE_REGISTRY.interpreter(ctx)).toBeTruthy()
})

test('registry: interpreter builds a truthy middleware (subagent)', () => {
  expect(MIDDLEWARE_REGISTRY.interpreter({ ...ctx, parent: false })).toBeTruthy()
})

test('registry: coerceToolContent + readFileContinuation build truthy', () => {
  expect(MIDDLEWARE_REGISTRY.coerceToolContent(ctx)).toBeTruthy()
  expect(MIDDLEWARE_REGISTRY.readFileContinuation(ctx)).toBeTruthy()
})

test('readFileContinuation: appends notice when read_file returns == limit line-numbered lines', async () => {
  const mw = buildReadFileContinuationMiddleware()
  const lines = Array.from({ length: 100 }, (_, i) => `${i + 1}\tline ${i + 1}`).join('\n')
  const handler = async () => new ToolMessage({ content: lines, tool_call_id: 'tc1', name: 'read_file' })
  const out: any = await mw.wrapToolCall({ toolCall: { name: 'read_file', args: { offset: 0, limit: 100 } } }, handler)
  expect(out.content).toContain('continues past this read window')
  expect(out.content).toContain('offset=100')
  expect(out.tool_call_id).toBe('tc1')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/profiles/middleware.test.ts`
Expected: FAIL — `Cannot find module './middleware'`

- [ ] **Step 3: Move the 3 impls to implementations.ts (verbatim from agent.ts)**

```ts
// apps/deepagent/src/profiles/implementations.ts
import { createCodeInterpreterMiddleware } from '@langchain/quickjs'
import { ToolMessage } from '@langchain/core/messages'

/** Build the code-interpreter middleware. opts.subagents === false disables the
 *  dynamic task() global (used for the quant subagent to bound recursion); the
 *  default (no arg) preserves the parent behavior (task() enabled). */
export function buildInterpreterMiddleware(opts?: { ptc?: string[]; executionTimeoutMs?: number; subagents?: boolean }) {
  return createCodeInterpreterMiddleware({
    ptc: opts?.ptc ?? [],
    executionTimeoutMs: opts?.executionTimeoutMs ?? 30_000,
    ...(opts?.subagents === false ? { subagents: false } : {}),
  })
}

/** Coerce non-string ToolMessage content to a string before each model call.
 *  Some framework tools return structured/Array content; LLM providers reject
 *  non-string tool-message content. tool_call_id + name preserved. No-op for
 *  string content. (Moved unchanged from agent.ts.) */
export function buildCoerceToolContentMiddleware(): any {
  return {
    wrapModelCall: async (request: any, handler: any) => {
      request.messages = request.messages.map((m: any) => {
        if (!(m instanceof ToolMessage) || typeof m.content === 'string') return m
        const coerced = Array.isArray(m.content)
          ? m.content
              .map((b: any) =>
                typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : JSON.stringify(b),
              )
              .join('\n')
          : JSON.stringify(m.content)
        return new ToolMessage({
          content: coerced,
          tool_call_id: m.tool_call_id,
          name: m.name,
        })
      })
      return handler(request)
    },
  }
}

/** ReadFileContinuationNoticeMiddleware — TS port of NVIDIA's LangChain Deep Agents
 *  harness-profile middleware. When read_file returns exactly `limit` line-numbered
 *  lines, append a notice telling the model to page forward with offset+limit.
 *  (Moved unchanged from agent.ts.) */
export function buildReadFileContinuationMiddleware(): any {
  return {
    name: 'ReadFileContinuationNoticeMiddleware',
    wrapToolCall: async (request: any, handler: any) => {
      const tc = request?.toolCall
      if (tc?.name !== 'read_file') return handler(request)
      const result = await handler(request)
      if (!result || typeof result !== 'object' || !('tool_call_id' in result)) return result
      const args = (tc.args ?? {}) as { offset?: number; limit?: number }
      const limit = Number.isFinite(args.limit) ? Number(args.limit) : 100
      const offset = Number.isFinite(args.offset) ? Number(args.offset) : 0
      const content =
        typeof result.content === 'string'
          ? result.content
          : Array.isArray(result.content)
            ? result.content
                .map((b: any) =>
                  typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : JSON.stringify(b),
                )
                .join('\n')
            : JSON.stringify(result.content ?? '')
      const numberedLineCount = content
        .split('\n')
        .filter((l: string) => /^\d+\t/.test(l)).length
      if (numberedLineCount < limit) return result
      const notice =
        `\n\n[The file likely continues past this read window — ${numberedLineCount} line-numbered lines were returned, equal to the limit of ${limit}. ` +
        `To read further, call read_file again with offset=${offset + limit} (and the same limit). ` +
        `Do not assume you have seen the end of the file unless a subsequent read returns fewer than ${limit} line-numbered lines.]`
      return new ToolMessage({
        content: content + notice,
        tool_call_id: result.tool_call_id,
        name: result.name,
      })
    },
  }
}
```

Note: `buildInterpreterMiddleware` signature widened to accept `{ptc, executionTimeoutMs, subagents}` (was `opts?: { subagents?: boolean }` in agent.ts, where ptc/timeout were hardcoded). This is an intentional, behavior-preserving widening: callers that omit the new fields get the old defaults (`ptc: []`, `30_000`). agent.ts's current call sites pass `{ subagents: false }` (quant) and `()` (parent) — both still valid.

- [ ] **Step 4: Write middleware.ts (registry)**

```ts
// apps/deepagent/src/profiles/middleware.ts
import type { InterpreterSpec } from './types'
import {
  buildInterpreterMiddleware,
  buildCoerceToolContentMiddleware,
  buildReadFileContinuationMiddleware,
} from './implementations'

export interface MwCtx {
  ptcAllowlist: string[]
  interpreter: InterpreterSpec
  parent: boolean
}

/** Fixed registry: profile references middleware by name; never code.
 *  The interpreter builder reads ptcAllowlist/executionTimeoutMs/subagents from
 *  the loaded profile (single source of truth). For a subagent (parent:false),
 *  interpreter forces subagents:false — bounds recursion to depth 1. */
export const MIDDLEWARE_REGISTRY: Record<string, (ctx: MwCtx) => unknown> = {
  interpreter: (ctx) =>
    buildInterpreterMiddleware({
      ptc: ctx.ptcAllowlist,
      executionTimeoutMs: ctx.interpreter.executionTimeoutMs,
      subagents: ctx.parent ? ctx.interpreter.subagents : false,
    }),
  coerceToolContent: () => buildCoerceToolContentMiddleware(),
  readFileContinuation: () => buildReadFileContinuationMiddleware(),
}
```

- [ ] **Step 5: Update agent.ts imports**

In `apps/deepagent/src/agent.ts`:
- Remove the `import { createCodeInterpreterMiddleware } from '@langchain/quickjs'` line and the `import { ToolMessage } from '@langchain/core/messages'` line (now only used by the moved impls — verify no other usage in agent.ts; if `ToolMessage` is used elsewhere keep it). Add: `import { buildInterpreterMiddleware, buildCoerceToolContentMiddleware, buildReadFileContinuationMiddleware } from './profiles/implementations'`.
- Delete the three local impl functions (`buildInterpreterMiddleware`, `buildCoerceToolContentMiddleware`, `buildReadFileContinuationMiddleware`) and their doc-comment blocks from agent.ts.
- Keep everything else (`SYSTEM_PROMPT`, `PTC_ALLOWLIST`, `READ_ONLY_TOOLS`, `SUBAGENTS`, `buildAgent`, etc.) unchanged for now, **except** the two `buildInterpreterMiddleware` call sites must now pass `ptc` explicitly. Today's local impl hardcoded `ptc: PTC_ALLOWLIST`; the moved impl defaults `ptc: opts?.ptc ?? []`, so leaving the call sites unchanged would silently drop the parent + quant interpreter's pass-through-tools from 10 tools to empty. To preserve behavior exactly:
  - In the `SUBAGENTS` quant entry: change `buildInterpreterMiddleware({ subagents: false })` → `buildInterpreterMiddleware({ ptc: PTC_ALLOWLIST, subagents: false })`.
  - In `buildAgent`'s middleware array: change `buildInterpreterMiddleware()` → `buildInterpreterMiddleware({ ptc: PTC_ALLOWLIST })`.
  - (`PTC_ALLOWLIST` is still defined in agent.ts at this stage; it is removed in Task 7 when `buildAgent` is rewritten to use the profile's `parentMiddleware`.)

The `SUBAGENTS` array and `buildAgent` continue to call `buildCoerceToolContentMiddleware()` / `buildReadFileContinuationMiddleware()` — now resolved via the new import. With the `ptc` fix above, no behavior change.

- [ ] **Step 6: Update agent.test.ts imports**

Change line 6 of `apps/deepagent/src/agent.test.ts` from:
```ts
import { buildModel, resolveAgentConfig, workspaceDir, WORKSPACE_PERMISSIONS, buildBackend, buildAgent, PTC_ALLOWLIST, buildInterpreterMiddleware, READ_ONLY_TOOLS, SUBAGENTS, buildReadFileContinuationMiddleware } from './agent'
```
to:
```ts
import { buildModel, resolveAgentConfig, workspaceDir, WORKSPACE_PERMISSIONS, buildBackend, buildAgent, PTC_ALLOWLIST, READ_ONLY_TOOLS, SUBAGENTS } from './agent'
import { buildInterpreterMiddleware, buildReadFileContinuationMiddleware } from './profiles/implementations'
```
(All existing tests in agent.test.ts still pass — the imported names resolve from the new location with identical behavior.)

- [ ] **Step 7: Run tests to verify**

Run: `cd apps/deepagent && bun test src/profiles/middleware.test.ts`
Expected: PASS — 5 pass

Run: `cd apps/deepagent && bun test`
Expected: PASS — all existing deepagent tests green (the moved impls are behavior-identical; agent.test.ts imports resolve). Count unchanged from current (60 + new parse-jsonc 5 + schema 8 + blocks 6 + middleware 5 = current base 60 → 84 after Tasks 1–4).

- [ ] **Step 8: Commit**

```bash
git add apps/deepagent/src/profiles/implementations.ts apps/deepagent/src/profiles/middleware.ts apps/deepagent/src/profiles/middleware.test.ts apps/deepagent/src/agent.ts apps/deepagent/src/agent.test.ts
git commit -m "refactor(profiles): move middleware impls to profiles/, add MIDDLEWARE_REGISTRY"
```

---

### Task 5: Compiled-in defaults + resolveProfile

**Files:**
- Create: `apps/deepagent/src/profiles/defaults.ts`
- Create: `apps/deepagent/src/profiles/resolve.ts`
- Test: `apps/deepagent/src/profiles/resolve.test.ts`

**Interfaces:**
- Consumes: `ProfileData`, `ResolvedProfile`, `SubagentSpec`, `ToolSetSpec`, `ResolvedSubagent` from `./types` (Task 2); `MIDDLEWARE_REGISTRY`, `MwCtx` from `./middleware` (Task 4); `allTools` from `../tools` (existing).
- Produces: `DEFAULT_PROFILE_DATA: ProfileData` (compiled-in floor); `resolveProfile(data): ResolvedProfile`; `resolveTools(spec, ptcAllowlist): unknown[]`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/deepagent/src/profiles/resolve.test.ts
import { test, expect } from 'bun:test'
import { DEFAULT_PROFILE_DATA } from './defaults'
import { resolveProfile, resolveTools } from './resolve'
import { allTools } from '../tools'

test('defaults: DEFAULT_PROFILE_DATA has profileVersion 1 + 10 ptc tools + 3 subagents', () => {
  expect(DEFAULT_PROFILE_DATA.profileVersion).toBe(1)
  expect(DEFAULT_PROFILE_DATA.ptcAllowlist).toHaveLength(10)
  expect(DEFAULT_PROFILE_DATA.ptcAllowlist).not.toContain('sync_candles')
  expect(DEFAULT_PROFILE_DATA.ptcAllowlist).not.toContain('call_api')
  expect(DEFAULT_PROFILE_DATA.subagents.map((s) => s.name).sort()).toEqual(['general-purpose', 'quant', 'reporter'])
})

test('resolveTools: readOnly = allTools filtered to ptcAllowlist', () => {
  const tools = resolveTools('readOnly', DEFAULT_PROFILE_DATA.ptcAllowlist) as any[]
  const names = tools.map((t) => t.name).sort()
  expect(names).toEqual([...DEFAULT_PROFILE_DATA.ptcAllowlist].sort())
  expect(names).not.toContain('sync_candles')
  expect(names).not.toContain('call_api')
})

test('resolveTools: all = allTools', () => {
  const tools = resolveTools('all', []) as any[]
  expect(tools.map((t) => t.name).sort()).toEqual(allTools.map((t: any) => t.name).sort())
})

test('resolveTools: none = []', () => {
  expect(resolveTools('none', [])).toEqual([])
})

test('resolveTools: explicit list resolves + fails on unknown', () => {
  const tools = resolveTools(['get_ltp', 'news'], DEFAULT_PROFILE_DATA.ptcAllowlist) as any[]
  expect(tools.map((t) => t.name).sort()).toEqual(['get_ltp', 'news'])
  expect(() => resolveTools(['nope'], DEFAULT_PROFILE_DATA.ptcAllowlist)).toThrow(/unknown tool: "nope"/)
})

test('resolveProfile: parent middleware built in order (3)', () => {
  const r = resolveProfile(DEFAULT_PROFILE_DATA)
  expect(r.parentMiddleware).toHaveLength(3)
  expect(r.parentMiddleware.every((m) => m)).toBe(true)
})

test('resolveProfile: 3 subagents resolved with tools + middleware', () => {
  const r = resolveProfile(DEFAULT_PROFILE_DATA)
  const byName = Object.fromEntries(r.subagents.map((s) => [s.name, s]))
  expect(byName['general-purpose'].tools.map((t: any) => t.name).sort()).toEqual([...DEFAULT_PROFILE_DATA.ptcAllowlist].sort())
  expect(byName['quant'].tools.map((t: any) => t.name).sort()).toEqual([...DEFAULT_PROFILE_DATA.ptcAllowlist].sort())
  expect(byName['reporter'].tools).toEqual([])
  expect(byName['quant'].middleware.length).toBeGreaterThan(0)
  expect(byName['general-purpose'].middleware).toEqual([])
  expect(byName['reporter'].middleware).toEqual([])
})

test('resolveProfile: ptcAllowlist + interpreter passed through', () => {
  const r = resolveProfile(DEFAULT_PROFILE_DATA)
  expect(r.ptcAllowlist).toEqual(DEFAULT_PROFILE_DATA.ptcAllowlist)
  expect(r.interpreter).toEqual(DEFAULT_PROFILE_DATA.interpreter)
  expect(r.profileVersion).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/profiles/resolve.test.ts`
Expected: FAIL — `Cannot find module './defaults'`

- [ ] **Step 3: Write defaults.ts**

```ts
// apps/deepagent/src/profiles/defaults.ts
import type { ProfileData } from './types'

/** Compiled-in floor (layer 1 of the 4-level resolution chain). Seeded verbatim
 *  from today's hardcoded agent.ts values; identical to profiles/default.jsonc
 *  (locked by a loader test). The system loads even if profiles/ is wiped. */
export const DEFAULT_PROFILE_DATA: ProfileData = {
  profileVersion: 1,
  systemPromptSuffix: '',
  ptcAllowlist: [
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
  ],
  interpreter: { executionTimeoutMs: 30_000, subagents: true },
  middleware: ['interpreter', 'coerceToolContent', 'readFileContinuation'],
  subagents: [
    {
      name: 'general-purpose',
      description: 'Research/fetch market data: instrument search, LTP, quotes, option chain, news, company profile.',
      systemPrompt: 'You are a general-purpose research subagent for the Indian stock market. Use the market-data tools to search instruments, fetch LTP/OHLC/quotes, option chain, market status, company profile, and news. Summarize what you find concisely. Do not write files.',
      tools: 'readOnly',
      middleware: [],
    },
    {
      name: 'quant',
      description: 'Fetch candles and compute indicators/aggregations in eval (RSI, MACD, returns, vol).',
      systemPrompt: 'You are a quant analyst for the Indian stock market. Fetch candles with the market-data tools and compute indicators / aggregations in eval (RSI, MACD, moving averages, returns, vol). Return concise numeric results. Do not write files.',
      tools: 'readOnly',
      middleware: ['interpreter', 'coerceToolContent', 'readFileContinuation'],
    },
    {
      name: 'reporter',
      description: 'Write a markdown report/artifact to the workspace from provided analysis.',
      systemPrompt: 'You are a report writer. Given analysis results, write a clean markdown report to the workspace using write_file/edit_file. You have no market-data tools — work from what the caller provides.',
      tools: 'none',
      middleware: [],
    },
  ],
  flags: { injectTodayDate: true },
}
```

- [ ] **Step 4: Write resolve.ts**

```ts
// apps/deepagent/src/profiles/resolve.ts
import type { ProfileData, ResolvedProfile, ResolvedSubagent, ToolSetSpec } from './types'
import { MIDDLEWARE_REGISTRY, type MwCtx } from './middleware'
import { allTools } from '../tools'

/** Resolve a named tool-set against this profile's ptcAllowlist (single source
 *  of truth). "readOnly" derives from ptcAllowlist; explicit names fail-fast. */
export function resolveTools(spec: ToolSetSpec, ptcAllowlist: string[]): unknown[] {
  if (spec === 'readOnly') return allTools.filter((t: any) => ptcAllowlist.includes(t.name))
  if (spec === 'all') return allTools
  if (spec === 'none') return []
  const byName = new Map(allTools.map((t: any) => [t.name, t] as const))
  return spec.map((name) => {
    const t = byName.get(name)
    if (!t) throw new Error(`unknown tool: "${name}"`)
    return t
  })
}

/** Turn validated ProfileData (names) into ResolvedProfile (real Tool objects +
 *  built middleware). The interpreter builder forces subagents:false for any
 *  subagent (parent:false) — bounds recursion to depth 1. */
export function resolveProfile(data: ProfileData): ResolvedProfile {
  const parentCtx: MwCtx = { ptcAllowlist: data.ptcAllowlist, interpreter: data.interpreter, parent: true }
  const parentMiddleware = data.middleware.map((name) => {
    const builder = MIDDLEWARE_REGISTRY[name]
    if (!builder) throw new Error(`unknown middleware: "${name}"`)
    return builder(parentCtx)
  })
  const subagents: ResolvedSubagent[] = data.subagents.map((s) => {
    const subCtx: MwCtx = { ptcAllowlist: data.ptcAllowlist, interpreter: data.interpreter, parent: false }
    const middleware = s.middleware.map((name) => {
      const builder = MIDDLEWARE_REGISTRY[name]
      if (!builder) throw new Error(`unknown middleware: "${name}"`)
      return builder(subCtx)
    })
    return {
      name: s.name,
      description: s.description,
      systemPrompt: s.systemPrompt,
      tools: resolveTools(s.tools, data.ptcAllowlist),
      middleware,
    }
  })
  return {
    profileVersion: data.profileVersion,
    systemPromptSuffix: data.systemPromptSuffix,
    ptcAllowlist: data.ptcAllowlist,
    interpreter: data.interpreter,
    parentMiddleware,
    subagents,
    flags: data.flags,
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/profiles/resolve.test.ts`
Expected: PASS — 8 pass

- [ ] **Step 6: Commit**

```bash
git add apps/deepagent/src/profiles/defaults.ts apps/deepagent/src/profiles/resolve.ts apps/deepagent/src/profiles/resolve.test.ts
git commit -m "feat(profiles): compiled-in DEFAULT_PROFILE_DATA + resolveProfile"
```

---

### Task 6: Loader (4-level chain + merge + validation) + default.jsonc

**Files:**
- Create: `apps/deepagent/profiles/default.jsonc`
- Create: `apps/deepagent/src/profiles/loader.ts`
- Create: `apps/deepagent/src/profiles/index.ts`
- Test: `apps/deepagent/src/profiles/loader.test.ts`

**Interfaces:**
- Consumes: `parseJsonc` from `./parse-jsonc` (Task 1); `ProfileData`, `SubagentSpec` from `./types` (Task 2); `schema.json` + `ajv` (Task 2); `DEFAULT_PROFILE_DATA` from `./defaults` (Task 5); `allTools` from `../tools`; `MIDDLEWARE_REGISTRY` from `./middleware` (Task 4).
- Produces: `loadProfile(provider, model): ProfileData`; `mergeProfiles(lower, higher): ProfileData`; `ProfileSchemaError`, `ProfileVersionError`; re-exports via `index.ts`.

- [ ] **Step 1: Write default.jsonc**

```jsonc
// apps/deepagent/profiles/default.jsonc
{
  "profileVersion": 1,
  "systemPromptSuffix": "",
  "ptcAllowlist": [
    "search_instruments",
    "get_ltp",
    "get_ohlc_quote",
    "historical_candles",
    "intraday_candles",
    "option_chain",
    "market_status",
    "read_candles",
    "company_profile",
    "news"
  ],
  "interpreter": {
    "executionTimeoutMs": 30000,
    "subagents": true
  },
  "middleware": ["interpreter", "coerceToolContent", "readFileContinuation"],
  "subagents": [
    {
      "name": "general-purpose",
      "description": "Research/fetch market data: instrument search, LTP, quotes, option chain, news, company profile.",
      "systemPrompt": "You are a general-purpose research subagent for the Indian stock market. Use the market-data tools to search instruments, fetch LTP/OHLC/quotes, option chain, market status, company profile, and news. Summarize what you find concisely. Do not write files.",
      "tools": "readOnly",
      "middleware": []
    },
    {
      "name": "quant",
      "description": "Fetch candles and compute indicators/aggregations in eval (RSI, MACD, returns, vol).",
      "systemPrompt": "You are a quant analyst for the Indian stock market. Fetch candles with the market-data tools and compute indicators / aggregations in eval (RSI, MACD, moving averages, returns, vol). Return concise numeric results. Do not write files.",
      "tools": "readOnly",
      "middleware": ["interpreter", "coerceToolContent", "readFileContinuation"]
    },
    {
      "name": "reporter",
      "description": "Write a markdown report/artifact to the workspace from provided analysis.",
      "systemPrompt": "You are a report writer. Given analysis results, write a clean markdown report to the workspace using write_file/edit_file. You have no market-data tools — work from what the caller provides.",
      "tools": "none",
      "middleware": []
    }
  ],
  "flags": {
    "injectTodayDate": true
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/deepagent/src/profiles/loader.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProfile, mergeProfiles } from './loader'
import { DEFAULT_PROFILE_DATA } from './defaults'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prof-'))
  process.env.AGENT_PROFILES_DIR = dir
})
afterEach(() => {
  delete process.env.AGENT_PROFILES_DIR
  rmSync(dir, { recursive: true, force: true })
})
function write(name: string, content: string) { writeFileSync(join(dir, name), content) }

test('loadProfile: default.jsonc == DEFAULT_PROFILE_DATA (no drift)', () => {
  write('default.jsonc', JSON.stringify(DEFAULT_PROFILE_DATA, null, 2))
  const p = loadProfile('ollama', 'llama3')
  expect(p).toEqual(DEFAULT_PROFILE_DATA)
})

test('loadProfile: no files at all -> built-in floor (complete, valid)', () => {
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
  const p = loadProfile('ollama', 'llama3')
  expect(p).toEqual(DEFAULT_PROFILE_DATA)
})

test('mergeProfiles: arrays replace (ptcAllowlist)', () => {
  const lower = DEFAULT_PROFILE_DATA
  const merged = mergeProfiles(lower, { ...DEFAULT_PROFILE_DATA, ptcAllowlist: ['get_ltp'] })
  expect(merged.ptcAllowlist).toEqual(['get_ltp'])
})

test('mergeProfiles: subagents merge by name (patch + keep + append)', () => {
  const lower = DEFAULT_PROFILE_DATA
  const higher: any = {
    subagents: [
      { name: 'quant', systemPrompt: 'NEW quant prompt' },
      { name: 'analyst', description: 'd', systemPrompt: 's', tools: 'readOnly', middleware: [] },
    ],
  }
  const merged = mergeProfiles(lower, higher)
  const byName = Object.fromEntries(merged.subagents.map((s) => [s.name, s]))
  expect(merged.subagents.map((s) => s.name)).toEqual(['general-purpose', 'quant', 'reporter', 'analyst'])
  expect(byName['quant'].systemPrompt).toBe('NEW quant prompt')
  expect(byName['quant'].tools).toBe('readOnly')            // kept from lower (patch omitted tools)
  expect(byName['general-purpose'].systemPrompt).toBe(DEFAULT_PROFILE_DATA.subagents[0].systemPrompt) // kept
  expect(byName['analyst'].systemPrompt).toBe('s')          // appended
})

test('loadProfile: 4-level chain order (model > provider > global > built-in)', () => {
  write('default.jsonc', JSON.stringify({ ...DEFAULT_PROFILE_DATA, systemPromptSuffix: 'G' }))
  write('anthropic__default.jsonc', JSON.stringify({ systemPromptSuffix: 'P', interpreter: { executionTimeoutMs: 45000, subagents: true } }))
  write('anthropic__claude-opus-4-8.jsonc', JSON.stringify({ systemPromptSuffix: 'M' }))
  const p = loadProfile('anthropic', 'claude-opus-4-8')
  expect(p.systemPromptSuffix).toBe('M')                       // model wins
  expect(p.interpreter.executionTimeoutMs).toBe(45000)         // provider default wins (model omits)
  expect(p.ptcAllowlist).toEqual(DEFAULT_PROFILE_DATA.ptcAllowlist) // global (model+provider omit) = global value
  expect(p.subagents.map((s) => s.name).sort()).toEqual(['general-purpose', 'quant', 'reporter']) // from global
})

test('loadProfile: provider default inherited by a model that omits the field', () => {
  write('default.jsonc', JSON.stringify(DEFAULT_PROFILE_DATA))
  write('openrouter__default.jsonc', JSON.stringify({ systemPromptSuffix: 'provider-suffix' }))
  write('openrouter__anthropic_claude-3.5-sonnet.jsonc', JSON.stringify({}))  // sanitize: '/' -> '_'
  const p = loadProfile('openrouter', 'anthropic/claude-3.5-sonnet')
  expect(p.systemPromptSuffix).toBe('provider-suffix')
})

test('loadProfile: schema rejects unknown field', () => {
  write('default.jsonc', JSON.stringify(DEFAULT_PROFILE_DATA))
  write('ollama__llama3.jsonc', '{ "oops": 1 }')
  expect(() => loadProfile('ollama', 'llama3')).toThrow(/schema/i)
})

test('loadProfile: reference validation rejects unknown middleware', () => {
  write('default.jsonc', JSON.stringify(DEFAULT_PROFILE_DATA))
  write('ollama__llama3.jsonc', JSON.stringify({ middleware: ['nope'] }))
  expect(() => loadProfile('ollama', 'llama3')).toThrow(/unknown middleware: "nope"/)
})

test('loadProfile: reference validation rejects unknown tool in ptcAllowlist', () => {
  write('default.jsonc', JSON.stringify(DEFAULT_PROFILE_DATA))
  write('ollama__llama3.jsonc', JSON.stringify({ ptcAllowlist: ['nope'] }))
  expect(() => loadProfile('ollama', 'llama3')).toThrow(/unknown tool: "nope"/)
})

test('loadProfile: rejects profileVersion != 1', () => {
  write('default.jsonc', JSON.stringify({ ...DEFAULT_PROFILE_DATA, profileVersion: 2 }))
  expect(() => loadProfile('ollama', 'llama3')).toThrow(/profileVersion|version/i)
})

test('loadProfile: rejects duplicate subagent name in merged result', () => {
  write('default.jsonc', JSON.stringify(DEFAULT_PROFILE_DATA))
  write('ollama__llama3.jsonc', JSON.stringify({ subagents: [
    { name: 'reporter', description: 'dup', systemPrompt: 's', tools: 'none', middleware: [] },
    { name: 'reporter', description: 'dup2', systemPrompt: 's2', tools: 'none', middleware: [] },
  ] }))
  expect(() => loadProfile('ollama', 'llama3')).toThrow(/duplicate subagent name: "reporter"/)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/profiles/loader.test.ts`
Expected: FAIL — `Cannot find module './loader'`

- [ ] **Step 4: Write loader.ts**

```ts
// apps/deepagent/src/profiles/loader.ts
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { parseJsonc } from './parse-jsonc'
import type { ProfileData, SubagentSpec } from './types'
import { DEFAULT_PROFILE_DATA } from './defaults'
import { MIDDLEWARE_REGISTRY } from './middleware'
import { allTools } from '../tools'

const here = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(join(here, 'schema.json'), 'utf8'))
const ajv = new Ajv2020({ allErrors: true })
const validateSchema = ajv.compile(schema)

export class ProfileSchemaError extends Error {
  constructor(public file: string, public detail: string) {
    super(`profile schema error in ${file}: ${detail}`)
    this.name = 'ProfileSchemaError'
  }
}
export class ProfileVersionError extends Error {
  constructor(public got: number, public supported: number[]) {
    super(`unsupported profileVersion ${got}; supported: ${supported.join(', ')}`)
    this.name = 'ProfileVersionError'
  }
}

function profilesDir(): string {
  return process.env.AGENT_PROFILES_DIR || join(here, '../../profiles')
}

function sanitize(model: string): string {
  return model.replace(/[^A-Za-z0-9._-]/g, '_')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep-merge two ProfileData: subagents merge by name; interpreter/flags merge as
 *  objects; ptcAllowlist/middleware/systemPromptSuffix/profileVersion replace;
 *  lower-only keys kept. */
export function mergeProfiles(lower: ProfileData, higher: Partial<ProfileData>): ProfileData {
  const out: any = { ...lower }
  for (const [k, hv] of Object.entries(higher as Record<string, unknown>)) {
    if (k === 'subagents') {
      const lowerList = (lower.subagents ?? []) as SubagentSpec[]
      const merged: SubagentSpec[] = lowerList.map((s) => ({ ...s }))
      const byName = new Map(merged.map((s) => [s.name, s]))
      const seenInHigher = new Set<string>()
      for (const hsub of hv as SubagentSpec[]) {
        if (seenInHigher.has(hsub.name)) throw new Error(`duplicate subagent name: "${hsub.name}"`)
        seenInHigher.add(hsub.name)
        const existing = byName.get(hsub.name)
        if (existing) Object.assign(existing, hsub)   // patch (tools/middleware arrays replace via assign)
        else { merged.push({ ...hsub }); byName.set(hsub.name, merged[merged.length - 1]) }
      }
      out.subagents = merged
    } else if ((k === 'interpreter' || k === 'flags') && isPlainObject(hv) && isPlainObject((lower as any)[k])) {
      out[k] = { ...(lower as any)[k], ...hv }
    } else {
      out[k] = hv
    }
  }
  return out as ProfileData
}

function validateMerged(data: ProfileData): ProfileData {
  if (data.profileVersion !== 1) throw new ProfileVersionError(data.profileVersion, [1])
  const d: any = { ...data }
  d.systemPromptSuffix ??= ''
  d.flags ??= { injectTodayDate: true }
  if (!Array.isArray(d.ptcAllowlist) || d.ptcAllowlist.length === 0) throw new Error('profile missing ptcAllowlist')
  if (!d.interpreter?.executionTimeoutMs || typeof d.interpreter.subagents !== 'boolean')
    throw new Error('profile missing interpreter.executionTimeoutMs/subagents')
  if (!Array.isArray(d.middleware)) throw new Error('profile missing middleware')
  if (!Array.isArray(d.subagents) || d.subagents.length === 0) throw new Error('profile missing subagents')
  for (const s of d.subagents) {
    for (const f of ['description', 'systemPrompt', 'tools', 'middleware'] as const) {
      if (s[f] === undefined) throw new Error(`subagent "${s.name}" missing ${f}`)
    }
  }
  // references
  const toolNames = new Set(allTools.map((t: any) => t.name))
  for (const n of d.ptcAllowlist) if (!toolNames.has(n)) throw new Error(`unknown tool: "${n}"`)
  for (const n of d.middleware) if (!(n in MIDDLEWARE_REGISTRY)) throw new Error(`unknown middleware: "${n}"`)
  for (const s of d.subagents) {
    for (const n of s.middleware) if (!(n in MIDDLEWARE_REGISTRY)) throw new Error(`unknown middleware: "${n}"`)
    if (Array.isArray(s.tools)) for (const n of s.tools) if (!toolNames.has(n)) throw new Error(`unknown tool: "${n}"`)
  }
  const names = d.subagents.map((s: any) => s.name)
  const dup = names.find((n: string, i: number) => names.indexOf(n) !== i)
  if (dup) throw new Error(`duplicate subagent name: "${dup}"`)
  return d as ProfileData
}

function loadFile(file: string): any | undefined {
  const path = join(profilesDir(), file)
  if (!existsSync(path)) return undefined
  const raw = readFileSync(path, 'utf8')
  const data = parseJsonc(raw)
  if (validateSchema(data) !== true) {
    throw new ProfileSchemaError(file, ajv.errorsText(validateSchema.errors))
  }
  return data
}

/** Load + merge the 4-level chain: built-in -> default.jsonc -> <provider>__default.jsonc
 *  -> <provider>__<model>.jsonc. Each higher layer overrides; subagents merge by name. */
export function loadProfile(provider: string, model: string): ProfileData {
  let result: ProfileData = { ...DEFAULT_PROFILE_DATA, subagents: DEFAULT_PROFILE_DATA.subagents.map((s) => ({ ...s })) }
  for (const file of ['default.jsonc', `${provider}__default.jsonc`, `${provider}__${sanitize(model)}.jsonc`]) {
    const layer = loadFile(file)
    if (layer) result = mergeProfiles(result, layer)
  }
  return validateMerged(result)
}
```

- [ ] **Step 5: Write index.ts**

```ts
// apps/deepagent/src/profiles/index.ts
export * from './types'
export { parseJsonc } from './parse-jsonc'
export { BLOCKS, BASE_BLOCK_ORDER, assembleBase } from './blocks'
export { assembleSystemPrompt } from './prompt'
export { MIDDLEWARE_REGISTRY, type MwCtx } from './middleware'
export { buildInterpreterMiddleware, buildCoerceToolContentMiddleware, buildReadFileContinuationMiddleware } from './implementations'
export { DEFAULT_PROFILE_DATA } from './defaults'
export { resolveProfile, resolveTools } from './resolve'
export { loadProfile, mergeProfiles, ProfileSchemaError, ProfileVersionError } from './loader'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/deepagent && bun test src/profiles/loader.test.ts`
Expected: PASS — 11 pass

- [ ] **Step 7: Commit**

```bash
git add apps/deepagent/profiles/default.jsonc apps/deepagent/src/profiles/loader.ts apps/deepagent/src/profiles/index.ts apps/deepagent/src/profiles/loader.test.ts
git commit -m "feat(profiles): 4-level loader (built-in/default/provider/model) + default.jsonc"
```

---

### Task 7: Wire buildAgent + update agent.test.ts

**Files:**
- Modify: `apps/deepagent/src/agent.ts` (thin buildAgent to use loadProfile + resolveProfile + assembleSystemPrompt; remove now-unused `SYSTEM_PROMPT`, `PTC_ALLOWLIST`, `READ_ONLY_TOOLS`, `SUBAGENTS`, `QUANT_PROMPT`, `GENERAL_PURPOSE_PROMPT`, `REPORTER_PROMPT`)
- Modify: `apps/deepagent/src/agent.test.ts` (assert SUBAGENTS/PTC_ALLOWLIST/READ_ONLY_TOOLS invariants via the default profile; keep buildModel/resolveAgentConfig/workspace/WORKSPACE_PERMISSIONS/buildBackend/buildAgent tests)

**Interfaces:**
- Consumes: `loadProfile`, `resolveProfile` from `./profiles` (Tasks 5,6); `assembleSystemPrompt` from `./profiles/prompt` (Task 3); `DEFAULT_PROFILE_DATA` (Task 5) for tests.
- Produces: thinned `buildAgent` (signature unchanged); removed constants from agent.ts (now profile-derived).

**Behavior-preserving:** loading the default profile + assembling must reproduce today's exact system prompt and agent construction. A full-suite run confirms no regression.

- [ ] **Step 1: Update agent.test.ts to assert via the default profile**

Replace the import line and the `PTC_ALLOWLIST` / `READ_ONLY_TOOLS` / `SUBAGENTS` tests in `apps/deepagent/src/agent.test.ts`:

```ts
// new import line (replaces the Task-4 import line)
import { buildModel, resolveAgentConfig, workspaceDir, WORKSPACE_PERMISSIONS, buildBackend, buildAgent } from './agent'
import { resolveProfile, loadProfile } from './profiles'
import { DEFAULT_PROFILE_DATA } from './profiles/defaults'
```

Replace the three invariant tests:

```ts
test('default profile: ptcAllowlist = 10 read-only data tools, excludes sync_candles + call_api', () => {
  const p = DEFAULT_PROFILE_DATA
  expect(p.ptcAllowlist).toEqual([
    'search_instruments', 'get_ltp', 'get_ohlc_quote', 'historical_candles', 'intraday_candles',
    'option_chain', 'market_status', 'read_candles', 'company_profile', 'news',
  ])
  expect(p.ptcAllowlist).not.toContain('sync_candles')
  expect(p.ptcAllowlist).not.toContain('call_api')
})

test('default profile: READ_ONLY_TOOLS (resolved) = ptcAllowlist tools, excludes sync_candles + call_api', () => {
  const r = resolveProfile(DEFAULT_PROFILE_DATA)
  const gp = r.subagents.find((s) => s.name === 'general-purpose')!
  const names = (gp.tools as any[]).map((t) => t.name).sort()
  expect(names).toEqual([...DEFAULT_PROFILE_DATA.ptcAllowlist].sort())
  expect(names).not.toContain('sync_candles')
  expect(names).not.toContain('call_api')
})

test('default profile: exactly 3 named subagents, no duplicates', () => {
  const r = resolveProfile(DEFAULT_PROFILE_DATA)
  const names = r.subagents.map((s) => s.name)
  expect(names).toHaveLength(3)
  expect(new Set(names).size).toBe(3)
  expect(names.sort()).toEqual(['general-purpose', 'quant', 'reporter'])
})

test('default profile: general-purpose + quant use readOnly tools; reporter tools empty', () => {
  const r = resolveProfile(DEFAULT_PROFILE_DATA)
  const byName = Object.fromEntries(r.subagents.map((s) => [s.name, s]))
  expect((byName['general-purpose'].tools as any[]).map((t) => t.name).sort()).toEqual([...DEFAULT_PROFILE_DATA.ptcAllowlist].sort())
  expect((byName['quant'].tools as any[]).map((t) => t.name).sort()).toEqual([...DEFAULT_PROFILE_DATA.ptcAllowlist].sort())
  expect(byName['reporter'].tools).toEqual([])
})

test('default profile: quant has middleware; general-purpose + reporter have none', () => {
  const r = resolveProfile(DEFAULT_PROFILE_DATA)
  const byName = Object.fromEntries(r.subagents.map((s) => [s.name, s]))
  expect(byName['quant'].middleware.length).toBeGreaterThan(0)
  expect(byName['general-purpose'].middleware).toEqual([])
  expect(byName['reporter'].middleware).toEqual([])
})

test('default profile: parent middleware = 3 built in order', () => {
  const r = resolveProfile(DEFAULT_PROFILE_DATA)
  expect(r.parentMiddleware).toHaveLength(3)
  expect(r.parentMiddleware.every((m) => m)).toBe(true)
})

test('loadProfile: default profile loads + resolves without throwing', () => {
  const p = loadProfile('ollama', 'llama3')  // no model file -> default.jsonc chain
  const r = resolveProfile(p)
  expect(r.subagents.map((s) => s.name).sort()).toEqual(['general-purpose', 'quant', 'reporter'])
})
```

Keep all `buildModel`, `resolveAgentConfig`, `workspaceDir`, `WORKSPACE_PERMISSIONS`, `buildBackend`, `buildAgent` (constructs) tests unchanged. Delete the old `buildInterpreterMiddleware` truthy tests (moved to `middleware.test.ts` in Task 4) and the old `PTC_ALLOWLIST`/`READ_ONLY_TOOLS`/`SUBAGENTS` tests (replaced above).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/deepagent && bun test src/agent.test.ts`
Expected: FAIL — the old `PTC_ALLOWLIST`/`SUBAGENTS` imports no longer exist after Step 3, or the new tests reference `resolveProfile`/`DEFAULT_PROFILE_DATA` (present) but `agent.ts` still exports old constants (Step 3 not done). This step locks the test rewrite; the agent.ts refactor in Step 3 makes the suite green.

- [ ] **Step 3: Thin agent.ts**

In `apps/deepagent/src/agent.ts`:
- Remove the `SYSTEM_PROMPT`, `QUANT_PROMPT`, `GENERAL_PURPOSE_PROMPT`, `REPORTER_PROMPT` constants.
- Remove `PTC_ALLOWLIST`, `READ_ONLY_TOOLS`, `SUBAGENTS`.
- Remove the now-unused `buildInterpreterMiddleware`/`buildCoerceToolContentMiddleware`/`buildReadFileContinuationMiddleware` imports (moved in Task 4; agent.ts no longer calls them directly).
- Add: `import { loadProfile, resolveProfile } from './profiles'` and `import { assembleSystemPrompt } from './profiles/prompt'`.
- Rewrite `buildAgent`:

```ts
export async function buildAgent(cfg: AgentConfig) {
  if (!cfg.model) throw new Error('Agent config missing model')
  const model = buildModel(cfg)
  const root = workspaceDir()
  mkdirSync(root, { recursive: true })
  const profile = resolveProfile(loadProfile(cfg.provider, cfg.model))
  const systemPrompt = assembleSystemPrompt(profile, todayIST())
  return createDeepAgent({
    model,
    tools: allTools,
    systemPrompt,
    backend: buildBackend(root),
    permissions: WORKSPACE_PERMISSIONS,
    middleware: profile.parentMiddleware,
    subagents: profile.subagents,
  })
}
```

- Keep `buildModel`, `resolveAgentConfig`, `workspaceDir`, `defaultWorkspacePath`, `settingsPath`, `WORKSPACE_PERMISSIONS`, `buildBackend`, `todayIST`, `AgentConfig`, `Provider`, `OLLAMA_DEFAULT` unchanged. Keep `import { allTools } from './tools'` and `import { createDeepAgent, FilesystemBackend } from 'deepagents'` etc.

- [ ] **Step 4: Run full suite**

Run: `cd apps/deepagent && bun test`
Expected: PASS — all green. The default profile reproduces today's agent: same ptcAllowlist (10), same 3 subagents, same parent middleware (3), same system prompt (byte-for-byte via assembleBase), same provider clients. No `apps/api`/`apps/web`/eval change.

- [ ] **Step 5: Verify no behavior change smoke (grep)**

Run: `cd apps/deepagent && grep -n "PTC_ALLOWLIST\|READ_ONLY_TOOLS\|SUBAGENTS\|SYSTEM_PROMPT" src/agent.ts || echo "clean"`
Expected: `clean` (all removed from agent.ts; they live in `profiles/` now).

- [ ] **Step 6: Commit**

```bash
git add apps/deepagent/src/agent.ts apps/deepagent/src/agent.test.ts
git commit -m "refactor(agent): buildAgent loads profile (provider+model); remove hardcoded harness"
```

---

## Self-Review (run before handoff)

**1. Spec coverage:** Each spec section maps to a task — JSONC parser (T1), types+schema+ajv (T2), blocks+prompt seam (T3), middleware registry (T4), defaults+resolve (T5), 4-level loader+default.jsonc (T6), buildAgent wiring (T7). profileVersion (T2 schema, T6 validateMerged), two-layer validation (T2 schema + T6 references), modular blocks evolution seam (T3 blocks.ts/prompt.ts + documented PromptSpec type in T2). No spec gap.

**2. Placeholder scan:** Every code step has complete code; no TBD/TODO. Commands have expected outputs.

**3. Type consistency:** `ProfileData`/`ResolvedProfile` defined T2, used T5/T6/T7. `MwCtx` defined T4, used T4/T5. `MIDDLEWARE_REGISTRY` keys (`interpreter`/`coerceToolContent`/`readFileContinuation`) match default.jsonc + DEFAULT_PROFILE_DATA `middleware` arrays (T5/T6). `buildInterpreterMiddleware` signature widened in T4 (`{ptc, executionTimeoutMs, subagents}`) — matches the registry call in T4. `resolveTools` consumes `ToolSetSpec` (T2) matching default.jsonc `"readOnly"`/`"none"` literals. `loadProfile(provider, model)` matches `buildAgent`'s `cfg.provider`/`cfg.model` (T7). `assembleSystemPrompt(profile, today)` matches the ResolvedProfile shape (T5) + `todayIST()` (agent.ts). ✓

**4. Behavior preservation:** `assembleBase()` byte-for-byte == today's `SYSTEM_PROMPT` (T3 test). `default.jsonc` == `DEFAULT_PROFILE_DATA` (T6 test). `loadProfile` default → resolves to today's 10 ptc tools / 3 subagents / 3 parent middleware (T7 tests). `buildAgent` constructs with the default profile (T7). ✓

**5. Dependency order:** T1 (none) → T2 (ajv) → T3 (types) → T4 (types, moved impls) → T5 (types, registry, allTools) → T6 (parse-jsonc, schema, defaults) → T7 (loader, resolve, prompt). Each task's tests pass independently on its own commit. ✓

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-13-harness-profile.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh implementer subagent per task (haiku — plan has complete code = transcription), review between tasks (sonnet), fast iteration. This mirrors how sub-project A and the eval-v3 upgrade were executed.

**2. Inline Execution** — I execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**