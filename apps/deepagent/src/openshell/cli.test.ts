// apps/deepagent/src/openshell/cli.test.ts
import { test, expect } from 'bun:test'
import { parseExecOutput, EXIT_MARKER, type ExecResult } from './cli'

test('parseExecOutput: splits output and exit code on the marker', () => {
  const raw = `hello\n${EXIT_MARKER}0>>>`
  const r = parseExecOutput(raw)
  expect(r).toEqual({ output: 'hello', exitCode: 0 })
})

test('parseExecOutput: preserves multi-line output, strips trailing newline before marker', () => {
  const raw = `line1\nline2\n\n${EXIT_MARKER}1>>>`
  const r = parseExecOutput(raw)
  expect(r.output).toBe('line1\nline2\n')
  expect(r.exitCode).toBe(1)
})

test('parseExecOutput: parseWarning when marker absent', () => {
  const r = parseExecOutput('no marker here')
  expect(r.parseWarning).toBe(true)
  expect(r.exitCode).toBe(-1)
  expect(r.output).toBe('no marker here')
})

test('parseExecOutput: parseWarning when marker present but digits malformed', () => {
  const r = parseExecOutput(`out\n${EXIT_MARKER}abc>>>`)
  expect(r.parseWarning).toBe(true)
  expect(r.output).toBe('out')
})

test('parseExecOutput: handles exit code with large value', () => {
  const r = parseExecOutput(`${EXIT_MARKER}255>>>`)
  expect(r.exitCode).toBe(255)
  expect(r.output).toBe('')
})