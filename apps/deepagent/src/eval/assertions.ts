// apps/deepagent/src/eval/assertions.ts
import type { Assertion, TrajectoryStep, AssertionResult } from './types'

function callsFor(traj: TrajectoryStep[], tool: string): TrajectoryStep[] {
  return traj.filter((t) => t.name === tool)
}

export function gradeAssertion(a: Assertion, traj: TrajectoryStep[]): AssertionResult {
  switch (a.kind) {
    case 'calls': {
      const n = callsFor(traj, a.tool).length
      const ok = (a.min === undefined || n >= a.min) && (a.max === undefined || n <= a.max)
      return { assertion: a, passed: ok, detail: `${a.tool} called ${n} time(s)` }
    }
    case 'not_called': {
      const n = callsFor(traj, a.tool).length
      return { assertion: a, passed: n === 0, detail: n ? `${a.tool} called ${n} time(s)` : undefined }
    }
    case 'order': {
      let idx = 0
      for (const step of traj) {
        if (step.name === a.sequence[idx]) idx++
        if (idx === a.sequence.length) break
      }
      return { assertion: a, passed: idx === a.sequence.length, detail: `matched ${idx}/${a.sequence.length} of ${a.sequence.join(' -> ')}` }
    }
    case 'arg_in': {
      const hits = callsFor(traj, a.tool).filter((t) => a.values.includes(t.args[a.arg]))
      return { assertion: a, passed: hits.length > 0, detail: hits.length ? undefined : `${a.tool}.${a.arg} not in ${JSON.stringify(a.values)}` }
    }
    case 'arg_not_in': {
      const bad = callsFor(traj, a.tool).filter((t) => a.values.includes(t.args[a.arg]))
      return { assertion: a, passed: bad.length === 0, detail: bad.length ? `${a.tool}.${a.arg} was ${JSON.stringify(bad[0].args[a.arg])}` : undefined }
    }
    case 'arg_matches': {
      const re = new RegExp(a.regex)
      const hits = callsFor(traj, a.tool).filter((t) => re.test(String(t.args[a.arg] ?? '')))
      return { assertion: a, passed: hits.length > 0, detail: hits.length ? undefined : `${a.tool}.${a.arg} did not match /${a.regex}/` }
    }
    case 'first_is': {
      const first = traj[0]?.name
      return { assertion: a, passed: first === a.tool, detail: `first call was ${first ?? '(none)'}` }
    }
    case 'custom': {
      const r = a.check(traj)
      return { assertion: a, passed: r.passed, detail: r.detail }
    }
  }
}

export function gradeCase(assertions: Assertion[], traj: TrajectoryStep[]): AssertionResult[] {
  return assertions.map((a) => gradeAssertion(a, traj))
}