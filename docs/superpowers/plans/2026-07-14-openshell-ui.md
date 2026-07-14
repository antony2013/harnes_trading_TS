# OpenShell UI (Chat + Settings) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the OpenShell persistent-shell backend in the web UI — a specialized shell rendering in chat (command + terminal output + exit badge, backend-assigned per-session workspace) and an OpenShell configuration surface in settings (enable toggle + 4 fields + Docker test), backed by a new overlay settings file.

**Architecture:** A new API-owned `openshell-settings.json` (mirroring `agent-settings.json`) is read by the `/agent/chat` route and passed as an `openshellOverride` into the deepagent `buildAgent`, which applies it on top of the auto-selected profile (sets `OpenShellSpec` + toggles `"openshell"` in the `middleware` array, then re-validates). The chat route also generates a `workspaceId` when the client omits one and emits a `workspace` SSE event. The frontend adds a `ShellStep` component (parses the existing `[exit: N]` / `[warning:…]` / `[error:…]` markers from the flat `tool_result` string — no backend change for chat rendering), an `OpenShellForm` settings section, and per-session `workspaceId` handling in the chat store.

**Tech Stack:** Elysia + TypeBox (API), LangChain/deepagents + AJV (deepagent), SvelteKit 5 + Svelte 5 runes (web), `bun:test` (tests). Bun 1.3.14, workspaces under `apps/*`.

## Global Constraints

- Test runner is `bun:test` (`import { test, expect, beforeEach, mock } from 'bun:test'`). Run tests with `bun test <path>` from the repo root.
- Never hand-edit `package.json` for deps — use `bun add` (project rule). This plan adds **no new dependencies**; everything uses existing packages (`elysia`, `bun:test`, `node:crypto`, `node:child_process`, `node:fs`, `svelte`).
- Elysia TypeBox gotcha (project memory): do **not** use boolean `exclusiveMinimum`; use numeric `minimum` on `t.Integer`. This plan uses `t.Integer({ minimum: N })` and `t.Boolean()` only.
- Elysia returns plain objects from handlers (project memory: SDK class instances serialize to `"[object Object]"`). All handlers here return plain object literals — no class instances.
- Deepagent package export barrel is `apps/deepagent/src/agent.ts` (package.json `exports."."` → `./src/agent.ts`). New deepagent public exports must be re-exported from `agent.ts`.
- Profile `OpenShellSpec` has `additionalProperties: false` and **no `enabled` field** — the override's `enabled` drives middleware membership only, never written into the spec.
- Default profile `middleware` is `['interpreter', 'coerceToolContent', 'readFileContinuation']` (3 entries); adding `openshell` makes it 4.
- Frontend has **no test runner/infra** (`apps/web` has no test deps). Frontend automated tests are limited to one self-contained pure-function parser test run via `bun test <file>`; components are verified with `bun --cwd apps/web run check` (svelte-check) + manual e2e.
- Frequent commits: each task ends with a commit. Branch off `main` before starting (user is on `main`).
- Spec: `docs/superpowers/specs/2026-07-14-openshell-ui-design.md`.

---

## File Structure

**Create:**
- `apps/api/src/modules/agent/openshell.ts` — OpenShell settings persistence module (mirror of `settings.ts`). Owns `openshell-settings.json`.
- `apps/web/src/lib/stores/agentOpenshell.ts` — OpenShell settings store (mirror of `agentSettings.ts`).
- `apps/web/src/lib/components/agent/OpenShellForm.svelte` — settings form: enable toggle + 4 fields + Save/Test.
- `apps/web/src/lib/components/agent/shellParse.ts` — pure marker parser for shell tool output.
- `apps/web/src/lib/components/agent/shellParse.test.ts` — parser unit test (self-contained, `bun:test`).
- `apps/web/src/lib/components/agent/ShellStep.svelte` — specialized shell tool-step renderer.

**Modify:**
- `apps/api/src/modules/agent/index.ts` — add `GET/PUT /agent/openshell` + `POST /agent/openshell/test` routes; wire `/agent/chat` to read openshell settings + pass override + generate `workspaceId` + emit `workspace` SSE event.
- `apps/api/src/modules/agent/index.test.ts` — openshell route tests; update chat tests for uuid generation + `workspace` event + override threading.
- `apps/deepagent/src/profiles/types.ts` — add `OpenShellOverride` interface.
- `apps/deepagent/src/profiles/loader.ts` — add + export `applyOpenShellOverride`.
- `apps/deepagent/src/profiles/index.ts` — re-export `applyOpenShellOverride`.
- `apps/deepagent/src/agent.ts` — re-export `OpenShellOverride` + `applyOpenShellOverride`; extend `buildAgent(cfg, openshellOverride?)`.
- `apps/deepagent/src/profiles/openshell-profile.test.ts` — tests for `applyOpenShellOverride`.
- `apps/deepagent/src/agent.test.ts` — test `buildAgent` with override.
- `apps/web/src/lib/stores/agentChat.ts` — handle `workspace` SSE event; send `workspaceId`; reset on `clear()`.
- `apps/web/src/lib/components/agent/AgentMessage.svelte` — route `shell` tool steps to `ShellStep`.
- `apps/web/src/routes/settings/+page.svelte` — load openshell settings on mount; render `OpenShellForm` in a second card.

---

### Task 1: API `openshell.ts` settings module

**Files:**
- Create: `apps/api/src/modules/agent/openshell.ts`
- Create: `apps/api/src/modules/agent/openshell.test.ts`

**Interfaces:**
- Produces: `OpenShellSettings { enabled: boolean; image: string; idleTimeoutMs: number; bridgePort: number; executionTimeoutMs: number }`, `DEFAULT_OPENSHELL_SETTINGS`, `readOpenShellSettings(): OpenShellSettings | null`, `writeOpenShellSettings(s: OpenShellSettings): void`, `DEFAULT_OPENSHELL_IMAGE`. Consumed by Task 2 (routes) and Task 4 (chat wiring).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/agent/openshell.test.ts`:

```ts
import { test, expect, beforeEach } from 'bun:test'
import { readOpenShellSettings, writeOpenShellSettings, DEFAULT_OPENSHELL_SETTINGS, DEFAULT_OPENSHELL_IMAGE } from './openshell'

beforeEach(() => {
  process.env.AGENT_OPENSHELL_SETTINGS_PATH = `/tmp/openshell-settings-${Math.random().toString(36).slice(2)}.json`
})

test('readOpenShellSettings: returns null when no file', () => {
  expect(readOpenShellSettings()).toBeNull()
})

test('DEFAULT_OPENSHELL_SETTINGS: disabled, sane defaults', () => {
  expect(DEFAULT_OPENSHELL_SETTINGS).toEqual({
    enabled: false,
    image: DEFAULT_OPENSHELL_IMAGE,
    idleTimeoutMs: 1_800_000,
    bridgePort: 7777,
    executionTimeoutMs: 120_000,
  })
  expect(DEFAULT_OPENSHELL_IMAGE).toBe('harnesh/agent-sandbox:ubuntu-lts')
})

test('writeOpenShellSettings + readOpenShellSettings: round-trip', () => {
  writeOpenShellSettings({
    enabled: true,
    image: 'harnesh/agent-sandbox:ubuntu-lts',
    idleTimeoutMs: 900_000,
    bridgePort: 8000,
    executionTimeoutMs: 60_000,
  })
  expect(readOpenShellSettings()).toEqual({
    enabled: true,
    image: 'harnesh/agent-sandbox:ubuntu-lts',
    idleTimeoutMs: 900_000,
    bridgePort: 8000,
    executionTimeoutMs: 60_000,
  })
})

test('readOpenShellSettings: returns null on malformed JSON', () => {
  const path = process.env.AGENT_OPENSHELL_SETTINGS_PATH!
  const { writeFileSync } = require('node:fs')
  writeFileSync(path, '{ not valid json')
  expect(readOpenShellSettings()).toBeNull()
})

