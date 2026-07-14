import { test, expect } from 'bun:test'
import { parseShellResult } from './shellParse'

test('parseShellResult: exit 0 + persistent-shell marker stripped', () => {
  const s = 'total 0\ndrwxr-xr-x 2 root root 40 May 1 10:00 .\n\n[exit: 0] [persistent shell: cwd, env, installed packages, and /workspace files persist across your shell calls within this workspace]'
  const r = parseShellResult(s)
  expect(r.exit).toBe(0)
  expect(r.warning).toBeUndefined()
  expect(r.error).toBeUndefined()
  expect(r.output).toBe('total 0\ndrwxr-xr-x 2 root root 40 May 1 10:00 .')
})

test('parseShellResult: non-zero exit', () => {
  const r = parseShellResult('ls: cannot access foo: No such file\n\n[exit: 2] [persistent shell: blah]')
  expect(r.exit).toBe(2)
  expect(r.output).toBe('ls: cannot access foo: No such file')
})

test('parseShellResult: warning present', () => {
  const r = parseShellResult('partial\n\n[exit: 0] [persistent shell: x] [warning: exit marker not found, output may be incomplete]')
  expect(r.exit).toBe(0)
  expect(r.warning).toBe('exit marker not found, output may be incomplete')
  expect(r.output).toBe('partial')
})

test('parseShellResult: error-only string', () => {
  const r = parseShellResult('[error: docker daemon not running]')
  expect(r.exit).toBeNull()
  expect(r.error).toBe('docker daemon not running')
  expect(r.output).toBe('')
})

test('parseShellResult: missing exit marker (no markers at all)', () => {
  const r = parseShellResult('just some plain output with no markers')
  expect(r.exit).toBeNull()
  expect(r.output).toBe('just some plain output with no markers')
})

test('parseShellResult: empty string', () => {
  const r = parseShellResult('')
  expect(r.exit).toBeNull()
  expect(r.output).toBe('')
})