// apps/deepagent/src/openshell/cli.ts
export type { ExecResult } from './backend'
import type { ExecResult } from './backend'

export const EXIT_MARKER = '<<<OPENSHELL_EXIT:'

/** Parse combined stdout+stderr emitted by `sh -c '<cmd>; printf "\n<<<OPENSHELL_EXIT:$?>>>"'`.
 *  Never throws: a missing/malformed marker yields parseWarning + exitCode -1. */
export function parseExecOutput(raw: string): ExecResult {
  const idx = raw.lastIndexOf(EXIT_MARKER)
  if (idx === -1) return { output: raw, exitCode: -1, parseWarning: true }
  const after = raw.slice(idx + EXIT_MARKER.length)
  const m = after.match(/^(\d+)>>>/)
  const output = raw.slice(0, idx).replace(/\n$/, '')
  if (!m) return { output, exitCode: -1, parseWarning: true }
  return { output, exitCode: Number(m[1]) }
}