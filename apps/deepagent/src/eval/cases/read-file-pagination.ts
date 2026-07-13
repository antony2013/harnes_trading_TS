// apps/deepagent/src/eval/cases/read-file-pagination.ts
import type { EvalCase } from '../types'

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `Line ${i + 1}: research note ${i + 1}.`).join('\n')
}

export const readFilePaginationCases: EvalCase[] = [
  {
    id: 'rf-1',
    category: 'read-file-pagination',
    prompt: 'Read the file notes.md and give me a one-line summary of all its content.',
    workspaceSeed: [{ path: 'notes.md', content: lines(250) }],
    stubRoutes: [],
    assertions: [
      { kind: 'calls', tool: 'read_file', min: 2 },
      {
        kind: 'custom',
        label: 'paged-forward',
        check: (t) => {
          const reads = t.filter((s) => s.name === 'read_file')
          const paged = reads.some((s) => Number(s.args.offset) > 0)
          return paged ? { passed: true } : { passed: false, detail: 'no read_file call had offset > 0' }
        },
      },
    ],
  },
  {
    id: 'rf-2',
    category: 'read-file-pagination',
    prompt: 'Read the file small.md and summarize it.',
    workspaceSeed: [{ path: 'small.md', content: lines(40) }],
    stubRoutes: [],
    assertions: [
      { kind: 'calls', tool: 'read_file', min: 1 },
      {
        kind: 'custom',
        label: 'no-needless-paging',
        check: (t) => {
          const reads = t.filter((s) => s.name === 'read_file')
          const paged = reads.some((s) => Number(s.args.offset) > 0)
          return paged ? { passed: false, detail: 'paged a 40-line file unnecessarily' } : { passed: true }
        },
      },
    ],
  },
]