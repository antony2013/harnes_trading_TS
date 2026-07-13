// apps/deepagent/src/openshell/pool.ts
import type { ExecutionBackend, ExecResult, ExecOpts, WorkspaceInfo } from './backend'

export interface PoolOptions {
  idleTimeoutMs: number
  reapIntervalMs?: number
}

interface Entry { id: string; lastUsed: number; inFlight: number; chain: Promise<unknown> }

export class WorkspacePool {
  private entries = new Map<string, Entry>()
  private reapTimer?: ReturnType<typeof setInterval>

  constructor(private readonly backend: ExecutionBackend, private readonly opts: PoolOptions) {
    if (opts.reapIntervalMs !== undefined) {
      this.reapTimer = setInterval(() => void this.reapIdle(), opts.reapIntervalMs)
      // Note: keep timer unref'd semantics by allowing process to exit regardless — Bun keeps it; tests call stop().
    }
  }

  async exec(id: string, command: string, opts?: ExecOpts): Promise<ExecResult> {
    let entry = this.entries.get(id)
    if (!entry) {
      entry = { id, lastUsed: Date.now(), inFlight: 0, chain: Promise.resolve() }
      this.entries.set(id, entry)
      await this.backend.getOrCreateWorkspace(id)
    }
    // Per-id serialization: chain execs so only one is in-flight per workspace.
    const run = entry.chain.then(async () => {
      entry!.inFlight++
      try {
        entry!.lastUsed = Date.now()
        return await this.backend.exec(id, command, opts)
      } finally {
        entry!.inFlight--
      }
    })
    entry.chain = run.then(() => undefined, () => undefined)
    return run
  }

  async list(): Promise<WorkspaceInfo[]> {
    return [...this.entries.entries()].map(([id, e]) => ({ id, phase: 'ready', lastUsed: e.lastUsed }))
  }

  async reapIdle(): Promise<void> {
    const now = Date.now()
    for (const [id, e] of [...this.entries.entries()]) {
      if (e.inFlight === 0 && now - e.lastUsed > this.opts.idleTimeoutMs) {
        await this.backend.destroyWorkspace(id).catch(() => {})
        this.entries.delete(id)
      }
    }
  }

  stop(): void { if (this.reapTimer) clearInterval(this.reapTimer) }
}

/** Module-level singleton accessor — per-request buildAgent reuses one pool per process. */
let _singleton: WorkspacePool | undefined
export function getWorkspacePool(backend: ExecutionBackend, opts: PoolOptions): WorkspacePool {
  if (!_singleton) _singleton = new WorkspacePool(backend, opts)
  return _singleton
}
/** Test helper to reset the singleton between test files. */
export function _resetWorkspacePoolSingleton(): void { _singleton?.stop(); _singleton = undefined }