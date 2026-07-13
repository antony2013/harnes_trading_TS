// apps/deepagent/src/profiles/prompt.ts
import type { ResolvedProfile } from './types'
import { assembleBase } from './blocks'

/** The prompt loader / evolution seam. Today: datePrefix + base blocks (fixed
 *  order) + suffix. The ONLY place prompt composition lives. Future block-control
 *  (PromptSpec) plugs in here by widening systemPromptSuffix — no format change. */
export function assembleSystemPrompt(profile: ResolvedProfile, today: string): string {
  const datePrefix = profile.flags.injectTodayDate
    ? `Today's date is ${today} (IST, Indian market calendar). Treat this as the real current date for "current date"/"today" questions and as the default toDate for recent data.\n\n`
    : ''
  const base = assembleBase()
  const suffix = profile.systemPromptSuffix
  return datePrefix + base + (suffix ? `\n\n${suffix}` : '')
}