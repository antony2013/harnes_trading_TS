// apps/deepagent/src/openshell/middleware.ts
import { randomUUID } from 'node:crypto'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { AgentMiddleware } from '@langchain/core/multi_agent'
import type { ExecutionBackend } from './backend'
import { WorkspacePool, getWorkspacePool } from './pool'
import { getToolBridge } from './bridge'
import { OpenShellCliBackend } from './openshell-cli-backend'

export interface OpenShellMiddlewareOpts {
  image: string
  idleTimeoutMs: number
  bridgePort: number
  executionTimeoutMs: number
  ptcAllowlist: string[]
  allTools: any[]
  /** Inject a backend for testing; default = OpenShellCliBackend. */
  backend?: ExecutionBackend
  bridgeHost?: string // host-gateway address reachable from containers
}

export function buildOpenShellMiddleware(opts: OpenShellMiddlewareOpts): AgentMiddleware {
  // Generate the bearer token eagerly (cheap, no I/O) so the sandbox env baked at
  // create-time and the lazily-bound bridge use the SAME token. The server itself
  // binds lazily on the first shell call (below) — resolveProfile/tests start no server.
  const bridgeToken = randomUUID()
  const bridgeHost = opts.bridgeHost ?? 'host.docker.internal'
  const backend = opts.backend ?? new OpenShellCliBackend({
    image: opts.image,
    bridgeEnv: {
      OPENSHELL_BRIDGE_HOST: bridgeHost,
      OPENSHELL_BRIDGE_PORT: String(opts.bridgePort),
      OPENSHELL_BRIDGE_TOKEN: bridgeToken,
    },
  })
  const pool = getWorkspacePool(backend, { idleTimeoutMs: opts.idleTimeoutMs })

  const shellTool = tool(
    async ({ command, upload, download }, config: any) => {
      const wid = config?.configurable?.workspace_id ?? config?.configurable?.thread_id ?? '__default__'
      try {
        // Lazily bind the bridge on first shell call (process singleton). Pre-supplied
        // token matches what the sandbox already has in its env. No-op after the first call.
        await getToolBridge({ port: opts.bridgePort, allowedTools: opts.ptcAllowlist, allTools: opts.allTools, token: bridgeToken })
        const r = await pool.exec(wid, command, { upload, download, timeoutMs: opts.executionTimeoutMs })
        return `${r.output}\n\n[exit: ${r.exitCode}] [persistent shell: cwd, env, installed packages, and /workspace files persist across your shell calls within this workspace]${r.parseWarning ? ' [warning: exit marker not found, output may be incomplete]' : ''}`
      } catch (err: any) {
        return `[error: ${String(err?.message ?? err)}]`
      }
    },
    {
      name: 'shell',
      description:
        'Run a shell command in the persistent sandbox for this workspace. The sandbox is a real Linux environment (bash, python, node, curl, git). State (cwd, env vars, installed packages, files in /workspace) persists across calls within this workspace. Use `upload` (host->sandbox) and `download` (sandbox->host) only as low-level file crossings; author files inside the sandbox by default and export final artifacts via download.',
      schema: z.object({
        command: z.string().describe('The shell command to run.'),
        upload: z.array(z.string()).optional().describe('Host file paths to upload into /workspace before running.'),
        download: z.array(z.string()).optional().describe('Sandbox paths to download to the host workspace after running (export).'),
      }),
    }
  )

  const mw: AgentMiddleware = {
    name: 'OpenShellMiddleware', // unique — must not collide with CodeInterpreterMiddleware
    tools: [shellTool],
    // No afterAgent destruction — the sandbox persists; idle-reap handles teardown.
  }
  return mw
}