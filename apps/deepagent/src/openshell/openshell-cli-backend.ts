// apps/deepagent/src/openshell/openshell-cli-backend.ts
import type { ExecutionBackend, ExecResult, WorkspaceHandle, WorkspaceInfo, ExecOpts } from './backend'
import { runCli, parseExecOutput, createArgs, execArgs, deleteArgs } from './cli'

export interface OpenShellCliBackendOpts {
  /** CLI to invoke: "openshell" (default, production) or a prefix list like
   *  ["bash", script] for tests on OSes that don't honor shebangs on
   *  extension-less scripts. */
  binary?: string | string[]
  image: string
  defaultCwd?: string
  /** Bridge env injected into each sandbox at create time. */
  bridgeEnv?: Record<string, string>
}

export class OpenShellCliBackend implements ExecutionBackend {
  private readonly binary: string | string[]
  private readonly cwd: string
  constructor(private readonly opts: OpenShellCliBackendOpts) {
    this.binary = opts.binary ?? 'openshell'
    this.cwd = opts.defaultCwd ?? '/workspace'
  }

  async getOrCreateWorkspace(id: string): Promise<WorkspaceHandle> {
    // v1: create is idempotent enough for our use; OpenShell returns Ready or errors.
    const env = { ...this.opts.bridgeEnv }
    const r = await runCli(this.binary, createArgs(id, this.opts.image, env))
    if (r.exitCode !== 0) return { id, phase: 'error' }
    return { id, phase: 'ready' }
  }

  async exec(id: string, command: string, opts?: ExecOpts): Promise<ExecResult> {
    const r = await runCli(this.binary, execArgs(id, command, opts?.cwd ?? this.cwd), { timeoutMs: opts?.timeoutMs })
    // combine stdout+stderr (matches LocalShellBackend semantics); marker is on stdout
    return parseExecOutput(r.stdout + r.stderr)
  }

  async destroyWorkspace(id: string): Promise<void> {
    await runCli(this.binary, deleteArgs(id))
  }

  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    const r = await runCli(this.binary, ['sandbox', 'list'])
    // v1: best-effort parse; full parsing is not required for correctness (pool tracks state)
    return r.stdout.split('\n').filter(Boolean).map((line) => ({ id: line, phase: 'ready', lastUsed: 0 }))
  }
}