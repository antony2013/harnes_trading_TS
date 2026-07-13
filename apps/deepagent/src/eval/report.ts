// apps/deepagent/src/eval/report.ts
import type { EvalResult } from './types'

export function summarize(results: EvalResult[]): string {
  const passed = results.filter((r) => r.passed).length
  const blocks = results.map((r) => {
    const head = `${r.passed ? 'PASS' : 'FAIL'} ${r.caseId} (${r.category}) — ${r.assertionResults.length} assertions, ${r.durationMs}ms`
    if (r.passed) return head
    const fails = r.assertionResults
      .filter((a) => !a.passed)
      .map((a) => `    ✗ ${a.detail ?? '(no detail)'}`)
      .join('\n')
    const traj = r.trajectory
      .map((t) => `    ${t.name}(${JSON.stringify(t.args)})`)
      .join('\n')
    const err = r.error ? `\n  error: ${r.error}` : ''
    return `${head}\n  failing assertions:\n${fails}\n  trajectory:\n${traj}${err}`
  })
  return `${blocks.join('\n')}\n\n${passed}/${results.length} passed`
}

export function toJson(results: EvalResult[]): string {
  return JSON.stringify(results, null, 2)
}