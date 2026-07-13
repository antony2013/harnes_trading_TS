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