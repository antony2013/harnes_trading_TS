// apps/deepagent/src/profiles/parse-jsonc.ts
/** Parse JSONC (JSON with comments) by stripping // and block comments that are
 *  not inside strings, then JSON.parse. No dependency. */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 2; continue }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') { inString = true; out += ch; i += 1; continue }
    if (ch === '/' && next === '/') {
      // line comment: skip to end of line
      i += 2
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      // block comment: skip to */
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return JSON.parse(out)
}