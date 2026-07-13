// apps/deepagent/src/eval/workspace.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { WorkspaceSeedFile } from './types'

export interface SeededWorkspace {
  dir: string
  cleanup: () => void
}

export function createSeededWorkspace(seed: WorkspaceSeedFile[] = []): SeededWorkspace {
  const dir = mkdtempSync(join(tmpdir(), 'eval-ws-'))
  for (const f of seed) {
    const full = join(dir, f.path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, f.content)
  }
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}