// apps/deepagent/src/openshell/backend.ts
export interface ExecResult {
  output: string
  exitCode: number
  truncated?: boolean
  parseWarning?: boolean
}

export interface WorkspaceHandle {
  id: string
  phase: 'provisioning' | 'ready' | 'error'
}

export interface WorkspaceInfo {
  id: string
  phase: string
  lastUsed: number
}

export interface ExecOpts {
  cwd?: string
  env?: Record<string, string>
  upload?: string[]   // host paths -> sandbox /workspace (low-level seed)
  download?: string[] // sandbox paths -> host per-workspace dir (low-level export)
  timeoutMs?: number
}

/** The execution-layer seam. v1 impl: OpenShellCliBackend (Task 3).
 *  FUTURE (added behind this interface, no agent-arch change): snapshot/restore, listProcesses/killProcess. */
export interface ExecutionBackend {
  getOrCreateWorkspace(id: string): Promise<WorkspaceHandle>
  exec(id: string, command: string, opts?: ExecOpts): Promise<ExecResult>
  destroyWorkspace(id: string): Promise<void>
  listWorkspaces(): Promise<WorkspaceInfo[]>
}

/** In-process reference implementation + test double. No OpenShell/Docker required. */
export class InMemoryExecutionBackend implements ExecutionBackend {
  private workspaces = new Map<string, { phase: WorkspaceHandle['phase']; lastUsed: number }>()
  public execLog: { id: string; command: string; opts?: ExecOpts }[] = []
  constructor(private readonly resultFor?: (command: string) => ExecResult) {}

  async getOrCreateWorkspace(id: string): Promise<WorkspaceHandle> {
    if (!this.workspaces.has(id)) {
      this.workspaces.set(id, { phase: 'ready', lastUsed: Date.now() })
    }
    return { id, phase: this.workspaces.get(id)!.phase }
  }

  async exec(id: string, command: string, opts?: ExecOpts): Promise<ExecResult> {
    this.execLog.push({ id, command, opts })
    const ws = this.workspaces.get(id)
    if (!ws) throw new Error(`unknown workspace: ${id}`)
    ws.lastUsed = Date.now()
    return this.resultFor ? this.resultFor(command) : { output: '', exitCode: 0 }
  }

  async destroyWorkspace(id: string): Promise<void> {
    this.workspaces.delete(id)
  }

  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    return [...this.workspaces.entries()].map(([id, v]) => ({ id, phase: v.phase, lastUsed: v.lastUsed }))
  }
}