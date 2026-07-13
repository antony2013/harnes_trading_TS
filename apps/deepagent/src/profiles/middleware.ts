// apps/deepagent/src/profiles/middleware.ts
import type { InterpreterSpec, OpenShellSpec } from './types'
import {
  buildInterpreterMiddleware,
  buildCoerceToolContentMiddleware,
  buildReadFileContinuationMiddleware,
} from './implementations'
import { buildOpenShellMiddleware } from '../openshell/middleware'

export interface MwCtx {
  ptcAllowlist: string[]
  interpreter: InterpreterSpec
  parent: boolean
  openshell?: OpenShellSpec   // present only when middleware includes 'openshell'
  allTools: unknown[]         // the real Tool objects (for the bridge)
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
  openshell: (ctx) => {
    const o = ctx.openshell
    if (!o || typeof o.image !== 'string' || typeof o.idleTimeoutMs !== 'number' ||
        typeof o.bridgePort !== 'number' || typeof o.executionTimeoutMs !== 'number') {
      throw new Error('openshell middleware selected but profile has no complete openshell spec (image/idleTimeoutMs/bridgePort/executionTimeoutMs)')
    }
    return buildOpenShellMiddleware({
      ...o,
      ptcAllowlist: ctx.ptcAllowlist,
      allTools: ctx.allTools as any[],
    })
  },
}