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