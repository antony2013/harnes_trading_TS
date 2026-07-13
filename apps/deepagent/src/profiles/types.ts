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