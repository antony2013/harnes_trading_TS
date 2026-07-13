// apps/deepagent/src/eval/run.ts (Task 6 portion)
import type { TrajectoryStep, EvalCase, EvalResult } from './types'
import { startStubServer } from './stub-server'
import { createSeededWorkspace } from './workspace'
import { gradeCase } from './assertions'
import { ALL_CASES } from './cases'
import { buildAgent, type AgentConfig } from '../agent'

export interface RunCapture {
  trajectory: TrajectoryStep[]
  finalAnswer: string
  error?: string
}

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

// apps/deepagent/src/eval/run.ts (Task 7 portion)
export interface RunSuiteOptions {
  cfg: AgentConfig
  cases?: EvalCase[]
  categories?: string[]
  /** Test seam: defaults to the real buildAgent. The ralph loop (C) will add a `profile?` here. */
  buildAgentFn?: (cfg: AgentConfig) => Promise<any>
}

async function runCase(c: EvalCase, cfg: AgentConfig, build: (cfg: AgentConfig) => Promise<any>): Promise<EvalResult> {
  const started = Date.now()
  const prevApi = process.env.API_BASE_URL
  const prevWs = process.env.AGENT_WORKSPACE_DIR
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), c.timeoutMs ?? 60_000)
  let server: { url: string; stop: () => Promise<void> } | undefined
  let ws: { dir: string; cleanup: () => void } | undefined
  try {
    server = await startStubServer(c.stubRoutes)
    ws = createSeededWorkspace(c.workspaceSeed)
    process.env.API_BASE_URL = server.url
    process.env.AGENT_WORKSPACE_DIR = ws.dir
    const agent = await build(cfg)
    const stream = await agent.streamEvents(
      { messages: [{ role: 'user', content: c.prompt }] },
      { version: 'v3', signal: controller.signal },
    )
    const cap = await captureRun(stream, {
      maxTurns: c.maxTurns ?? 8,
      signal: controller.signal,
      abort: () => controller.abort(),
    })
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
    await server?.stop()
    ws?.cleanup()
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