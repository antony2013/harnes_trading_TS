# Harness Profile System — Design (Sub-project B)

**Date:** 2026-07-13
**Status:** Design (pending user review of this spec)
**Scope:** Externalize the deepagent harness configuration (system prompt suffix, PTC allowlist, interpreter settings, parent/subagent middleware, subagent definitions, feature flags) from hardcoded values in `apps/deepagent/src/agent.ts` into **JSONC profile files** loaded at runtime by `buildAgent`, keyed by provider+model. Runtime code (`buildModel`, `buildBackend`, workspace, tool *implementations*, middleware *implementations*) is unchanged — only the tunable *configuration* moves to data. The profile file becomes the sole writable target for the future Ralph loop (sub-project C).

## Background

`apps/deepagent/src/agent.ts` currently hardcodes the entire harness: `SYSTEM_PROMPT`, `PTC_ALLOWLIST` (10 tools), `READ_ONLY_TOOLS` (derived), `buildInterpreterMiddleware` options (`ptc`, `executionTimeoutMs: 30_000`, `subagents`), the three toggle-able middlewares (`buildCoerceToolContentMiddleware`, `buildReadFileContinuationMiddleware`), and the `SUBAGENTS` roster (`general-purpose`, `quant`, `reporter`). `buildAgent(cfg)` constructs `createDeepAgent` directly from these constants.

NVIDIA's NemoClaw "harness profile" model (see `developer.nvidia.com` blog on Nemotron-3-Ultra harness profiles) makes these knobs a **per-model file** that a "ralph loop" can tune without touching code. Our `buildReadFileContinuationMiddleware` is already a TS port of the one middleware NVIDIA's blog fully codes. Sub-project A (eval harness, merged `325c666`) + the v3-streamEvents upgrade (merged `b8e97d8`) gave us the eval suite and scope-tagged trajectory capture the ralph loop consumes. Sub-project B is the prerequisite that remains: **make the harness a data file.**

`buildAgent(cfg)` is called by the CLI REPL (`src/index.ts`) and the eval suite (`src/eval/run.ts`, via a `buildAgentFn` test seam whose comment already says *"The ralph loop (C) will add a `profile?` here"*). Selection key = `cfg.provider` + `cfg.model` (from `AgentConfig`). The refactor preserves the `buildAgent(cfg: AgentConfig)` signature so neither caller changes.

## Locked decisions

