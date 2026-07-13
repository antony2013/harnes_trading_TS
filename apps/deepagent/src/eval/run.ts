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