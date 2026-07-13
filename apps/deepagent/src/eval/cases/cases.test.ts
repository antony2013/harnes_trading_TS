// apps/deepagent/src/eval/cases/cases.test.ts
import { test, expect } from 'bun:test'
import { ALL_CASES } from './index'

test('ALL_CASES non-empty with unique ids and required fields', () => {
  expect(ALL_CASES.length).toBeGreaterThan(0)
  const ids = ALL_CASES.map((c) => c.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const c of ALL_CASES) {
    expect(c.prompt.length).toBeGreaterThan(0)
    expect(Array.isArray(c.stubRoutes)).toBe(true)
    expect(c.assertions.length).toBeGreaterThan(0)
  }
})

test('all four categories are represented', () => {
  const cats = new Set(ALL_CASES.map((c) => c.category))
  expect(cats).toEqual(new Set(['instrument-resolution', 'candle-sync', 'read-file-pagination', 'orchestration']))
})