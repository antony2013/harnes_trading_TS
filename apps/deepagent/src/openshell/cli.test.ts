// apps/deepagent/src/openshell/cli.test.ts
import { test, expect } from 'bun:test'
import { parseExecOutput, runCli, EXIT_MARKER, type ExecResult } from './cli'

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

// --- runCli timeout enforcement (I2) ---
// Hermetic, cross-platform, no openshell binary required: spawn a real
// never-exiting bun child and assert runCli resolves (with a timeout
// marker) within a bounded window instead of hanging. Red-green: on the
// old code (timeoutMs ignored) this test hangs past the assertion bound.
test('runCli: enforces opts.timeoutMs — kills a hung child and resolves with exit -1 + timeout marker', async () => {
  const timeoutMs = 200
  const start = Date.now()
  const r = await runCli(['bun', '-e', 'await new Promise(() => {})'], [], { timeoutMs })
  const elapsed = Date.now() - start
  // Resolves promptly (kill + cleanup), well under 2x the timeout.
  expect(elapsed).toBeLessThan(timeoutMs * 2)
  expect(r.exitCode).toBe(-1)
  expect(r.stderr).toContain('execution timed out')
  expect(r.stderr).toContain(`${timeoutMs}ms`)
})

test('runCli: a normally-exiting child is unaffected by timeoutMs', async () => {
  const r = await runCli(['bun', '-e', 'console.log("ok")'], [], { timeoutMs: 5000 })
  expect(r.exitCode).toBe(0)
  expect(r.stdout.trim()).toBe('ok')
})

test('runCli: no timeoutMs waits for natural exit (backward compatible)', async () => {
  const r = await runCli(['bun', '-e', 'console.log("done")'], [])
  expect(r.exitCode).toBe(0)
  expect(r.stdout.trim()).toBe('done')
})