// apps/deepagent/src/eval/cli.ts
import { writeFileSync } from 'node:fs'
import { runSuite } from './run'
import { summarize, toJson } from './report'
import { ALL_CASES } from './cases'
import { resolveAgentConfig, type AgentConfig } from '../agent'

export interface CliArgs {
  provider?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  fromSettings?: boolean
  categories: string[]
  caseId?: string
  json?: boolean
  out?: string
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { categories: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--provider': out.provider = argv[++i]; break
      case '--model': out.model = argv[++i]; break
      case '--apiKey': out.apiKey = argv[++i]; break
      case '--baseUrl': out.baseUrl = argv[++i]; break
      case '--from-settings': out.fromSettings = true; break
      case '--category': out.categories.push(argv[++i]); break
      case '--case': out.caseId = argv[++i]; break
      case '--json': out.json = true; break
      case '--out': out.out = argv[++i]; break
    }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let cfg: AgentConfig
  if (args.fromSettings) {
    cfg = resolveAgentConfig()!
    if (!cfg) {
      console.error('No agent settings. Configure via apps/web /settings (writes apps/api/data/agent-settings.json).')
      process.exit(1)
    }
  } else {
    cfg = {
      provider: (args.provider as AgentConfig['provider']) ?? 'ollama',
      apiKey: args.apiKey ?? '',
      baseUrl: args.baseUrl ?? '',
      model: args.model ?? '',
    }
    if (!cfg.model) {
      console.error('--model is required (or use --from-settings)')
      process.exit(1)
    }
  }
  const cases = args.caseId ? ALL_CASES.filter((c) => c.id === args.caseId) : ALL_CASES
  const results = await runSuite({ cfg, cases, categories: args.categories.length ? args.categories : undefined })
  console.log(args.json ? toJson(results) : summarize(results))
  writeFileSync(args.out ?? 'src/eval/results-latest.json', toJson(results))
  process.exit(results.some((r) => !r.passed) ? 1 : 0)
}

if (import.meta.main) main()