// apps/deepagent/src/openshell/wrappers.ts
export interface WrapperOpts {
  bridgeHostEnv: string   // e.g. 'OPENSHELL_BRIDGE_HOST'
  bridgePortEnv: string
  tokenEnv: string
  port: number
  timeoutMs: number
  // Per-tool arg specs: arg name -> whether required. v1: a single generic convention
  // (--<arg> value) covers tools with flat string/number args. Complex schemas are
  // handled at plan time per the spec's open-questions list.
  argSpecs?: Record<string, string[]> // toolName -> arg names
}

const DEFAULT_ARG_SPECS: Record<string, string[]> = {
  search_instruments: ['query'],
  get_ltp: ['instrument'],
  get_ohlc_quote: ['instrument'],
  historical_candles: ['instrument', 'interval', 'from_date', 'to_date'],
  intraday_candles: ['instrument', 'interval'],
  option_chain: ['instrument'],
  market_status: [],
  read_candles: ['instrument', 'interval'],
  company_profile: ['instrument'],
  news: ['query'],
}

/** Generate one bash wrapper per allowed tool. Reads bridge location + token from env
 *  at runtime (so one image works across processes/ports/tokens). */
export function generateWrappers(allowlist: string[], opts: WrapperOpts): Record<string, string> {
  const specs = { ...DEFAULT_ARG_SPECS, ...(opts.argSpecs ?? {}) }
  const out: Record<string, string> = {}
  for (const name of allowlist) {
    const args = specs[name] ?? []
    const parseLines = args.map((a) => `  --${a}) ${a}="$2"; shift 2;;`).join('\n')
    const jsonParts = args.map((a) => `"${a}":"$${a}"`).join(',')
    out[name] = `#!/usr/bin/env bash
# OpenShell tool wrapper -> bridges to the deepagent ToolBridge.
set -euo pipefail
${args.map((a) => `${a}=`).join('\n')}
while [[ $# -gt 0 ]]; do
  case "$1" in${parseLines}
    *) shift;;
  esac
done
body='{${jsonParts}}'
exec curl -s --max-time ${opts.timeoutMs} \\
  -H "Authorization: Bearer $${opts.tokenEnv}" \\
  -H "content-type: application/json" \\
  -d "$body" \\
  "http://$${opts.bridgeHostEnv}:$${opts.bridgePortEnv}/${name}"
`
  }
  return out
}

// CLI mode for image builds: bun run src/openshell/wrappers.ts --out <dir> --tools a,b --port N
if (import.meta.main) {
  const args = process.argv.slice(2)
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
  const out = get('--out'); const tools = (get('--tools') ?? '').split(',').filter(Boolean)
  const port = Number(get('--port') ?? '7777'); const timeoutMs = Number(get('--timeout') ?? '30')
  if (!out || tools.length === 0) { console.error('usage: --out <dir> --tools a,b [--port N] [--timeout s]'); process.exit(2) }
  const { writeFileSync, mkdirSync } = require('node:fs')
  mkdirSync(out, { recursive: true })
  const w = generateWrappers(tools, { bridgeHostEnv: 'OPENSHELL_BRIDGE_HOST', bridgePortEnv: 'OPENSHELL_BRIDGE_PORT', tokenEnv: 'OPENSHELL_BRIDGE_TOKEN', port, timeoutMs })
  for (const [name, script] of Object.entries(w)) { const p = require('node:path').join(out, name); writeFileSync(p, script); require('node:fs').chmodSync(p, 0o755) }
  console.log(`wrote ${Object.keys(w).length} wrappers to ${out}`)
}