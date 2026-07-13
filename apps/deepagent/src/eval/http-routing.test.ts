// apps/deepagent/src/eval/http-routing.test.ts
// Regression guard: the REAL search_instruments tool must route to whatever
// API_BASE_URL points at AT CALL TIME, not the value captured when the tools
// module was first imported. If http.ts ever reverts to caching the base URL
// in a module-load const, this test fails — the tool would hit localhost:3000
// (nothing listening) and return an "API not reachable" error string instead
// of the canned stub data.
import { test, expect } from 'bun:test'
import { startStubServer } from './stub-server'
import { searchInstruments } from '../tools/named'

test('real search_instruments routes to a stub server set via API_BASE_URL after import', async () => {
  const prevApi = process.env.API_BASE_URL
  const stub = await startStubServer([
    {
      method: 'GET',
      path: '/instruments/search',
      body: { data: [{ instrument_key: 'NSE_EQ|INE002A01018', name: 'TCS' }] },
    },
  ])
  try {
    // Set the env var AFTER importing the tool — only call-time read honors this.
    process.env.API_BASE_URL = stub.url
    const out = await searchInstruments.invoke({ q: 'TCS' })
    expect(typeof out).toBe('string')
    expect(out).toContain('NSE_EQ|INE002A01018')
    expect(out).toContain('TCS')
  } finally {
    await stub.stop()
    if (prevApi === undefined) delete process.env.API_BASE_URL
    else process.env.API_BASE_URL = prevApi
  }
})