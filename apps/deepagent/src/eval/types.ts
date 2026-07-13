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
  scope?: string   // 'coordinator' (default) or the subagent name; absent == 'coordinator'
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