test('readOpenShellSettings: returns null when required fields missing', () => {
  const path = process.env.AGENT_OPENSHELL_SETTINGS_PATH!
  const { writeFileSync } = require('node:fs')
  writeFileSync(path, JSON.stringify({ enabled: true, image: 'x' })) // missing timeouts/port
  expect(readOpenShellSettings()).toBeNull()
})

test('writeOpenShellSettings: atomic (no .tmp left behind)', () => {
  writeOpenShellSettings(DEFAULT_OPENSHELL_SETTINGS)
  const path = process.env.AGENT_OPENSHELL_SETTINGS_PATH!
  const { existsSync } = require('node:fs')
  expect(existsSync(path)).toBe(true)
  expect(existsSync(path + '.tmp')).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/api/src/modules/agent/openshell.test.ts`
Expected: FAIL — `Cannot find module './openshell'` (all tests error).

- [ ] **Step 3: Write minimal implementation**

Create `apps/api/src/modules/agent/openshell.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export interface OpenShellSettings {
  enabled: boolean
  image: string
  idleTimeoutMs: number
  bridgePort: number
  executionTimeoutMs: number
}

export const DEFAULT_OPENSHELL_IMAGE = 'harnesh/agent-sandbox:ubuntu-lts'

export const DEFAULT_OPENSHELL_SETTINGS: OpenShellSettings = {
  enabled: false,
  image: DEFAULT_OPENSHELL_IMAGE,
  idleTimeoutMs: 1_800_000, // 30 min
  bridgePort: 7777,
  executionTimeoutMs: 120_000, // 2 min
}

function defaultSettingsPath(): string {
  // apps/api/src/modules/agent/openshell.ts -> ../../../data/openshell-settings.json
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../../data/openshell-settings.json')
}

function settingsPath(): string {
  return process.env.AGENT_OPENSHELL_SETTINGS_PATH || defaultSettingsPath()
}

function isValid(raw: any): raw is OpenShellSettings {
  return !!raw
    && typeof raw.enabled === 'boolean'
    && typeof raw.image === 'string' && raw.image.length > 0
    && typeof raw.idleTimeoutMs === 'number'
    && typeof raw.bridgePort === 'number'
    && typeof raw.executionTimeoutMs === 'number'
}

export function readOpenShellSettings(): OpenShellSettings | null {
  const path = settingsPath()
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!isValid(raw)) return null
    return raw
  } catch {
    return null
  }
}

export function writeOpenShellSettings(s: OpenShellSettings): void {
  const path = settingsPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n')
  renameSync(tmp, path) // atomic
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/api/src/modules/agent/openshell.test.ts`
Expected: PASS — 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/agent/openshell.ts apps/api/src/modules/agent/openshell.test.ts
git commit -m "feat(api): OpenShell settings persistence module (openshell-settings.json)"
```

---

### Task 2: API routes `GET/PUT /agent/openshell` + `POST /agent/openshell/test`

**Files:**
- Modify: `apps/api/src/modules/agent/index.ts` (add imports + 3 chained routes)
- Modify: `apps/api/src/modules/agent/index.test.ts` (add openshell route tests + beforeEach env line)

**Interfaces:**
- Consumes: `readOpenShellSettings`, `writeOpenShellSettings`, `DEFAULT_OPENSHELL_SETTINGS`, `OpenShellSettings` from Task 1.
- Produces: HTTP routes `GET /agent/openshell` → `OpenShellSettings` (defaults when none saved); `PUT /agent/openshell` body `{ enabled, image, idleTimeoutMs, bridgePort, executionTimeoutMs }` → `{ ok: true }` (422 on bad); `POST /agent/openshell/test` → `{ ok: boolean, detail: string }`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/modules/agent/index.test.ts`. First, extend the `beforeEach` env reset (add the openshell settings path line) — replace the existing `beforeEach` block:

```ts
beforeEach(() => {
  process.env.AGENT_SETTINGS_PATH = `/tmp/agent-settings-${Math.random().toString(36).slice(2)}.json`
  process.env.AGENT_OPENSHELL_SETTINGS_PATH = `/tmp/openshell-settings-${Math.random().toString(36).slice(2)}.json`
  recordedConfigurable = undefined
  writeSettings({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '' })
})
```

Then append these tests at the end of `index.test.ts`:

```ts
import { writeOpenShellSettings } from './openshell'

test('GET /agent/openshell: returns defaults when no file', async () => {
  const res = await agent.handle(new Request('http://localhost/agent/openshell'))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toEqual({
    enabled: false,
    image: 'harnesh/agent-sandbox:ubuntu-lts',
    idleTimeoutMs: 1_800_000,
    bridgePort: 7777,
    executionTimeoutMs: 120_000,
  })
})

test('PUT /agent/openshell: writes + GET returns saved values', async () => {
  const putRes = await agent.handle(
    new Request('http://localhost/agent/openshell', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        image: 'harnesh/agent-sandbox:ubuntu-lts',
        idleTimeoutMs: 900_000,
        bridgePort: 8000,
        executionTimeoutMs: 60_000,
      }),
    }),
  )
  expect(putRes.status).toBe(200)
  const getRes = await agent.handle(new Request('http://localhost/agent/openshell'))
  expect(await getRes.json()).toEqual({
    enabled: true,
    image: 'harnesh/agent-sandbox:ubuntu-lts',
    idleTimeoutMs: 900_000,
    bridgePort: 8000,
    executionTimeoutMs: 60_000,
  })
})

test('PUT /agent/openshell: 422 on bad payload (non-bool enabled)', async () => {
  const res = await agent.handle(
    new Request('http://localhost/agent/openshell', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes', image: 'x', idleTimeoutMs: 1, bridgePort: 1, executionTimeoutMs: 1 }),
    }),
  )
  expect(res.status).toBe(422)
})

test('PUT /agent/openshell: 422 on sub-minimum bridgePort', async () => {
  const res = await agent.handle(
    new Request('http://localhost/agent/openshell', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, image: 'x', idleTimeoutMs: 1, bridgePort: -1, executionTimeoutMs: 1 }),
    }),
  )
  expect(res.status).toBe(422)
})

test('POST /agent/openshell/test: returns 200 with {ok, detail} shape', async () => {
  writeOpenShellSettings({
    enabled: true,
    image: 'harnesh/agent-sandbox:ubuntu-lts',
    idleTimeoutMs: 1_800_000,
    bridgePort: 7777,
    executionTimeoutMs: 120_000,
  })
  const res = await agent.handle(new Request('http://localhost/agent/openshell/test', { method: 'POST' }))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(typeof body.ok).toBe('boolean')
  expect(typeof body.detail).toBe('string')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/api/src/modules/agent/index.test.ts`
Expected: FAIL — new `GET /agent/openshell` tests fail (route doesn't exist → 404, not 200). The pre-existing chat tests still pass.

- [ ] **Step 3: Write minimal implementation**

Modify `apps/api/src/modules/agent/index.ts`. Add imports at the top (after the existing `./settings` import block, lines 2-9). Replace:

```ts
import {
  readSettings,
  writeSettings,
  toView,
  OLLAMA_DEFAULT,
  type AgentSettings,
  type Provider,
} from './settings'
```

with:

```ts
import {
  readSettings,
  writeSettings,
  toView,
  OLLAMA_DEFAULT,
  type AgentSettings,
  type Provider,
} from './settings'
import {
  readOpenShellSettings,
  writeOpenShellSettings,
  DEFAULT_OPENSHELL_SETTINGS,
  type OpenShellSettings,
} from './openshell'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
```

Add a docker-test helper near the other helpers (after `testProvider`, before `export const agent`):

```ts
/** Run a command and resolve {ok, stdout, stderr}; never throws. */
function runCmd(cmd: string, args: string[], timeoutMs = 8000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child: any
    try {
      child = spawn(cmd, args, { shell: true, timeout: timeoutMs })
    } catch (err: any) {
      resolve({ ok: false, stdout, stderr: String(err?.message ?? err) })
      return
    }
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', () => resolve({ ok: false, stdout, stderr: stderr || `${cmd} not found` }))
    child.on('close', (code: number | null) => resolve({ ok: code === 0, stdout, stderr }))
  })
}

