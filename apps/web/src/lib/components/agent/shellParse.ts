export interface ParsedShellResult {
  output: string;
  exit: number | null;
  warning?: string;
  error?: string;
}

/** Parse a shell tool_result string into structured fields.
 *  Format (success): `${output}\n\n[exit: N] [persistent shell: …][optional [warning: …]]`
 *  Format (error):   `[error: ${msg}]` */
export function parseShellResult(s: string): ParsedShellResult {
  if (!s) return { output: '', exit: null }
  const errorMatch = s.match(/\[error:\s+(.+?)\]\s*$/)
  if (errorMatch) return { output: '', exit: null, error: errorMatch[1] }
  const exitMatch = s.match(/\[exit:\s*(-?\d+)\]/)
  const exit = exitMatch ? parseInt(exitMatch[1], 10) : null
  const warningMatch = s.match(/\[warning:\s+(.+?)\]/)
  const warning = warningMatch?.[1]
  let output = s
    .replace(/\[exit:\s*-?\d+\]\s*/g, '')
    .replace(/\[persistent shell:[^\]]*\]\s*/g, '')
    .replace(/\[warning:[^\]]*\]\s*/g, '')
    .replace(/\[error:[^\]]*\]\s*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
  return { output, exit, warning }
}