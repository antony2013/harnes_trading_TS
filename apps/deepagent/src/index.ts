import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { buildAgent, resolveAgentConfig } from './agent'

async function main() {
  const cfg = resolveAgentConfig()
  if (!cfg) {
    console.error(
      'No agent config. Either save settings via apps/web /settings (writes apps/api/data/agent-settings.json), or set DEEPAGENT_MODEL + the matching API key env var.',
    )
    process.exit(1)
  }
  const agent = await buildAgent(cfg)
  console.log(`deepagent ready (${cfg.provider}:${cfg.model}). Type a question (empty line or "exit" to quit).`)
  const rl = readline.createInterface({ input, output })
  while (true) {
    const line = (await rl.question('\n> ')).trim()
    if (!line || line.toLowerCase() === 'exit') break
    try {
      const result = await agent.invoke({
        messages: [{ role: 'user', content: line }],
      })
      const msgs = (result?.messages ?? []) as Array<{ content?: unknown }>
      const last = msgs[msgs.length - 1]
      const text =
        typeof last?.content === 'string'
          ? last.content
          : last?.content
            ? JSON.stringify(last.content)
            : '(no output)'
      console.log(text)
    } catch (err: any) {
      console.error('Agent error:', err?.message ?? String(err))
    }
  }
  rl.close()
}

main()