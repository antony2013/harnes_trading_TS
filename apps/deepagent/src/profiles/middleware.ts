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