| Decision | Choice |
|---|---|
| Profile format | **JSONC** — JSON with `//` and `/* */` comments. Pure data, self-documenting per field, line-edit-safe for the ralph loop. Parsed by a tiny no-dep comment-stripper. |
| Profile resolution | **`default.jsonc` base + per-model deep-merge override.** Always load `default.jsonc`; if `<provider>__<model>.jsonc` exists, deep-merge it on top. If `default.jsonc` is missing, fall back to a compiled-in `DEFAULT_PROFILE_DATA`. |
| Array merge | Objects deep-merge; `ptcAllowlist`/`middleware` **replace wholesale**; `subagents` **merge by name** (patch fields, new names append, omitted names kept); `flags` deep-merges (leaf booleans replace). |
| Prompt model | **Fixed compiled-in base + tunable suffix.** `BASE_SYSTEM_PROMPT` (all domain/operational instructions) stays in code, untunable. Profile holds `systemPromptSuffix` (string). Dynamic IST-date prefix stays in code; on/off via `flags.injectTodayDate`. |
| `profileVersion` | Integer top-level field, `const: 1` from day one. Required on the merged result, optional on individual files (inherit default's). Future v2 handled by `migrate(old)→new` keyed on this field. Not ralph-tunable. |
| Validation | **Two layers.** (1) Structural via JSON Schema (`schema.json`, draft 2020-12, validated with `ajv`). (2) Semantic references in code post-merge (middleware/tool names exist in registries; completeness; subagent name uniqueness). |
| Validator dep | **`ajv`** (+1 new dep; Bun-compatible; supports draft 2020-12, `oneOf`, `const`, `additionalProperties`). Schema file doubles as the ralph-loop proposer's contract. |
| Suffix default | `default.jsonc.systemPromptSuffix = ""` — assembled prompt == today's `SYSTEM_PROMPT` byte-for-byte. The "Be concise. Prefer tools over guessing." line stays a **base block**. Suffix is purely additive per-model tuning. |
| Base prompt structure | **~11 fine blocks** in an internal `BLOCKS` registry + fixed `BASE_BLOCK_ORDER`. The base is internally modular from day one so the future can expose block-control to profiles via additive schema widening (no format break). |

## Architecture overview

```
buildAgent(cfg)
  └─ model = buildModel(cfg)                              [unchanged code]
  └─ root = workspaceDir(); mkdirSync(root)               [unchanged code]
  └─ profile = resolveProfile(loadProfile(provider, model))   [NEW]
       ├─ loadProfile  → ProfileData  (validated names, pure data)
       │    ├─ resolve path (AGENT_PROFILES_DIR || apps/deepagent/profiles)
       │    ├─ read default.jsonc  (missing → compiled-in DEFAULT_PROFILE_DATA)
       │    ├─ read <provider>__<model>.jsonc if exists
       │    ├─ parse-jsonc each (strip comments → JSON.parse)
       │    ├─ ajv structural-validate each file against schema.json
       │    ├─ deepMerge(base, override)  (subagents by-name)
       │    └─ validateMerged: profileVersion===1, completeness, references
       └─ resolveProfile → ResolvedProfile  (names → Tool objects, built middleware)
            ├─ parentMiddleware = profile.middleware.map(name => MIDDLEWARE_REGISTRY[name](ctx))
            └─ subagents = profile.subagents.map(resolveSubagent)  (tools via resolveTools, middleware via registry, interpreter forces subagents:false)
  └─ systemPrompt = assembleSystemPrompt(profile, todayIST())   [NEW seam]
  └─ createDeepAgent({ model, tools: allTools, systemPrompt, backend, permissions,
                       middleware: profile.parentMiddleware, subagents: profile.subagents })   [unchanged surface]
```

Two stages are deliberate: `loadProfile` returns validated `ProfileData` (pure data — names), `resolveProfile` returns `ResolvedProfile` (real Tool objects + built middleware). The ralph loop (C) loads + validates a candidate file without building an agent, and tests assert data vs runtime separately.

## Profile file shape — `apps/deepagent/profiles/default.jsonc`

Seeded verbatim from today's hardcoded values; `systemPromptSuffix` is empty so the assembled prompt reproduces today's `SYSTEM_PROMPT` exactly.

```jsonc
{
  // Schema: src/profiles/schema.json. Bumped on breaking format changes; additive
  // widenings (new optional fields) do not bump. Not ralph-tunable.
  "profileVersion": 1,

  // Appended after the compiled-in BASE_SYSTEM_PROMPT (domain instructions live in
  // code, not here). Empty here → assembled prompt == today's SYSTEM_PROMPT exactly.
  "systemPromptSuffix": "",

  // Tools exposed inside the eval (QuickJS) interpreter. Names must exist in allTools.
  // Single source of truth — the "readOnly" tool-set below derives from this list.
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
    "subagents": true        // parent task() global enabled. Subagents always forced subagents:false.
  },

  // Parent middleware, by name, in order. Names from the fixed MIDDLEWARE_REGISTRY.
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
    "injectTodayDate": true   // prepend "Today's date is <IST>..." prefix. Only known flag in v1.
  }
}
```

A per-model override file is a **partial** profile — only the fields it wants to change. Example `apps/deepagent/profiles/anthropic__claude-opus-4-8.jsonc`:

```jsonc
{
  "profileVersion": 1,
  "systemPromptSuffix": "Prefer tools over recall. Ask one clarifying question when the request is ambiguous.",
  "interpreter": { "executionTimeoutMs": 30000, "subagents": true },
  "subagents": [
    { "name": "quant", "description": "...", "systemPrompt": "...", "tools": "readOnly",
      "middleware": ["interpreter", "coerceToolContent", "readFileContinuation"] }
  ]
}
```
(Here `quant` is merged by name — its fields patch the default `quant`; `general-purpose` and `reporter` are kept from default; `ptcAllowlist`/`middleware` are kept from default because the override omits them.)

### Filename convention
`<provider>__<sanitized-model>.jsonc` where `provider` ∈ `anthropic|openai|openrouter|ollama|custom` (the `Provider` union) and `sanitized-model` replaces every `[^A-Za-z0-9._-]` with `_` (handles openrouter model ids like `anthropic/claude-3.5-sonnet` → `anthropic_claude-3.5-sonnet`). Examples: `anthropic__claude-opus-4-8.jsonc`, `openai__gpt-4o.jsonc`, `ollama__llama3.jsonc`, `openrouter__anthropic_claude-3.5-sonnet.jsonc`, `custom__glm-5.2.jsonc`.

## JSON Schema — `apps/deepagent/src/profiles/schema.json`

Draft 2020-12. All fields optional so the same schema validates both full (`default.jsonc`) and partial (per-model) files — a per-model override may patch just `interpreter.executionTimeoutMs` or a single subagent's `systemPrompt`, and deep-merge fills the rest. The only per-item `required` is a subagent's `name` (it is the merge-by-name key). `additionalProperties: false` rejects unknown fields/typos. Enums fix closed sets. The merged result is additionally checked for completeness + references in code (see Loader), since a static schema cannot enforce "filled by merge" or know the runtime tool/middleware name-sets.

```jsonc
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

## Types — `apps/deepagent/src/profiles/types.ts`

```ts
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

/** FUTURE evolution (not built in B). Documented here so the additive widening is
 *  designed, not retrofitted. systemPromptSuffix widens from string to string | PromptSpec. */
export interface PromptSpec {
  include?: string[]                  // base blocks to use (default: all in BASE_BLOCK_ORDER)
  exclude?: string[]                  // base blocks to drop
  overrides?: Record<string, string>  // replace a named block's content
  suffix?: string                     // the old free-text suffix
}
```

## Loader — `apps/deepagent/src/profiles/loader.ts`

`loadProfile(provider: string, model: string): ProfileData`

1. **Path resolution.** `dir = process.env.AGENT_PROFILES_DIR || join(dirname(fileURLToPath(import.meta.url)), '../../profiles')` (from `src/profiles/loader.ts`, `../../profiles` → `apps/deepagent/profiles`). `sanitize(model) = model.replace(/[^A-Za-z0-9._-]/g, '_')`. Candidate files: `<dir>/default.jsonc` and `<dir>/<provider>__<sanitized-model>.jsonc`.

2. **Read + parse.** Read `default.jsonc`; if missing/enoent, use the compiled-in `DEFAULT_PROFILE_DATA` from `defaults.ts` (so the system never hard-fails). Read the per-model file if it exists. Parse each via `parseJsonc` (strip comments → `JSON.parse`).

3. **Structural validate each file** against `schema.json` with `ajv`. On failure, throw `ProfileSchemaError(file, ajv.errorsText())` (names the file + the violating keyword/field).

4. **Deep-merge** `base ← default, override ← per-model` (if present) via `mergeProfiles(base, override)`:
   - For each key in `override`:
     - `subagents`: array-merge **by name** (see below).
     - `interpreter`, `flags`: plain objects → recurse (leaf replace).
     - `ptcAllowlist`, `middleware`, `systemPromptSuffix`, `profileVersion`: replace.
     - any other (schema-forbidden, so unreachable): replace.
   - Keys present only in `base` are kept.
   - **`subagents` by-name merge:** build an ordered list from `base` subagents. For each `override` subagent: if a base subagent with the same `name` exists, deep-merge its fields (`description`/`systemPrompt` replace; `tools`/`middleware` replace; `name` constant); else append it (preserving override order). Result: base order, new subagents appended in override order. Within a single subagent, `tools` and `middleware` are arrays → replace.

5. **Validate merged** (`validateMerged(data)`):
   - `profileVersion === 1` else `throw new ProfileVersionError(data.profileVersion, [1])`.
   - Completeness: `ptcAllowlist` is a non-empty array; `interpreter` present **with both** `executionTimeoutMs` and `subagents`; `subagents` is a non-empty array **and each entry has all of** `description`, `systemPrompt`, `tools`, `middleware` (a partial subagent is allowed in an override file because merge-by-name fills it from the base, but the *merged* result must be complete — this catches a new subagent introduced by an override without all fields); `middleware` is an array. Defaults applied for missing optionals: `systemPromptSuffix ??= ''`, `flags ??= { injectTodayDate: true }`.
   - References: every name in `ptcAllowlist` ∈ `allTools` names; every name in `middleware` ∈ `MIDDLEWARE_REGISTRY` keys; for each subagent, every name in its `middleware` ∈ `MIDDLEWARE_REGISTRY` keys and (if `tools` is an array) every name ∈ `allTools`; subagent `name`s unique. Fail-fast with `"unknown middleware: \"xyz\""` / `"unknown tool: \"xyz\""` / `"duplicate subagent name: \"quant\""` style messages. (Flag names are enforced structurally by `schema.json`'s `additionalProperties: false` on `flags`.)

6. Return the `ProfileData`.

## resolveProfile — `apps/deepagent/src/profiles/resolve.ts`

`resolveProfile(data: ProfileData): ResolvedProfile`

- `parentMiddleware = data.middleware.map(name => MIDDLEWARE_REGISTRY[name]({ ...data, parent: true }))`, in order.
- For each `SubagentSpec`: `tools = resolveTools(spec.tools, data.ptcAllowlist)`; `middleware = spec.middleware.map(name => MIDDLEWARE_REGISTRY[name]({ ...data, parent: false }))` — note the `interpreter` builder forces `subagents: false` when `parent === false`.
- Return `ResolvedProfile`.

## Middleware registry — `apps/deepagent/src/profiles/middleware.ts`

The three middleware *implementations* (today in `agent.ts`) move here unchanged; a fixed registry maps names → builder functions. Builders take a context (the loaded `ProfileData` + `parent` flag) so the interpreter reads `ptcAllowlist`/`executionTimeoutMs`/`subagents` from the profile.

```ts
import { buildInterpreterMiddleware, buildCoerceToolContentMiddleware, buildReadFileContinuationMiddleware } from './implementations'  // the moved impls

interface MwCtx { ptcAllowlist: string[]; interpreter: InterpreterSpec; parent: boolean }

export const MIDDLEWARE_REGISTRY: Record<string, (ctx: MwCtx) => unknown> = {
  interpreter: (ctx) => buildInterpreterMiddleware({
    ptc: ctx.ptcAllowlist,
    executionTimeoutMs: ctx.interpreter.executionTimeoutMs,
    subagents: ctx.parent ? ctx.interpreter.subagents : false,   // subagents can't dispatch
  }),
  coerceToolContent: () => buildCoerceToolContentMiddleware(),
  readFileContinuation: () => buildReadFileContinuationMiddleware(),
}
```

The `interpreter` builder honors the single-source-of-truth invariant: `ptc` comes from the loaded profile's `ptcAllowlist`, and the `readOnly` tool-set derives from the same list (see below) — so a per-model profile that narrows `ptcAllowlist` narrows both the eval interpreter's tools and the `readOnly` subagent tool-set consistently.

## Tool-set resolver — inside `resolve.ts`

```ts
function resolveTools(spec: ToolSetSpec, ptcAllowlist: string[]): unknown[] {
  if (spec === 'readOnly') return allTools.filter((t: any) => ptcAllowlist.includes(t.name))
  if (spec === 'all') return allTools
  if (spec === 'none') return []
  // explicit array
  const byName = new Map(allTools.map((t: any) => [t.name, t]))
  return spec.map((name) => {
    const t = byName.get(name)
    if (!t) throw new Error(`unknown tool: "${name}"`)
    return t
  })
}
```

`readOnly` derives from *this profile's* `ptcAllowlist` — preserving the Phase-A single-source invariant (today `READ_ONLY_TOOLS = allTools.filter(t => PTC_ALLOWLIST.includes(t.name))`).

## Prompt loader — `apps/deepagent/src/profiles/blocks.ts` + `prompt.ts`

The base prompt is internally block-composed from day one; `assembleSystemPrompt` is the single evolution seam. Today the profile only appends a `systemPromptSuffix` string; the future exposes block-control via additive schema widening (see *Evolution path*).

### `blocks.ts` — the modular base

Splits today's `SYSTEM_PROMPT` (agent.ts:14-25) into ~11 named blocks. `assembleBase()` joins them in fixed order and **reproduces today's `SYSTEM_PROMPT` byte-for-byte** (locked by a test).

```ts
export const BLOCKS: Record<string, string> = {
  identity:          "You are a trading assistant for the Indian stock market, backed by the local Upstox trading API. Use the provided tools to answer the user's question.",
  instruments:       "- Instrument keys look like \"NSE_EQ|INE002A01018\" or \"NSE_INDEX|Nifty 50\". Use search_instruments if you don't know the key.",
  timeframes:        "- Timeframes are canonical labels: v2 raw (1minute, 30minute, day, week, month) or v3 {interval}{unit} (e.g. 5minutes, 1days).",
  dates:             "- Dates are YYYY-MM-DD.",
  "candle-storage":  "- To store candles for a backtest, use sync_candles (source=v2|v3) or sync_expired_candles for EXPIRED instruments (interval 1minute|3minute|5minute|15minute|30minute|day — no week/month, no unit); to read stored candles, use read_candles (timeframe=interval, e.g. \"3minute\" or \"day\" for expired).",
  "error-retry":     "- If a tool returns an error object, read it and retry with corrected parameters.",
  "api-unreachable": "- If the API is unreachable, tell the user to start apps/api (bun run dev in apps/api).",
  behavior:          "- Be concise. Prefer tools over guessing.",
  filesystem:        "- You have a virtual filesystem (ls, read_file, write_file, edit_file, glob, grep) rooted at a workspace directory. Use it to persist analysis, notes, and intermediate results across the conversation. Prefer write_file for new artifacts and edit_file for small changes.",
  eval:              "- You have an `eval` tool that runs JavaScript in a sandboxed QuickJS interpreter (no filesystem, network, or shell access). The read-only market-data tools are available inside `eval` as `tools.*` (e.g. `tools.get_ltp`, `tools.historical_candles`, `tools.search_instruments`). Use `eval` for loops, parallel/batched fetches, and deterministic transforms (indicators, aggregation, filtering) instead of one tool call per turn. For multi-step data work, write a workflow in `eval`.",
  subagents:         "- You can delegate to specialist subagents with the `task` tool, or from inside `eval` via the `task()` global: `task({ description, subagentType, responseSchema })` runs a full agentic loop on a subagent and resolves to its result. Subagents: `general-purpose` (research/fetch market data), `quant` (fetch candles + compute indicators in its own eval), `reporter` (write reports/artifacts to the workspace filesystem). Use `Promise.all` in `eval` to fan out across instruments, then synthesize. Prefer `task()` orchestration for multi-step, multi-symbol analysis instead of doing it all yourself turn-by-turn.",
}

// Fixed order. assembleBase joins with "\n" — reproduces today's SYSTEM_PROMPT exactly.
export const BASE_BLOCK_ORDER = [
  "identity", "instruments", "timeframes", "dates", "candle-storage",
  "error-retry", "api-unreachable", "behavior", "filesystem", "eval", "subagents",
]

export function assembleBase(): string {
  return BASE_BLOCK_ORDER.map((b) => BLOCKS[b]).join("\n")
}
```

### `prompt.ts` — the evolution seam

```ts
import type { ResolvedProfile } from './types'
import { assembleBase } from './blocks'

/** The prompt loader. Today: datePrefix + base blocks (fixed order) + suffix.
 *  This is the ONLY place prompt composition lives — the evolution seam. Future
 *  block-control (PromptSpec) plugs in here without changing the profile format. */
export function assembleSystemPrompt(profile: ResolvedProfile, today: string): string {
  const datePrefix = profile.flags.injectTodayDate
    ? `Today's date is ${today} (IST, Indian market calendar). Treat this as the real current date for "current date"/"today" questions and as the default toDate for recent data.\n\n`
    : ''
  const base = assembleBase()                       // fixed block order today
  const suffix = profile.systemPromptSuffix          // string today
  return datePrefix + base + (suffix ? `\n\n${suffix}` : '')
}
```

### Evolution path (additive, no format break) — not built in B

A future step widens `systemPromptSuffix` from `string` to `string | PromptSpec`:

```ts
type PromptSpec = {
  include?:   string[]                 // base blocks to use (default: all in BASE_BLOCK_ORDER)
  exclude?:   string[]                 // base blocks to drop
  overrides?: Record<string, string>   // replace a named block's content
  suffix?:    string                   // the old free-text suffix
}
```

The `schema.json` change is **additive** — `systemPromptSuffix` becomes `oneOf: [{type: string}, {$ref: #/definitions/promptSpec}]`; every existing `"systemPromptSuffix": "..."` profile still validates. `assembleSystemPrompt` gains block-selection/override; `assembleBase()` becomes `assembleBase(spec)`. **No existing profile file changes** — new profiles opt in to the object form. The `BLOCKS` registry already existing in B is what makes this a real evolution rather than a retrofit. `BLOCKS` and `BASE_BLOCK_ORDER` remain **code** (not ralph-writable) in B; when block-control is exposed, those block ops become part of the writable profile — still the one writable target.

## `buildAgent` refactor — `apps/deepagent/src/agent.ts`

Runtime stays; configuration comes from the profile. Signature unchanged.

```ts
import { loadProfile, resolveProfile, assembleSystemPrompt } from './profiles'

export async function buildAgent(cfg: AgentConfig) {
  if (!cfg.model) throw new Error('Agent config missing model')
  const model = buildModel(cfg)                                       // unchanged
  const root = workspaceDir()
  mkdirSync(root, { recursive: true })
  const profile = resolveProfile(loadProfile(cfg.provider, cfg.model))  // NEW
  const systemPrompt = assembleSystemPrompt(profile, todayIST())       // NEW
  return createDeepAgent({
    model,
    tools: allTools,                  // unchanged — parent always gets all tools
    systemPrompt,
    backend: buildBackend(root),      // unchanged
    permissions: WORKSPACE_PERMISSIONS,   // unchanged — security, not tunable
    middleware: profile.parentMiddleware,   // built from profile.middleware names
    subagents: profile.subagents,          // resolved {name,description,systemPrompt,tools,middleware}
  })
}
```

`buildModel`, `buildBackend`, `workspaceDir`, `WORKSPACE_PERMISSIONS`, `allTools`, `todayIST`, `resolveAgentConfig`, and the three middleware *implementations* (moved to `profiles/middleware.ts` / `profiles/implementations.ts`) are all unchanged in behavior. `agent.ts` is thinned to: provider/model construction, workspace, the agent builder, config resolution, date helper.

## Tunable vs fixed boundary

| Today (hardcoded in agent.ts) | After B |
|---|---|
| `SYSTEM_PROMPT` body | → `BASE_SYSTEM_PROMPT` = `BLOCKS`+`BASE_BLOCK_ORDER` stays **code** (domain instr, untunable); `systemPromptSuffix` → **profile** |
| `PTC_ALLOWLIST` (10) | → `ptcAllowlist` → **profile** |
| `buildInterpreterMiddleware` opts | → `interpreter.{executionTimeoutMs, subagents}` → **profile**; `ptc` from `ptcAllowlist` |
| coerce / readFile on/off + order | → `middleware` (parent) → **profile** |
| `SUBAGENTS` (3) | → `subagents[]` (name/description/systemPrompt/tools/middleware) → **profile** |
| `READ_ONLY_TOOLS` | derived per-profile from `ptcAllowlist` (code resolver) |
| `WORKSPACE_PERMISSIONS` | **stays code** (security boundary — not ralph-tunable) |
| `workspaceDir` / `buildBackend` | **stays code** (runtime) |
| `buildModel` / provider clients | **stays code** |
| `todayIST` date injection | **stays code**; on/off via `flags.injectTodayDate` |
| tool *implementations* (`allTools`) | **stays code** — profile references by name only |
| middleware *implementations* | **stays code** — profile toggles by name only |
| `profileVersion` | **profile** (metadata, `const: 1`, not ralph-tunable) |

**Rule:** the profile can only *reference* names (tools, middleware, flags) the code registers — never define code. This makes NemoClaw's "write access scoped to the profile file" + "prefer general fix" constraints structural.

## File structure

```
apps/deepagent/
  profiles/                              # NEW — data dir, outside src/ (loaded via fs at runtime)
    default.jsonc                        # seeded verbatim from today's hardcoded values
    <provider>__<model>.jsonc            # per-model overrides (added as needed; ralph loop writes these)
  src/
    agent.ts                             # thinned: buildModel, buildAgent, resolveAgentConfig, workspace, buildBackend, todayIST
    profiles/                            # NEW
      schema.json                        # JSON Schema (contract + structural validation)
      types.ts                           # ProfileData, ResolvedProfile, SubagentSpec, PromptSpec(future)
      parse-jsonc.ts                     # comment-strip + JSON.parse (no dep)
      blocks.ts                          # BLOCKS registry + BASE_BLOCK_ORDER + assembleBase
      prompt.ts                          # assembleSystemPrompt (the evolution seam)
      defaults.ts                        # DEFAULT_PROFILE_DATA (compiled-in fallback if default.jsonc missing)
      middleware.ts                      # MIDDLEWARE_REGISTRY (names → builders)
      implementations.ts                 # the 3 middleware impls (moved from agent.ts, unchanged)
      loader.ts                          # loadProfile: path → parse → schema-validate → merge → validateMerged
      resolve.ts                         # resolveProfile: names → Tool objects, build middleware; resolveTools
      index.ts                           # re-exports
      parse-jsonc.test.ts
      blocks.test.ts                     # assembleBase == today's SYSTEM_PROMPT byte-for-byte
      loader.test.ts                     # resolution, deep-merge (incl subagents by-name), validation, version
      resolve.test.ts                    # name→Tool resolution, registry, interpreter subagents:false for subagents
      middleware.test.ts                 # moved impl tests (readFileContinuation etc.)
    agent.test.ts                        # updated: assertions move to "load default.jsonc → resolve → equals today's agent"
```

`profiles/` (data) lives **outside** `src/` so it's clearly data, not code, and is not part of the TS build (mirrors how `apps/api/data/` is outside the build). `AGENT_PROFILES_DIR` env overrides the path (mirrors `AGENT_WORKSPACE_DIR` / `AGENT_SETTINGS_PATH`).

## Global constraints

- **Location:** new code under `apps/deepagent/src/profiles/`; data under `apps/deepagent/profiles/`. (deepagent tsconfig `include: ["src"]`, `rootDir: "./src"` — `profiles/*.jsonc` is loaded via fs, not compiled.)
- **New dependency:** `ajv` (JSON Schema validator). Add via `bun add ajv` (never hand-write `package.json`). No other new deps.
- **Behavior-preserving:** loading `default.jsonc` and resolving must produce an agent identical to today's (locked by a byte-for-byte `assembleBase` test + a "load default → resolve → equals today's invariants" test).
- **No `apps/api` change** (it calls `buildAgent` — same signature). No `apps/web` change.
- **`buildAgent(cfg: AgentConfig)` signature unchanged** — CLI and eval suite callers untouched.
- **Security boundary stays in code:** `WORKSPACE_PERMISSIONS`, `workspaceDir`, `buildBackend` are not ralph-tunable. The profile can only reference registered names.
- **Middleware/tool *implementations* stay code** — the profile toggles by name only. Never `eval` of profile content.
- **`profileVersion` is metadata, not ralph-tunable** (`const: 1`).
- **Existing test invariants preserved:** `PTC_ALLOWLIST` = 10 tools excluding `sync_candles`+`call_api`; `READ_ONLY_TOOLS` derived from it; 3 named subagents; quant has middleware, general-purpose+reporter none; `marketTools`/or-1 `call_api` membership (from the merged eval v3 work) unchanged.

## Testing strategy (LLM-free, deterministic)

- **`parse-jsonc.test.ts`** — strips `//` line comments, `/* */` block comments, handles trailing commas; passes valid JSONC; rejects malformed JSON after stripping.
- **`blocks.test.ts`** — `assembleBase()` === today's `SYSTEM_PROMPT` exactly (byte-for-byte); every `BASE_BLOCK_ORDER` entry exists in `BLOCKS`; no duplicate block names.
- **`loader.test.ts`**:
  - default-only load (`provider=ollama, model=llama3`, no per-model file) → `ProfileData` equals today's hardcoded values (ptcAllowlist 10, interpreter 30s/subagents true, parent middleware 3 names, subagents 3, flags injectTodayDate true, profileVersion 1, systemPromptSuffix "").
  - `AGENT_PROFILES_DIR` override + a per-model override file → deep-merge: arrays replace, subagents merge-by-name (patch + new + keep), objects merge, missing keys kept.
  - schema validation: a malformed file (bad type, unknown field, unknown tool-set name) → `ProfileSchemaError` naming the file + field.
  - reference validation: unknown middleware/tool name, duplicate subagent name, bad `profileVersion` → corresponding error.
  - missing `default.jsonc` → falls back to compiled-in `DEFAULT_PROFILE_DATA`.
- **`resolve.test.ts`** — `resolveProfile(default)` → parent middleware built in order; `readOnly` resolves to the 10 PTC tools; `none` → `[]`; explicit tool-name list resolves + fails on unknown; a subagent's `interpreter` middleware forces `subagents: false`.
- **`middleware.test.ts`** — `MIDDLEWARE_REGISTRY` has exactly `interpreter`/`coerceToolContent`/`readFileContinuation`; `readFileContinuation` appends notice at `==limit` (moved test); `coerceToolContent` truthy.
- **`agent.test.ts` (updated)** — `buildAgent` with default profile constructs without throwing; the moved constants (`PTC_ALLOWLIST`, `SUBAGENTS`, `READ_ONLY_TOOLS`) are now read via the default profile and assert the same invariants (10 tools, 3 subagents, quant middleware, call_api excluded). `resolveAgentConfig` tests unchanged.
- **No real-LLM run** — all tests use the loader/resolver directly or `buildAgent` construction (no key needed); unchanged from sub-project A's LLM-free pattern.

## Migration

Zero-downtime, behavior-identical:
1. Add `profiles/` files + `src/profiles/` modules (new, additive).
2. Move the three middleware implementations from `agent.ts` to `profiles/implementations.ts` (cut/paste, unchanged).
3. Thin `agent.ts`: `buildAgent` loads+resolves a profile; remove the now-derived `PTC_ALLOWLIST`/`READ_ONLY_TOOLS`/`SUBAGENTS` constants from `agent.ts` (or re-export from `profiles/` for back-compat if any non-test importer exists — none do besides tests).
4. Update `agent.test.ts` to assert via the default profile.
5. `bun add ajv`.
6. Behavior-preserving test (default → equals today) must pass before any per-model profile is added. No `apps/api`/`apps/web` change.

## Ralph-loop integration (foreshadow, not built in B)

After B, `apps/deepagent/profiles/<provider>__<model>.jsonc` is the **only writable target** the ralph loop edits. The loop (C): load `default.jsonc` → deep-merge the candidate model file → `loadProfile` validates (schema + references; fail-fast catches bad edits before an agent is built) → `resolveProfile` → `buildAgentFn` (the existing eval seam, run.ts:71, will gain a `profilePath`/`profileData` arg) → run the eval suite (v3 trajectories) → verify-runs + git-rollback. The proposer reads `schema.json` to learn the legal fields/values, edits only the per-model file, and never touches code. A malformed edit is rejected at validation — no half-built agent.

## Out of scope (B)

- The ralph loop itself (sub-project C).
- Sub-project A's harness-profile baseline run (deferred from A).
- Exposing `PromptSpec` block-control to profiles (documented evolution path; not built).
- Any new middleware, tool, subagent, or flag beyond what exists today (`injectTodayDate` is the only flag in v1).
- Per-provider default profiles (`<provider>__default.jsonc`) — resolution is two-level (global default + exact per-model) per the locked decision.
- Real-LLM smoke run (no key; LLM-free tests only, as in sub-project A).