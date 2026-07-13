// apps/deepagent/src/profiles/resolve.ts
import type { ProfileData, ResolvedProfile, ResolvedSubagent, ToolSetSpec } from './types'
import { MIDDLEWARE_REGISTRY, type MwCtx } from './middleware'
import { allTools } from '../tools'

/** Resolve a named tool-set against this profile's ptcAllowlist (single source
 *  of truth). "readOnly" derives from ptcAllowlist; explicit names fail-fast. */
export function resolveTools(spec: ToolSetSpec, ptcAllowlist: string[]): unknown[] {
  if (spec === 'readOnly') return allTools.filter((t: any) => ptcAllowlist.includes(t.name))
  if (spec === 'all') return allTools
  if (spec === 'none') return []
  const byName = new Map(allTools.map((t: any) => [t.name, t] as const))
  return spec.map((name) => {
    const t = byName.get(name)
    if (!t) throw new Error(`unknown tool: "${name}"`)
    return t
  })
}

/** Turn validated ProfileData (names) into ResolvedProfile (real Tool objects +
 *  built middleware). The interpreter builder forces subagents:false for any
 *  subagent (parent:false) — bounds recursion to depth 1. */
export function resolveProfile(data: ProfileData): ResolvedProfile {
  const openshell = data.middleware.includes('openshell') ? data.openshell : undefined
  const parentCtx: MwCtx = { ptcAllowlist: data.ptcAllowlist, interpreter: data.interpreter, parent: true, openshell, allTools }
  const parentMiddleware = data.middleware.map((name) => {
    const builder = MIDDLEWARE_REGISTRY[name]
    if (!builder) throw new Error(`unknown middleware: "${name}"`)
    return builder(parentCtx)
  })
  const subagents: ResolvedSubagent[] = data.subagents.map((s) => {
    const subOpenshell = s.middleware.includes('openshell') ? data.openshell : undefined
    const subCtx: MwCtx = { ptcAllowlist: data.ptcAllowlist, interpreter: data.interpreter, parent: false, openshell: subOpenshell, allTools }
    const middleware = s.middleware.map((name) => {
      const builder = MIDDLEWARE_REGISTRY[name]
      if (!builder) throw new Error(`unknown middleware: "${name}"`)
      return builder(subCtx)
    })
    return {
      name: s.name,
      description: s.description,
      systemPrompt: s.systemPrompt,
      tools: resolveTools(s.tools, data.ptcAllowlist),
      middleware,
    }
  })
  return {
    profileVersion: data.profileVersion,
    systemPromptSuffix: data.systemPromptSuffix,
    ptcAllowlist: data.ptcAllowlist,
    interpreter: data.interpreter,
    parentMiddleware,
    subagents,
    flags: data.flags,
  }
}