/** Verify Docker is reachable and the configured image is present locally. */
async function testOpenShell(image: string): Promise<{ ok: boolean; detail: string }> {
  const daemon = await runCmd('docker', ['info'])
  if (!daemon.ok) return { ok: false, detail: 'Docker daemon not reachable (is Docker Desktop running?)' }
  const img = await runCmd('docker', ['images', '-q', image])
  if (!img.ok || !img.stdout.trim()) {
    return { ok: false, detail: `Image "${image}" not found locally. Pull it first: docker pull ${image}` }
  }
  return { ok: true, detail: `Docker reachable; image "${image}" present.` }
}
```

Add three routes to the Elysia chain. Insert them **immediately after the `.post('/agent/test', …)` block (lines 136-148) and before the `.post('/agent/chat', …)` block**. The new chained calls:

```ts
  .get(
    '/agent/openshell',
    () => {
      const s = readOpenShellSettings()
      return s ?? DEFAULT_OPENSHELL_SETTINGS
    },
    { detail: { summary: 'Get OpenShell sandbox settings', tags: ['Agent'] } },
  )
  .put(
    '/agent/openshell',
    ({ body }) => {
      const next: OpenShellSettings = {
        enabled: body.enabled,
        image: body.image,
        idleTimeoutMs: body.idleTimeoutMs,
        bridgePort: body.bridgePort,
        executionTimeoutMs: body.executionTimeoutMs,
      }
      writeOpenShellSettings(next)
      return { ok: true }
    },
    {
      body: t.Object({
        enabled: t.Boolean(),
        image: t.String({ minLength: 1 }),
        idleTimeoutMs: t.Integer({ minimum: 1 }),
        bridgePort: t.Integer({ minimum: 0 }),
        executionTimeoutMs: t.Integer({ minimum: 1 }),
      }),
      detail: { summary: 'Save OpenShell sandbox settings', tags: ['Agent'] },
    },
  )
  .post(
    '/agent/openshell/test',
    async () => {
      const s = readOpenShellSettings()
      if (!s) return { ok: false, detail: 'No OpenShell settings saved yet.' }
      return testOpenShell(s.image)
    },
    { detail: { summary: 'Test Docker + image availability for OpenShell', tags: ['Agent'] } },
  )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/api/src/modules/agent/index.test.ts`
Expected: PASS — all openshell route tests pass AND the pre-existing chat tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/agent/index.ts apps/api/src/modules/agent/index.test.ts
git commit -m "feat(api): GET/PUT /agent/openshell + POST /agent/openshell/test routes"
```

---

### Task 3: Deepagent `OpenShellOverride` + `applyOpenShellOverride` + `buildAgent` wiring

**Files:**
- Modify: `apps/deepagent/src/profiles/types.ts` (add `OpenShellOverride`)
- Modify: `apps/deepagent/src/profiles/loader.ts` (add + export `applyOpenShellOverride`)
- Modify: `apps/deepagent/src/profiles/index.ts` (re-export)
- Modify: `apps/deepagent/src/agent.ts` (re-export + extend `buildAgent`)
- Modify: `apps/deepagent/src/profiles/openshell-profile.test.ts` (override tests)
- Modify: `apps/deepagent/src/agent.test.ts` (buildAgent-with-override test)

**Interfaces:**
- Consumes: `loadProfile`, `mergeProfiles`, `validateMerged` (internal), `ProfileData`, `OpenShellSpec`.
- Produces: `OpenShellOverride` type and `applyOpenShellOverride(profile, override): ProfileData` (exported via `@harnesh-trading-ts/deepagent`); `buildAgent(cfg, openshellOverride?)` accepts an optional override. Consumed by Task 4.

- [ ] **Step 1: Write the failing test**

Add to `apps/deepagent/src/profiles/openshell-profile.test.ts` (append at end). Update the import line at the top from:

```ts
import { resolveProfile, mergeProfiles, ProfileSchemaError } from './loader'
```

to:

```ts
import { resolveProfile, mergeProfiles, applyOpenShellOverride, ProfileSchemaError } from './loader'
```

Append:

```ts
const overrideOn = {
  enabled: true,
  image: 'harnesh/agent-sandbox:ubuntu-lts',
  idleTimeoutMs: 1_800_000,
  bridgePort: 7777,
  executionTimeoutMs: 120_000,
}
const overrideOff = { ...overrideOn, enabled: false }

test('applyOpenShellOverride: enabled adds "openshell" to middleware + sets the spec', () => {
  const base = loadProfile('ollama', 'llama3') // default chain: no openshell
  expect(base.middleware).not.toContain('openshell')
  const merged = applyOpenShellOverride(base, overrideOn)
  expect(merged.middleware).toContain('openshell')
  expect(merged.openshell).toEqual({
    image: 'harnesh/agent-sandbox:ubuntu-lts',
    idleTimeoutMs: 1_800_000,
    bridgePort: 7777,
    executionTimeoutMs: 120_000,
  })
  // merged profile must still resolve (builds the openshell middleware without throwing)
  expect(() => resolveProfile(merged)).not.toThrow()
})

test('applyOpenShellOverride: disabled removes "openshell" from middleware', () => {
  // start from a profile that already has openshell (enabled override on the default)
  const withOs = applyOpenShellOverride(loadProfile('ollama', 'llama3'), overrideOn)
  expect(withOs.middleware).toContain('openshell')
  const merged = applyOpenShellOverride(withOs, overrideOff)
  expect(merged.middleware).not.toContain('openshell')
  expect(() => resolveProfile(merged)).not.toThrow()
})

test('applyOpenShellOverride: enabled=true with a complete spec re-validates and resolves', () => {
  const merged = applyOpenShellOverride(loadProfile('ollama', 'llama3'), overrideOn)
  const r = resolveProfile(merged)
  // default 3 + openshell = 4 parent middleware
  expect(r.parentMiddleware).toHaveLength(4)
})

test('applyOpenShellOverride: disabled on a profile without openshell is a no-op (same middleware)', () => {
  const base = loadProfile('ollama', 'llama3')
  const merged = applyOpenShellOverride(base, overrideOff)
  expect(merged.middleware).toEqual(base.middleware)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/deepagent/src/profiles/openshell-profile.test.ts`
Expected: FAIL — `applyOpenShellOverride` is not exported (import fails).

- [ ] **Step 3: Write minimal implementation**

Add to `apps/deepagent/src/profiles/types.ts` (after the `OpenShellSpec` interface, line 17):

```ts
/** API-supplied override applied on top of the auto-selected profile.
 *  `enabled` toggles "openshell" membership in the middleware array; the four
 *  spec fields populate OpenShellSpec (which has no `enabled` field). */
export interface OpenShellOverride {
  enabled: boolean
  image: string
  idleTimeoutMs: number
  bridgePort: number
  executionTimeoutMs: number
}
```

Add to `apps/deepagent/src/profiles/loader.ts`. Update the type import (line 7) from:

```ts
import type { ProfileData, SubagentSpec } from './types'
```

to:

```ts
import type { ProfileData, SubagentSpec, OpenShellOverride } from './types'
```

Add this function after `loadProfile` (end of `loader.ts`):

```ts
/** Apply an API-supplied OpenShell override on top of a validated profile, then
 *  re-validate. enabled=true sets the 4-field spec + ensures "openshell" in
 *  middleware; enabled=false removes "openshell" from middleware. `enabled` is
 *  never written into OpenShellSpec (additionalProperties:false). */
export function applyOpenShellOverride(profile: ProfileData, override: OpenShellOverride): ProfileData {
  if (override.enabled) {
    const middleware = profile.middleware.includes('openshell')
      ? profile.middleware
      : [...profile.middleware, 'openshell']
    return validateMerged(
      mergeProfiles(profile, {
        middleware,
        openshell: {
          image: override.image,
          idleTimeoutMs: override.idleTimeoutMs,
          bridgePort: override.bridgePort,
          executionTimeoutMs: override.executionTimeoutMs,
        },
      }),
    )
  }
  const middleware = profile.middleware.filter((m) => m !== 'openshell')
  if (middleware.length === profile.middleware.length) return profile
  return validateMerged(mergeProfiles(profile, { middleware }))
}
```

