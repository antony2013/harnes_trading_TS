// apps/deepagent/src/profiles/loader.ts
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { parseJsonc } from './parse-jsonc'
import type { ProfileData, SubagentSpec, OpenShellOverride, SearchSpec, SearchOverride } from './types'
import { DEFAULT_PROFILE_DATA, SEARCH_SUBAGENT } from './defaults'
import { MIDDLEWARE_REGISTRY } from './middleware'
import { allTools } from '../tools'
export { resolveProfile } from './resolve'

const here = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(join(here, 'schema.json'), 'utf8'))
const ajv = new Ajv2020({ allErrors: true })
const validateSchema = ajv.compile(schema)

export class ProfileSchemaError extends Error {
  constructor(public file: string, public detail: string) {
    super(`profile schema error in ${file}: ${detail}`)
    this.name = 'ProfileSchemaError'
  }
}
export class ProfileVersionError extends Error {
  constructor(public got: number, public supported: number[]) {
    super(`unsupported profileVersion ${got}; supported: ${supported.join(', ')}`)
    this.name = 'ProfileVersionError'
  }
}

function profilesDir(): string {
  return process.env.AGENT_PROFILES_DIR || join(here, '../../profiles')
}

function sanitize(model: string): string {
  return model.replace(/[^A-Za-z0-9._-]/g, '_')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep-merge two ProfileData: subagents merge by name; interpreter/flags merge as
 *  objects; ptcAllowlist/middleware/systemPromptSuffix/profileVersion replace;
 *  lower-only keys kept. */
export function mergeProfiles(lower: ProfileData, higher: Partial<ProfileData>): ProfileData {
  const out: any = { ...lower }
  for (const [k, hv] of Object.entries(higher as Record<string, unknown>)) {
    if (k === 'subagents') {
      const lowerList = (lower.subagents ?? []) as SubagentSpec[]
      const merged: SubagentSpec[] = lowerList.map((s) => ({ ...s }))
      const byName = new Map(merged.map((s) => [s.name, s]))
      const seenInHigher = new Set<string>()
      for (const hsub of hv as SubagentSpec[]) {
        if (seenInHigher.has(hsub.name)) throw new Error(`duplicate subagent name: "${hsub.name}"`)
        seenInHigher.add(hsub.name)
        const existing = byName.get(hsub.name)
        if (existing) Object.assign(existing, hsub)   // patch (tools/middleware arrays replace via assign)
        else { merged.push({ ...hsub }); byName.set(hsub.name, merged[merged.length - 1]) }
      }
      out.subagents = merged
    } else if ((k === 'interpreter' || k === 'flags') && isPlainObject(hv) && isPlainObject((lower as any)[k])) {
      out[k] = { ...(lower as any)[k], ...hv }
    } else {
      out[k] = hv
    }
  }
  return out as ProfileData
}

function validateMerged(data: ProfileData): ProfileData {
  if (data.profileVersion !== 1) throw new ProfileVersionError(data.profileVersion, [1])
  const d: any = { ...data }
  d.systemPromptSuffix ??= ''
  d.flags ??= { injectTodayDate: true }
  if (!Array.isArray(d.ptcAllowlist) || d.ptcAllowlist.length === 0) throw new Error('profile missing ptcAllowlist')
  if (!d.interpreter?.executionTimeoutMs || typeof d.interpreter.subagents !== 'boolean')
    throw new Error('profile missing interpreter.executionTimeoutMs/subagents')
  if (!Array.isArray(d.middleware)) throw new Error('profile missing middleware')
  if (d.middleware.includes('openshell')) {
    const o = (d as any).openshell
    if (!o || typeof o.image !== 'string' || typeof o.idleTimeoutMs !== 'number' ||
        typeof o.bridgePort !== 'number' || typeof o.executionTimeoutMs !== 'number') {
      throw new Error('profile missing complete openshell spec (image/idleTimeoutMs/bridgePort/executionTimeoutMs)')
    }
  }
  if (d.middleware.includes('search')) {
    const s = (d as any).search
    if (!s || typeof s.searxngBaseUrl !== 'string' || typeof s.crawl4aiBaseUrl !== 'string' ||
        typeof s.maxResults !== 'number' || typeof s.crawlTimeoutMs !== 'number') {
      throw new Error('profile missing complete search spec (searxngBaseUrl/crawl4aiBaseUrl/maxResults/crawlTimeoutMs)')
    }
  }
  if (!Array.isArray(d.subagents) || d.subagents.length === 0) throw new Error('profile missing subagents')
  for (const s of d.subagents) {
    for (const f of ['description', 'systemPrompt', 'tools', 'middleware'] as const) {
      if (s[f] === undefined) throw new Error(`subagent "${s.name}" missing ${f}`)
    }
  }
  // references
  const toolNames = new Set(allTools.map((t: any) => t.name))
  for (const n of d.ptcAllowlist) if (!toolNames.has(n)) throw new Error(`unknown tool: "${n}"`)
  for (const n of d.middleware) if (!(n in MIDDLEWARE_REGISTRY)) throw new Error(`unknown middleware: "${n}"`)
  for (const s of d.subagents) {
    for (const n of s.middleware) if (!(n in MIDDLEWARE_REGISTRY)) throw new Error(`unknown middleware: "${n}"`)
    if (Array.isArray(s.tools)) for (const n of s.tools) if (!toolNames.has(n)) throw new Error(`unknown tool: "${n}"`)
  }
  const names = d.subagents.map((s: any) => s.name)
  const dup = names.find((n: string, i: number) => names.indexOf(n) !== i)
  if (dup) throw new Error(`duplicate subagent name: "${dup}"`)
  return d as ProfileData
}

function loadFile(file: string): any | undefined {
  const path = join(profilesDir(), file)
  if (!existsSync(path)) return undefined
  const raw = readFileSync(path, 'utf8')
  const data = parseJsonc(raw)
  if (validateSchema(data) !== true) {
    throw new ProfileSchemaError(file, ajv.errorsText(validateSchema.errors))
  }
  return data
}

/** Load + merge the 4-level chain: built-in -> default.jsonc -> <provider>__default.jsonc
 *  -> <provider>__<model>.jsonc. Each higher layer overrides; subagents merge by name. */
export function loadProfile(provider: string, model: string): ProfileData {
  let result: ProfileData = { ...DEFAULT_PROFILE_DATA, subagents: DEFAULT_PROFILE_DATA.subagents.map((s) => ({ ...s })) }
  for (const file of ['default.jsonc', `${provider}__default.jsonc`, `${provider}__${sanitize(model)}.jsonc`]) {
    const layer = loadFile(file)
    if (layer) result = mergeProfiles(result, layer)
  }
  return validateMerged(result)
}

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

/** Apply an API-supplied search override on top of a validated profile, then
 *  re-validate. enabled=true adds the 'search' middleware, the SearchSpec, and
 *  splices in the SEARCH_SUBAGENT; enabled=false strips all three. `enabled` is
 *  never written into SearchSpec (the spec has no enabled field). */
export function applySearchOverride(profile: ProfileData, override: SearchOverride): ProfileData {
  if (override.enabled) {
    const middleware = profile.middleware.includes('search')
      ? profile.middleware
      : [...profile.middleware, 'search']
    const hasSub = profile.subagents.some((s) => s.name === 'search')
    const subagents = hasSub ? profile.subagents : [...profile.subagents, { ...SEARCH_SUBAGENT }]
    return validateMerged({
      ...profile,
      middleware,
      subagents,
      search: {
        searxngBaseUrl: override.searxngBaseUrl,
        crawl4aiBaseUrl: override.crawl4aiBaseUrl,
        maxResults: override.maxResults,
        crawlTimeoutMs: override.crawlTimeoutMs,
      },
    })
  }
  // disabled: strip 'search' middleware, drop the spec, remove the search subagent.
  const middleware = profile.middleware.filter((m) => m !== 'search')
  const subagents = profile.subagents.filter((s) => s.name !== 'search')
  const wasPresent =
    middleware.length !== profile.middleware.length ||
    subagents.length !== profile.subagents.length ||
    (profile as any).search !== undefined
  if (!wasPresent) return profile
  const next: ProfileData = { ...profile, middleware, subagents }
  delete (next as any).search
  return validateMerged(next)
}