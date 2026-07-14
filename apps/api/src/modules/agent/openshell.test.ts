import { test, expect, beforeEach } from 'bun:test'
import { readOpenShellSettings, writeOpenShellSettings, DEFAULT_OPENSHELL_SETTINGS, DEFAULT_OPENSHELL_IMAGE } from './openshell'

beforeEach(() => {
  process.env.AGENT_OPENSHELL_SETTINGS_PATH = `/tmp/openshell-settings-${Math.random().toString(36).slice(2)}.json`
})

test('readOpenShellSettings: returns null when no file', () => {
  expect(readOpenShellSettings()).toBeNull()
})

test('DEFAULT_OPENSHELL_SETTINGS: disabled, sane defaults', () => {
  expect(DEFAULT_OPENSHELL_SETTINGS).toEqual({
    enabled: false,
    image: DEFAULT_OPENSHELL_IMAGE,
    idleTimeoutMs: 1_800_000,
    bridgePort: 7777,
    executionTimeoutMs: 120_000,
  })
  expect(DEFAULT_OPENSHELL_IMAGE).toBe('harnesh/agent-sandbox:ubuntu-lts')
})

test('writeOpenShellSettings + readOpenShellSettings: round-trip', () => {
  writeOpenShellSettings({
    enabled: true,
    image: 'harnesh/agent-sandbox:ubuntu-lts',
    idleTimeoutMs: 900_000,
    bridgePort: 8000,
    executionTimeoutMs: 60_000,
  })
  expect(readOpenShellSettings()).toEqual({
    enabled: true,
    image: 'harnesh/agent-sandbox:ubuntu-lts',
    idleTimeoutMs: 900_000,
    bridgePort: 8000,
    executionTimeoutMs: 60_000,
  })
})

test('readOpenShellSettings: returns null on malformed JSON', () => {
  const path = process.env.AGENT_OPENSHELL_SETTINGS_PATH!
  const { writeFileSync } = require('node:fs')
  writeFileSync(path, '{ not valid json')
  expect(readOpenShellSettings()).toBeNull()
})

test('readOpenShellSettings: returns null when required fields missing', () => {
  const path = process.env.AGENT_OPENSHELL_SETTINGS_PATH!
  const { writeFileSync } = require('node:fs')
  writeFileSync(path, JSON.stringify({ enabled: true, image: 'x' })) // missing timeouts/port
  expect(readOpenShellSettings()).toBeNull()
})

test('writeOpenShellSettings: atomic (no .tmp left behind)', () => {
  writeOpenShellSettings(DEFAULT_OPENSHELL_SETTINGS)
  const path = process.env.AGENT_OPENSHELL_SETTINGS_PATH!
  const { existsSync } = require('node:fs')
  expect(existsSync(path)).toBe(true)
  expect(existsSync(path + '.tmp')).toBe(false)
})