Update `apps/deepagent/src/profiles/index.ts` line 10 from:

```ts
export { loadProfile, mergeProfiles, ProfileSchemaError, ProfileVersionError } from './loader'
```

to:

```ts
export { loadProfile, mergeProfiles, applyOpenShellOverride, ProfileSchemaError, ProfileVersionError } from './loader'
```

Update `apps/deepagent/src/agent.ts`. Change the profiles import (line 11) from:

```ts
import { loadProfile, resolveProfile } from './profiles'
```

to:

```ts
import { loadProfile, resolveProfile, applyOpenShellOverride } from './profiles'
import type { OpenShellOverride } from './profiles/types'
```

Add re-exports near the top of `agent.ts` (right after the existing imports, before `export type Provider`):

```ts
export type { OpenShellOverride } from './profiles/types'
export { applyOpenShellOverride } from './profiles'
```

Change the `buildAgent` signature + body (lines 81-98) from:

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
    // profiles layer stays import-free of deepagents types; cast at this seam
    middleware: profile.parentMiddleware as any,
    subagents: profile.subagents as any,
  })
}
```

to:

```ts
export async function buildAgent(cfg: AgentConfig, openshellOverride?: OpenShellOverride) {
  if (!cfg.model) throw new Error('Agent config missing model')
  const model = buildModel(cfg)
  const root = workspaceDir()
  mkdirSync(root, { recursive: true })
  let data = loadProfile(cfg.provider, cfg.model)
  if (openshellOverride) data = applyOpenShellOverride(data, openshellOverride)
  const profile = resolveProfile(data)
  const systemPrompt = assembleSystemPrompt(profile, todayIST())
  return createDeepAgent({
    model,
    tools: allTools,
    systemPrompt,
    backend: buildBackend(root),
    permissions: WORKSPACE_PERMISSIONS,
    // profiles layer stays import-free of deepagents types; cast at this seam
    middleware: profile.parentMiddleware as any,
    subagents: profile.subagents as any,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/deepagent/src/profiles/openshell-profile.test.ts`
Expected: PASS — the 4 new override tests pass; pre-existing tests still pass.

- [ ] **Step 5: Add the buildAgent-with-override test**

Add to `apps/deepagent/src/agent.test.ts` (append at end):

```ts
test('buildAgent: openshellOverride enabled builds an agent with openshell middleware (no throw)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'da-')) + '/os-on'
  process.env.AGENT_WORKSPACE_DIR = root
  const agent = await buildAgent(
    { provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama3' },
    { enabled: true, image: 'harnesh/agent-sandbox:ubuntu-lts', idleTimeoutMs: 1_800_000, bridgePort: 7777, executionTimeoutMs: 120_000 },
  )
  expect(agent).toBeTruthy()
  expect(existsSync(root)).toBe(true)
})

test('buildAgent: openshellOverride disabled (or absent) leaves the default interpreter profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'da-')) + '/os-off'
  process.env.AGENT_WORKSPACE_DIR = root
  const agent = await buildAgent(
    { provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama3' },
    { enabled: false, image: 'harnesh/agent-sandbox:ubuntu-lts', idleTimeoutMs: 1_800_000, bridgePort: 7777, executionTimeoutMs: 120_000 },
  )
  expect(agent).toBeTruthy()
})
```

Run: `bun test apps/deepagent/src/agent.test.ts`
Expected: PASS — both new tests pass; pre-existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/deepagent/src/profiles/types.ts apps/deepagent/src/profiles/loader.ts apps/deepagent/src/profiles/index.ts apps/deepagent/src/agent.ts apps/deepagent/src/profiles/openshell-profile.test.ts apps/deepagent/src/agent.test.ts
git commit -m "feat(deepagent): applyOpenShellOverride + buildAgent openshellOverride param"
```

---

### Task 4: API `/agent/chat` wiring — override pass-through + backend-generated workspaceId + `workspace` SSE event

**Files:**
- Modify: `apps/api/src/modules/agent/index.ts` (chat route)
- Modify: `apps/api/src/modules/agent/index.test.ts` (update chat tests + add override-threading test)

**Interfaces:**
- Consumes: `readOpenShellSettings` (Task 1), `buildAgent(cfg, openshellOverride?)` (Task 3), `randomUUID` (imported in Task 2).
- Produces: `/agent/chat` now (a) reads openshell settings and passes an `OpenShellOverride` to `buildAgent`; (b) generates a `workspaceId` via `randomUUID()` when `body.workspaceId` is absent; (c) emits a `workspace` SSE event `{ id }` at stream start. SSE protocol gains `workspace` alongside `token`/`tool_call`/`tool_result`/`done`/`error`.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/modules/agent/index.test.ts`, the mock `buildAgent` must record the override. Update the `mock.module` block — replace:

```ts
mock.module('@harnesh-trading-ts/deepagent', () => ({
  ...realDeepagent,
  buildAgent: async () => ({
    // Fake agent: record configurable, emit no events, let the route yield `done`.
    streamEvents: async function* (_input: any, opts: any) {
      recordedConfigurable = opts?.configurable
    },
  }),
  buildModel: () => ({}),
}))
```

with:

```ts
let recordedOverride: any
mock.module('@harnesh-trading-ts/deepagent', () => ({
  ...realDeepagent,
  buildAgent: async (_cfg: any, override: any) => {
    recordedOverride = override
    return {
      // Fake agent: record configurable, emit no events, let the route yield `done`.
      streamEvents: async function* (_input: any, opts: any) {
        recordedConfigurable = opts?.configurable
      },
    }
  },
  buildModel: () => ({}),
}))
```

Add `recordedOverride = undefined` to `beforeEach` (after `recordedConfigurable = undefined`):

```ts
beforeEach(() => {
  process.env.AGENT_SETTINGS_PATH = `/tmp/agent-settings-${Math.random().toString(36).slice(2)}.json`
  process.env.AGENT_OPENSHELL_SETTINGS_PATH = `/tmp/openshell-settings-${Math.random().toString(36).slice(2)}.json`
  recordedConfigurable = undefined
  recordedOverride = undefined
  writeSettings({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '' })
})
```

Replace the existing test `'POST /agent/chat defaults workspace_id to __default__ when body omits workspaceId'` (lines 51-62) with:

```ts
test('POST /agent/chat generates a uuid workspace_id + emits a workspace SSE event when body omits workspaceId', async () => {
  const res = await agent.handle(
    new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
  )
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toContain('event: workspace')
  expect(recordedConfigurable).toBeDefined()
  expect(recordedConfigurable.workspace_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  // the emitted workspace event carries the same id used in configurable
  expect(text).toContain(`"id":"${recordedConfigurable.workspace_id}"`)
})
```

Update the existing `'POST /agent/chat passes body.workspaceId as configurable.workspace_id to streamEvents'` test (lines 34-49) — add an assertion that the `workspace` event is also emitted with the provided id:

```ts
test('POST /agent/chat passes body.workspaceId as configurable.workspace_id + emits workspace event', async () => {
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
  const text = await res.text()
  expect(recordedConfigurable).toEqual({ workspace_id: 'wA' })
  expect(text).toContain('event: workspace')
  expect(text).toContain('"id":"wA"')
})
```

Append the override-threading test at the end of the file:

```ts
test('POST /agent/chat threads openshell override into buildAgent when settings are saved', async () => {
  writeOpenShellSettings({
    enabled: true,
    image: 'harnesh/agent-sandbox:ubuntu-lts',
    idleTimeoutMs: 900_000,
    bridgePort: 8000,
    executionTimeoutMs: 60_000,
  })
  const res = await agent.handle(
    new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
  )
  await res.text()
  expect(recordedOverride).toEqual({
    enabled: true,
    image: 'harnesh/agent-sandbox:ubuntu-lts',
    idleTimeoutMs: 900_000,
    bridgePort: 8000,
    executionTimeoutMs: 60_000,
  })
})

test('POST /agent/chat passes undefined override when no openshell settings saved', async () => {
  const res = await agent.handle(
    new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
  )
  await res.text()
  expect(recordedOverride).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/api/src/modules/agent/index.test.ts`
Expected: FAIL — the uuid-generation test fails (`workspace_id` is currently `'__default__'`, not a uuid; no `workspace` event emitted), and the override-threading test fails (`recordedOverride` is `undefined` even with settings saved).

- [ ] **Step 3: Write minimal implementation**

In `apps/api/src/modules/agent/index.ts`, modify the `/agent/chat` handler. Replace the block (lines 154-170):

```ts
      const s = readSettings()
      if (!s || !s.model) {
        set.status = 400
        yield sse({ event: 'error', data: { message: 'Agent not configured. Open /settings first.' } })
        return
      }

      const workspaceId = (body.workspaceId as string) || '__default__'
      mkdirSync(workspaceDir(workspaceId), { recursive: true })

      let agent
      try {
        agent = await buildAgent(s)
      } catch (err: any) {
        yield sse({ event: 'error', data: { message: err?.message ?? 'Failed to build agent' } })
        return
      }
```

with:

```ts
      const s = readSettings()
      if (!s || !s.model) {
        set.status = 400
        yield sse({ event: 'error', data: { message: 'Agent not configured. Open /settings first.' } })
        return
      }

      // Backend owns the workspaceId lifecycle: generate one when the client omits it
      // (first turn), reuse the client-supplied one on subsequent turns.
      const workspaceId = (body.workspaceId as string) || randomUUID()
      mkdirSync(workspaceDir(workspaceId), { recursive: true })
      yield sse({ event: 'workspace', data: { id: workspaceId } })

      // Read the OpenShell overlay and pass it to the deepagent profile-merge.
      const osSettings = readOpenShellSettings()
      const openshellOverride = osSettings
        ? {
            enabled: osSettings.enabled,
            image: osSettings.image,
            idleTimeoutMs: osSettings.idleTimeoutMs,
            bridgePort: osSettings.bridgePort,
            executionTimeoutMs: osSettings.executionTimeoutMs,
          }
        : undefined

      let agent
      try {
        agent = await buildAgent(s, openshellOverride)
      } catch (err: any) {
        yield sse({ event: 'error', data: { message: err?.message ?? 'Failed to build agent' } })
        return
      }
```

Also update the route `detail.summary` (line 218) from:

```ts
        summary: 'Agent chat (SSE stream: token/tool_call/tool_result/done/error)',
```

to:

```ts
        summary: 'Agent chat (SSE stream: workspace/token/tool_call/tool_result/done/error)',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/api/src/modules/agent/index.test.ts`
Expected: PASS — uuid-generation + workspace event + override-threading tests pass; the path-traversal 422 test and the `wA` test still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/agent/index.ts apps/api/src/modules/agent/index.test.ts
git commit -m "feat(api): chat route threads openshell override + backend-generated workspaceId + workspace SSE event"
```

---

### Task 5: Frontend OpenShell settings store + form + settings page

**Files:**
- Create: `apps/web/src/lib/stores/agentOpenshell.ts`
- Create: `apps/web/src/lib/components/agent/OpenShellForm.svelte`
- Modify: `apps/web/src/routes/settings/+page.svelte`

**Interfaces:**
- Consumes: HTTP routes from Task 2 (`GET/PUT /agent/openshell`, `POST /agent/openshell/test`).
- Produces: `OpenShellForm.svelte` (rendered in settings page); store functions `loadOpenShell`, `saveOpenShell`, `testOpenShell` + stores `openshellSettings`, `openshellSaving`, `openshellTesting`, `openshellTestResult`, `openshellError`.

- [ ] **Step 1: Create the store**

Create `apps/web/src/lib/stores/agentOpenshell.ts`:

```ts
import { writable } from 'svelte/store';

export interface OpenShellSettings {
	enabled: boolean;
	image: string;
	idleTimeoutMs: number;
	bridgePort: number;
	executionTimeoutMs: number;
}

export const DEFAULT_OPENSHELL: OpenShellSettings = {
	enabled: false,
	image: 'harnesh/agent-sandbox:ubuntu-lts',
	idleTimeoutMs: 1_800_000,
	bridgePort: 7777,
	executionTimeoutMs: 120_000
};

export const openshellSettings = writable<OpenShellSettings | null>(null);
export const openshellSaving = writable(false);
export const openshellTesting = writable(false);
export const openshellTestResult = writable<{ ok: boolean; detail: string } | null>(null);
export const openshellError = writable<string | null>(null);

export async function loadOpenShell(): Promise<void> {
	const res = await fetch('/agent/openshell');
	openshellSettings.set(await res.json());
}

export async function saveOpenShell(payload: OpenShellSettings): Promise<boolean> {
	openshellSaving.set(true);
	openshellError.set(null);
	openshellTestResult.set(null);
	try {
		const res = await fetch('/agent/openshell', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		});
		if (!res.ok) {
			openshellError.set(`Save failed (${res.status})`);
			return false;
		}
		await loadOpenShell();
		return true;
	} finally {
		openshellSaving.set(false);
	}
}

export async function testOpenShell(): Promise<void> {
	openshellTesting.set(true);
	openshellTestResult.set(null);
	openshellError.set(null);
	try {
		const res = await fetch('/agent/openshell/test', { method: 'POST' });
		openshellTestResult.set(await res.json());
	} finally {
		openshellTesting.set(false);
	}
}
```

- [ ] **Step 2: Create the form component**

Create `apps/web/src/lib/components/agent/OpenShellForm.svelte`:

```svelte
<script lang="ts">
	import {
		openshellSettings,
		openshellSaving,
		openshellTesting,
		openshellTestResult,
		openshellError,
		loadOpenShell,
		saveOpenShell,
		testOpenShell,
		DEFAULT_OPENSHELL,
		type OpenShellSettings
	} from '$lib/stores/agentOpenshell';

	let enabled = $state(false);
	let image = $state(DEFAULT_OPENSHELL.image);
	let idleTimeoutMs = $state(DEFAULT_OPENSHELL.idleTimeoutMs);
	let bridgePort = $state(DEFAULT_OPENSHELL.bridgePort);
	let executionTimeoutMs = $state(DEFAULT_OPENSHELL.executionTimeoutMs);

	let seeded = false;
	$effect(() => {
		const s = $openshellSettings;
		if (s && !seeded) {
			seeded = true;
			enabled = s.enabled;
			image = s.image;
			idleTimeoutMs = s.idleTimeoutMs;
			bridgePort = s.bridgePort;
			executionTimeoutMs = s.executionTimeoutMs;
		}
	});

	const idleMin = $derived(Math.round(idleTimeoutMs / 60000));
	const execSec = $derived(Math.round(executionTimeoutMs / 1000));

	function payload(): OpenShellSettings {
		return { enabled, image, idleTimeoutMs, bridgePort, executionTimeoutMs };
	}

	async function onSave() {
		await saveOpenShell(payload());
	}
</script>

<div class="form">
	<label class="row toggle">
		<span class="lbl">Enable OpenShell sandbox</span>
		<input type="checkbox" bind:checked={enabled} />
	</label>
	<p class="hint">
		When enabled, the agent gets a <code>shell</code> tool that runs commands in a persistent Linux Docker sandbox (one per chat workspace).
		Requires Docker Desktop running. See <a href="https://github.com/harnesh-trading-ts" target="_blank" rel="noreferrer">openshell setup</a>.
	</p>

	<label class="row">
		<span class="lbl">Image</span>
		<input class="field" type="text" bind:value={image} disabled={!enabled} />
	</label>

	<label class="row">
		<span class="lbl">Idle timeout ({idleMin} min)</span>
		<input class="field" type="number" min="1" bind:value={idleTimeoutMs} disabled={!enabled} />
	</label>

	<label class="row">
		<span class="lbl">Bridge port</span>
		<input class="field" type="number" min="0" bind:value={bridgePort} disabled={!enabled} />
	</label>

	<label class="row">
		<span class="lbl">Execution timeout ({execSec} s)</span>
		<input class="field" type="number" min="1" bind:value={executionTimeoutMs} disabled={!enabled} />
	</label>

	<div class="actions">
		<button class="btn" disabled={$openshellTesting || !enabled} onclick={testOpenShell}>
			{$openshellTesting ? 'Testing…' : 'Test Docker'}
		</button>
		<button class="btn primary" disabled={$openshellSaving} onclick={onSave}>
			{$openshellSaving ? 'Saving…' : 'Save'}
		</button>
	</div>

	{#if $openshellTestResult}
		<div class="result" data-ok={$openshellTestResult.ok}>
			{$openshellTestResult.ok ? '✓' : '✗'} {$openshellTestResult.detail}
		</div>
	{/if}

	{#if $openshellError}
		<div class="result" data-ok="false">✗ {$openshellError}</div>
	{/if}
</div>

<style>
	.form { display: flex; flex-direction: column; gap: 1rem; }
	.row { display: flex; flex-direction: column; gap: 0.35rem; }
	.row.toggle { flex-direction: row; align-items: center; gap: 0.6rem; }
	.lbl {
		font-family: var(--font-mono);
		font-size: var(--t-2xs);
		text-transform: uppercase;
		letter-spacing: 0.6px;
		color: var(--paper-dim);
	}
	.hint {
		font-size: var(--t-sm);
		color: var(--paper-dim);
		margin: -0.4rem 0 0;
		line-height: 1.5;
	}
	.hint code {
		font-family: var(--font-mono);
		background: var(--ink-900);
		border: 1px solid var(--ink-line);
		border-radius: 3px;
		padding: 0.1rem 0.3rem;
	}
	.field {
		width: 100%;
		padding: 0.5rem 0.65rem;
		background: var(--ink-950);
		border: 1px solid var(--ink-line);
		border-radius: var(--radius-sm);
		color: var(--paper);
		font-family: var(--font-mono);
		font-size: var(--t-sm);
	}
	.field:disabled { opacity: 0.45; }
	.field:focus {
		outline: none;
		border-color: var(--saffron-line);
		box-shadow: 0 0 0 3px var(--saffron-soft);
	}
	.actions { display: flex; gap: 0.6rem; }
	.btn {
		padding: 0.5rem 0.9rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--ink-line);
		background: var(--ink-800);
		color: var(--paper);
		font-family: var(--font-mono);
		font-size: var(--t-xs);
		letter-spacing: 0.3px;
		cursor: pointer;
	}
	.btn:hover:not(:disabled) { border-color: var(--saffron-line); }
	.btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.btn.primary {
		background: var(--saffron);
		border-color: var(--saffron);
		color: #1a1208;
		font-weight: 600;
		text-transform: uppercase;
	}
	.btn.primary:hover:not(:disabled) { background: #f29638; border-color: #f29638; }
	.result {
		font-family: var(--font-mono);
		font-size: var(--t-xs);
		padding: 0.5rem 0.7rem;
		border-radius: var(--radius-sm);
		border: 1px solid;
	}
	.result[data-ok='true'] {
		background: rgba(91, 201, 122, 0.12);
		color: var(--up);
		border-color: rgba(91, 201, 122, 0.4);
	}
	.result[data-ok='false'] {
		background: rgba(248, 84, 106, 0.12);
		color: var(--down);
		border-color: rgba(248, 84, 106, 0.4);
	}
</style>
```

- [ ] **Step 3: Wire the form into the settings page**

Replace `apps/web/src/routes/settings/+page.svelte` with:

```svelte
<script lang="ts">
	import { onMount } from 'svelte';
	import { loadSettings, fetchOllamaModels, agentSettings } from '$lib/stores/agentSettings';
	import { loadOpenShell, openshellSettings } from '$lib/stores/agentOpenshell';
	import ProviderForm from '$lib/components/agent/ProviderForm.svelte';
	import OpenShellForm from '$lib/components/agent/OpenShellForm.svelte';

	onMount(async () => {
		await loadSettings();
		if ($agentSettings?.provider === 'ollama') {
			fetchOllamaModels($agentSettings.baseUrl || 'http://localhost:11434');
		}
		await loadOpenShell();
	});
</script>

<svelte:head><title>Agent settings — Harnesh Trading</title></svelte:head>

<div class="page">
	<h1>Agent model settings</h1>
	<p class="muted">Pick an LLM provider, configure it, test, then save. The agent uses this for the next chat.</p>
	<section class="card"><ProviderForm /></section>

	<h2>OpenShell sandbox</h2>
	<p class="muted">Optional: give the agent a persistent shell tool in a Docker sandbox (one per chat workspace).</p>
	<section class="card"><OpenShellForm /></section>
</div>

<style>
	.page { max-width: 580px; margin: 0 auto; padding: 2.5rem 1rem; }
	h1 {
		font-family: var(--font-display);
		font-style: italic;
		font-weight: 400;
		font-size: var(--t-2xl);
		line-height: 1.1;
		margin: 0 0 0.4rem;
		color: var(--paper);
	}
	h2 {
		font-family: var(--font-display);
		font-style: italic;
		font-weight: 400;
		font-size: var(--t-xl);
		margin: 2rem 0 0.4rem;
		color: var(--paper);
	}
	.muted { color: var(--paper-dim); margin: 0 0 1.75rem; font-size: var(--t-sm); }
	.card {
		background: var(--ink-900);
		border: 1px solid var(--ink-line);
		border-radius: var(--radius);
		padding: 1.25rem;
	}
</style>
```

- [ ] **Step 4: Typecheck the web app**

Run: `bun --cwd apps/web run check`
Expected: PASS — svelte-check reports no errors in the new/modified files (the `$openshellSettings` unused-read warning is not an error; `$openshellSettings` is read in the `$effect`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/stores/agentOpenshell.ts apps/web/src/lib/components/agent/OpenShellForm.svelte apps/web/src/routes/settings/+page.svelte
git commit -m "feat(web): OpenShell settings store + form + settings page section"
```

---

### Task 6: Frontend shell rendering (parser + ShellStep + AgentMessage routing + chat workspace handling)

**Files:**
- Create: `apps/web/src/lib/components/agent/shellParse.ts`
- Create: `apps/web/src/lib/components/agent/shellParse.test.ts`
- Create: `apps/web/src/lib/components/agent/ShellStep.svelte`
- Modify: `apps/web/src/lib/components/agent/AgentMessage.svelte`
- Modify: `apps/web/src/lib/stores/agentChat.ts`

**Interfaces:**
- Consumes: the existing `tool_call`/`tool_result` SSE events (already handled by `agentChat.ts`) + the new `workspace` event (Task 4). The flat `tool_result` output string format: `${output}\n\n[exit: ${exitCode}] [persistent shell: …]` with optional ` [warning: …]`, or `[error: ${msg}]` on failure.
- Produces: `parseShellResult(s): { output: string; exit: number | null; warning?: string; error?: string }` (pure); `ShellStep.svelte` rendering; per-session `workspaceId` handling in `agentChat.ts`.

- [ ] **Step 1: Write the failing parser test**

Create `apps/web/src/lib/components/agent/shellParse.test.ts` (self-contained — no `$lib` imports):

```ts
import { test, expect } from 'bun:test'
import { parseShellResult } from './shellParse'

test('parseShellResult: exit 0 + persistent-shell marker stripped', () => {
  const s = 'total 0\ndrwxr-xr-x 2 root root 40 May 1 10:00 .\n\n[exit: 0] [persistent shell: cwd, env, installed packages, and /workspace files persist across your shell calls within this workspace]'
  const r = parseShellResult(s)
  expect(r.exit).toBe(0)
  expect(r.warning).toBeUndefined()
  expect(r.error).toBeUndefined()
  expect(r.output).toBe('total 0\ndrwxr-xr-x 2 root root 40 May 1 10:00 .')
})

test('parseShellResult: non-zero exit', () => {
  const r = parseShellResult('ls: cannot access foo: No such file\n\n[exit: 2] [persistent shell: blah]')
  expect(r.exit).toBe(2)
  expect(r.output).toBe('ls: cannot access foo: No such file')
})

test('parseShellResult: warning present', () => {
  const r = parseShellResult('partial\n\n[exit: 0] [persistent shell: x] [warning: exit marker not found, output may be incomplete]')
  expect(r.exit).toBe(0)
  expect(r.warning).toBe('exit marker not found, output may be incomplete')
  expect(r.output).toBe('partial')
})

test('parseShellResult: error-only string', () => {
  const r = parseShellResult('[error: docker daemon not running]')
  expect(r.exit).toBeNull()
  expect(r.error).toBe('docker daemon not running')
  expect(r.output).toBe('')
})

test('parseShellResult: missing exit marker (no markers at all)', () => {
  const r = parseShellResult('just some plain output with no markers')
  expect(r.exit).toBeNull()
  expect(r.output).toBe('just some plain output with no markers')
})

test('parseShellResult: empty string', () => {
  const r = parseShellResult('')
  expect(r.exit).toBeNull()
  expect(r.output).toBe('')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/lib/components/agent/shellParse.test.ts`
Expected: FAIL — `Cannot find module './shellParse'`.

- [ ] **Step 3: Write the parser**

Create `apps/web/src/lib/components/agent/shellParse.ts`:

```ts
export interface ParsedShellResult {
  output: string;
  exit: number | null;
  warning?: string;
  error?: string;
}

/** Parse a shell tool_result string into structured fields.
 *  Format (success): `${output}\n\n[exit: N] [persistent shell: …][optional [warning: …]]`
 *  Format (error):   `[error: ${msg}]` */
export function parseShellResult(s: string): ParsedShellResult {
  if (!s) return { output: '', exit: null }
  const errorMatch = s.match(/\[error:\s+(.+?)\]\s*$/)
  if (errorMatch) return { output: '', exit: null, error: errorMatch[1] }
  const exitMatch = s.match(/\[exit:\s*(-?\d+)\]/)
  const exit = exitMatch ? parseInt(exitMatch[1], 10) : null
  const warningMatch = s.match(/\[warning:\s+(.+?)\]/)
  const warning = warningMatch?.[1]
  let output = s
    .replace(/\[exit:\s*-?\d+\]\s*/g, '')
    .replace(/\[persistent shell:[^\]]*\]\s*/g, '')
    .replace(/\[warning:[^\]]*\]\s*/g, '')
    .replace(/\[error:[^\]]*\]\s*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
  return { output, exit, warning }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/lib/components/agent/shellParse.test.ts`
Expected: PASS — 6 parser tests pass.

- [ ] **Step 5: Create ShellStep.svelte**

Create `apps/web/src/lib/components/agent/ShellStep.svelte`:

```svelte
<script lang="ts">
	import type { ToolStep } from '$lib/stores/agentChat';
	import { parseShellResult } from './shellParse';

	let { step }: { step: ToolStep } = $props();
	const isCall = $derived(step.type === 'tool_call');
	const command = $derived(
		isCall ? (typeof step.data === 'object' && step.data && 'command' in (step.data as any) ? String((step.data as any).command) : '') : ''
	);
	const parsed = $derived(!isCall && typeof step.data === 'string' ? parseShellResult(step.data) : null);
	let open = $state(false);

	const exitOk = $derived(parsed?.exit === 0);
	const copied = $state(false);
	async function copyCmd() {
		try {
			await navigator.clipboard.writeText(command);
		} catch {}
	}
</script>

<div class="ticket" data-call={isCall} data-open={open}>
	<button class="head" onclick={() => (open = !open)} aria-expanded={open}>
		<span class="mark">{isCall ? '►' : '▾'}</span>
		<span class="name">shell</span>
		{#if isCall}
			<span class="chip run">running</span>
		{:else if parsed?.error}
			<span class="chip err">error</span>
		{:else if parsed && parsed.exit !== null}
			<span class="chip" data-ok={exitOk}>exit {parsed.exit}</span>
		{:else}
			<span class="chip done">done</span>
		{/if}
	</button>
	{#if open}
		<div class="inset">
			{#if isCall}
				<div class="cmdline">
					<span class="prompt">$</span>
					<code class="cmd">{command}</code>
					<button class="copy" onclick={copyCmd}>copy</button>
				</div>
			{:else if parsed}
				{#if parsed.error}
					<pre class="out err">{parsed.error}</pre>
				{:else}
					{#if parsed.warning}
						<div class="warn">⚠ {parsed.warning}</div>
					{/if}
					<pre class="out">{parsed.output}</pre>
				{/if}
			{/if}
		</div>
	{/if}
</div>

<style>
	.ticket {
		font-size: var(--t-xs);
		border: 1px solid var(--ink-line);
		border-radius: var(--radius-sm);
		background: var(--ink-900);
		overflow: hidden;
		max-width: 640px;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		background: none;
		border: none;
		cursor: pointer;
		padding: 0.35rem 0.55rem;
		color: var(--paper-dim);
		font-family: var(--font-mono);
		text-align: left;
	}
	.head:hover { background: var(--ink-800); }
	.mark { width: 0.9ch; color: var(--saffron); font-size: var(--t-2xs); }
	.name { color: var(--paper); font-weight: 600; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.chip {
		flex: 0 0 auto;
		font-size: var(--t-2xs);
		letter-spacing: 0.6px;
		text-transform: uppercase;
		padding: 0.1rem 0.4rem;
		border-radius: 3px;
		border: 1px solid currentColor;
	}
	.chip.run { color: var(--saffron); background: var(--saffron-soft); border-color: var(--saffron-line); }
	.chip.done { color: var(--up); border-color: rgba(91, 201, 122, 0.4); }
	.chip.err { color: var(--down); border-color: rgba(248, 84, 106, 0.5); }
	.chip[data-ok='true'] { color: var(--up); border-color: rgba(91, 201, 122, 0.4); }
	.chip[data-ok='false'] { color: var(--down); border-color: rgba(248, 84, 106, 0.5); }
	.inset {
		border-top: 1px solid var(--ink-line);
		background: #110d08;
		color: var(--paper);
		padding: 0.5rem 0.6rem;
	}
	.cmdline {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-family: var(--font-mono);
	}
	.prompt { color: var(--saffron); }
	.cmd { color: var(--paper); white-space: pre-wrap; word-break: break-word; flex: 1 1 auto; }
	.copy {
		flex: 0 0 auto;
		background: none;
		border: 1px solid var(--ink-line);
		border-radius: 3px;
		color: var(--paper-dim);
		font-family: var(--font-mono);
		font-size: var(--t-2xs);
		padding: 0.1rem 0.35rem;
		cursor: pointer;
	}
	.out {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--t-xs);
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 280px;
		overflow: auto;
		color: var(--paper);
	}
	.out.err { color: var(--down); }
	.warn {
		font-family: var(--font-mono);
		font-size: var(--t-2xs);
		color: var(--saffron);
		margin-bottom: 0.3rem;
	}
</style>
```

- [ ] **Step 6: Route shell steps to ShellStep in AgentMessage**

Modify `apps/web/src/lib/components/agent/AgentMessage.svelte`. Update the script imports (line 3) — replace:

```svelte
	import ToolStep from './ToolStep.svelte';
```

with:

```svelte
	import ToolStep from './ToolStep.svelte';
	import ShellStep from './ShellStep.svelte';
```

Replace the tools render block (lines 22-24):

```svelte
			{#if msg.tools && msg.tools.length}
				<div class="tools">{#each msg.tools as t, i (i)}<ToolStep step={t} />{/each}</div>
			{/if}
```

with:

```svelte
			{#if msg.tools && msg.tools.length}
				<div class="tools">{#each msg.tools as t, i (i)}{#if t.name === 'shell'}<ShellStep step={t} />{:else}<ToolStep step={t} />{/if}{/each}</div>
			{/if}
```

- [ ] **Step 7: Add workspace handling to agentChat.ts**

Modify `apps/web/src/lib/stores/agentChat.ts`. Add a module-level workspace id holder after `let currentAssistantId` (line 22):

```ts
let currentWorkspaceId: string | null = null;
```

In `handleBlock`, add a `workspace` branch. Replace the event-handling block (lines 49-56):

```ts
	if (event === 'token' && typeof payload.text === 'string') appendText(payload.text);
	else if (event === 'tool_call') pushTool({ type: 'tool_call', name: payload.name, data: payload.input });
	else if (event === 'tool_result') pushTool({ type: 'tool_result', name: payload.name, data: payload.output });
	else if (event === 'error') {
		appendText(`\n\n⚠️ ${payload.message ?? 'error'}`);
		chatError.set(payload.message ?? 'error');
	}
	// 'done' is a no-op; stream end is handled by the reader loop.
```

with:

```ts
	if (event === 'token' && typeof payload.text === 'string') appendText(payload.text);
	else if (event === 'tool_call') pushTool({ type: 'tool_call', name: payload.name, data: payload.input });
	else if (event === 'tool_result') pushTool({ type: 'tool_result', name: payload.name, data: payload.output });
	else if (event === 'workspace' && typeof payload.id === 'string') currentWorkspaceId = payload.id;
	else if (event === 'error') {
		appendText(`\n\n⚠️ ${payload.message ?? 'error'}`);
		chatError.set(payload.message ?? 'error');
	}
	// 'done' is a no-op; stream end is handled by the reader loop.
```

In `sendMessage`, send the stored workspace id. Replace the fetch body (lines 82-87):

```ts
		const res = await fetch('/agent/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ messages: bodyMessages }),
			signal: controller.signal
		});
```

with:

```ts
		const reqBody: { messages: typeof bodyMessages; workspaceId?: string } = { messages: bodyMessages };
		if (currentWorkspaceId) reqBody.workspaceId = currentWorkspaceId;
		const res = await fetch('/agent/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(reqBody),
			signal: controller.signal
		});
```

In `clear()`, reset the workspace id. Replace (lines 139-143):

```ts
export function clear(): void {
	if (get(streaming)) return;
	messages.set([]);
	chatError.set(null);
}
```

with:

```ts
export function clear(): void {
	if (get(streaming)) return;
	messages.set([]);
	chatError.set(null);
	currentWorkspaceId = null;
}
```

- [ ] **Step 8: Typecheck the web app**

Run: `bun --cwd apps/web run check`
Expected: PASS — svelte-check reports no errors. (If svelte-check is unavailable in the environment, fall back to `bun --cwd apps/web run build` and confirm it succeeds.)

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/components/agent/shellParse.ts apps/web/src/lib/components/agent/shellParse.test.ts apps/web/src/lib/components/agent/ShellStep.svelte apps/web/src/lib/components/agent/AgentMessage.svelte apps/web/src/lib/stores/agentChat.ts
git commit -m "feat(web): ShellStep rendering + shell output parser + per-session workspaceId"
```

---

### Task 7: End-to-end verify (manual, with Docker Desktop)

**Files:** none (verification only).

**Prerequisites:** Docker Desktop running; `harnesh/agent-sandbox:ubuntu-lts` image pulled (`docker pull harnesh/agent-sandbox:ubuntu-lts`); an LLM provider configured in `/settings` (e.g. Ollama with a model that supports tool-calling).

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: PASS — all API + deepagent + web parser tests pass (the openshell integration test `apps/deepagent/src/openshell/integration.test.ts` is gated and skipped without real OpenShell; that is pre-existing and expected).

- [ ] **Step 2: Boot API + web**

In one terminal: `bun --cwd apps/api run dev`
In another: `bun --cwd apps/web run dev`
Expected: API listens on its port; web dev server starts and waits for the API.

- [ ] **Step 3: Configure OpenShell in the UI**

Open `/settings` in the browser. Scroll to "OpenShell sandbox". Toggle **Enable**. Click **Test Docker** → expect `✓ Docker reachable; image "harnesh/agent-sandbox:ubuntu-lts" present.` Click **Save**.
Expected: settings persist (reload page → toggle stays on, fields retain values).

- [ ] **Step 4: Verify shell rendering + per-session workspace in chat**

Open `/chat`. Send: `Run ls -la in the shell tool and tell me what you see.`
Expected:
- A `shell` tool-step appears with a `running` chip; expanding shows `$ ls -la` + a copy button.
- On completion, a second `shell` tool-step shows an `exit 0` (green) chip; expanding shows the terminal output.
- Send a follow-up: `Now run pwd.` — the agent reuses the same workspace (cwd persists from the previous `ls`). Verify in the API logs that the second `/agent/chat` request carries the same `workspaceId` as the first turn's `workspace` event (per-session isolation).

- [ ] **Step 5: Verify disabled fallback**

In `/settings`, toggle OpenShell **off**, Save. In `/chat` (new session — clear first), ask the agent to run a shell command.
Expected: the agent has no `shell` tool (it should reply that it can't run shell commands, or use other tools); no `ShellStep` renders; no crash.

- [ ] **Step 6: Final commit (if any verification fixups were needed)**

If verification surfaced a fix, commit it. Otherwise no commit.

```bash
git status
# if clean, nothing to commit
```

---

## Self-Review (run before handoff)

**1. Spec coverage:**
- Specialized shell rendering in chat (command + terminal output + exit badge + warning) → Task 6 (ShellStep + shellParse). ✓
- Per-session backend-generated workspaceId + `workspace` SSE event → Task 4 (backend) + Task 6 Step 7 (frontend handling). ✓
- OpenShell settings overlay file (`openshell-settings.json`) + GET/PUT + test endpoint → Task 1 + Task 2. ✓
- Deepagent applies override on profile (4 spec fields + middleware toggle, `enabled` not in spec) + re-validates → Task 3. ✓
- `buildAgent(cfg, openshellOverride?)` → Task 3. ✓
- Settings form (enable toggle + 4 fields + unit helpers + Save/Test + Docker hint) → Task 5. ✓
- `agentChat.ts` no longer generates uuid; receives backend id → Task 6 Step 7. ✓
- Error handling: 422 on bad PUT (Task 2), `[error:]` → red badge (Task 6), disabled → no shell tool (Task 7 Step 5). ✓
- Tests: API openshell module + routes, deepagent override + buildAgent, frontend parser → Tasks 1-6. ✓
- Scope boundaries (deferred: structured stdout/stderr, workspace management view, profile picker, partial streaming, bridge host) → not implemented; confirmed absent. ✓

**2. Placeholder scan:** No TBD/TODO/"add error handling"/"similar to Task N". Every code step shows the actual code. ✓

**3. Type consistency:**
- `OpenShellSettings` (Task 1) ↔ `OpenShellOverride` (Task 3): same 5 fields; Task 4 Step 3 explicitly maps the 5 fields from the former into the latter. ✓
- `applyOpenShellOverride(profile, override)` signature consistent across Task 3 definition, Task 3 tests, and Task 3 `buildAgent` call. ✓
- `buildAgent(cfg, openshellOverride?)` signature consistent across Task 3 (agent.ts), Task 4 (chat route call `buildAgent(s, openshellOverride)`), Task 4 mock (`buildAgent: async (_cfg, override) => …`). ✓
- `parseShellResult` return shape `{ output, exit, warning?, error? }` consistent between Task 6 Step 3 (impl) and Step 1 (tests) and Step 5 (ShellStep reads `parsed.exit`, `parsed.error`, `parsed.output`, `parsed.warning`). ✓
- SSE event name `workspace` with payload `{ id }` consistent between Task 4 Step 3 (emit) and Task 6 Step 7 (consume) and Task 4 tests. ✓
- `agentOpenshell.ts` store functions `loadOpenShell/saveOpenShell/testOpenShell` ↔ `OpenShellForm.svelte` calls. ✓