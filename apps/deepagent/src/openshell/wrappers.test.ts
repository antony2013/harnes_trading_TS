// apps/deepagent/src/openshell/wrappers.test.ts
import { test, expect } from 'bun:test'
import { generateWrappers } from './wrappers'

test('generateWrappers: one bash script per allowed tool, referencing env + bridge', () => {
  const w = generateWrappers(['get_ltp', 'historical_candles'], { bridgeHostEnv: 'OPENSHELL_BRIDGE_HOST', bridgePortEnv: 'OPENSHELL_BRIDGE_PORT', tokenEnv: 'OPENSHELL_BRIDGE_TOKEN', port: 7777, timeoutMs: 30 })
  expect(Object.keys(w).sort()).toEqual(['get_ltp', 'historical_candles'])
  const s = w['get_ltp']
  expect(s).toContain('#!/usr/bin/env bash')
  expect(s).toContain('$OPENSHELL_BRIDGE_TOKEN')
  expect(s).toContain('http://$OPENSHELL_BRIDGE_HOST:$OPENSHELL_BRIDGE_PORT/get_ltp')
  expect(s).toContain('--max-time 30')
  expect(s).toContain('-H "Authorization: Bearer $OPENSHELL_BRIDGE_TOKEN"')
})

test('generateWrappers: passes JSON args from named flags via a simple convention', () => {
  const w = generateWrappers(['get_ltp'], { bridgeHostEnv: 'OPENSHELL_BRIDGE_HOST', bridgePortEnv: 'OPENSHELL_BRIDGE_PORT', tokenEnv: 'OPENSHELL_BRIDGE_TOKEN', port: 7777, timeoutMs: 30 })
  // The wrapper accepts --<arg> value pairs and builds the JSON body.
  expect(w['get_ltp']).toContain('--instrument')
})