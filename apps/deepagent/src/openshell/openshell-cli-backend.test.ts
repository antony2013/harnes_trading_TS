// apps/deepagent/src/openshell/openshell-cli-backend.test.ts
import { test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenShellCliBackend } from './openshell-cli-backend'

// A fake "openshell" binary that records args + responds to subcommands.
function fakeOpenshellBin(dir: string): string {
  const path = join(dir, 'openshell')
  writeFileSync(path, `#!/usr/bin/env bash
echo "FAKE openshell $@" >> "${join(dir, 'calls.log')}"
case "$1" in
  sandbox)
    case "$2" in
      create) echo "ready" ;;            # last condition line for create
      exec) shift 2; while [ "$1" != "--" ]; do shift; done; shift; "$@" ;;  # strip --name/--cwd through -- , run the command after
      delete) ;;
      list) echo "NAME PHASE" ;;
    esac ;;
esac
`)
  return path
}

let dir: string
let bin: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'osh-'))
  bin = fakeOpenshellBin(dir)
})

test('OpenShellCliBackend: getOrCreateWorkspace runs `sandbox create --name <id> --from <image>`', async () => {
  const b = new OpenShellCliBackend({ binary: ['bash', bin], image: 'img:1' })
  const h = await b.getOrCreateWorkspace('w1')
  expect(h.id).toBe('w1')
  const calls = require('node:fs').readFileSync(join(dir, 'calls.log'), 'utf8')
  expect(calls).toContain('sandbox create')
  expect(calls).toContain('--name w1')
  expect(calls).toContain('--from img:1')
})

test('OpenShellCliBackend: exec wraps command with exit marker + parses', async () => {
  const b = new OpenShellCliBackend({ binary: ['bash', bin], image: 'img:1' })
  await b.getOrCreateWorkspace('w1')
  const r = await b.exec('w1', "printf 'hello'")
  expect(r.output).toBe('hello')
  expect(r.exitCode).toBe(0)
})

test('OpenShellCliBackend: exec exit code propagates', async () => {
  const b = new OpenShellCliBackend({ binary: ['bash', bin], image: 'img:1' })
  await b.getOrCreateWorkspace('w1')
  const r = await b.exec('w1', 'sh -c "exit 7"')
  expect(r.exitCode).toBe(7)
})

test('OpenShellCliBackend: destroy runs `sandbox delete --name <id>`', async () => {
  const b = new OpenShellCliBackend({ binary: ['bash', bin], image: 'img:1' })
  await b.getOrCreateWorkspace('w1')
  await b.destroyWorkspace('w1')
  const calls = require('node:fs').readFileSync(join(dir, 'calls.log'), 'utf8')
  expect(calls).toContain('sandbox delete')
  expect(calls).toContain('--name w1')
})