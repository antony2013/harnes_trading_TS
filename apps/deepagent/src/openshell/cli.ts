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

export interface RunCliResult { stdout: string; stderr: string; exitCode: number }

export async function runCli(
  binary: string | string[],
  args: string[],
  opts?: { timeoutMs?: number; input?: string }
): Promise<RunCliResult> {
  // binary may be a single executable ("openshell") or a prefix list (e.g.
  // ["bash", script] for tests on OSes that don't honor shebangs on
  // extension-less scripts, or ["wsl", "--", "openshell"] for a future host).
  const proc = Bun.spawn(
    Array.isArray(binary) ? [...binary, ...args] : [binary, ...args],
    {
      stdin: opts?.input ? 'pipe' : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  if (opts?.input) {
    proc.stdin!.write(opts.input)
    await proc.stdin!.end()
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

/** `openshell sandbox create --name <id> --from <image>` (+ optional env uploads). */
export function createArgs(id: string, image: string, env?: Record<string, string>): string[] {
  const args = ['sandbox', 'create', '--name', id, '--from', image]
  for (const [k, v] of Object.entries(env ?? {})) args.push('--env', `${k}=${v}`)
  return args
}
export function execArgs(id: string, command: string, cwd?: string): string[] {
  const args = ['sandbox', 'exec', '--name', id]
  if (cwd) args.push('--cwd', cwd)
  args.push('--', 'sh', '-c', `${command}; printf '\\n${EXIT_MARKER}%d>>>' "$?"`)
  return args
}
export function deleteArgs(id: string): string[] { return ['sandbox', 'delete', '--name', id] }
export function listArgs(): string[] { return ['sandbox', 'list'] }