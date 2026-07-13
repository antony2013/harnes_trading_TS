// apps/deepagent/src/eval/stub-server.test.ts
import { test, expect } from 'bun:test'
import { startStubServer } from './stub-server'

test('matches method+path and returns canned body', async () => {
  const s = await startStubServer([
    { method: 'GET', path: '/instruments/search', body: { data: [{ instrument_key: 'NSE_EQ|INE002A01018', name: 'TCS' }] } },
  ])
  try {
    const res = await fetch(`${s.url}/instruments/search?q=tcs`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [{ instrument_key: 'NSE_EQ|INE002A01018', name: 'TCS' }] })
  } finally {
    await s.stop()
  }
})

test('returns 404 for unmatched routes', async () => {
  const s = await startStubServer([])
  try {
    const res = await fetch(`${s.url}/nope`)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toContain('no stub')
  } finally {
    await s.stop()
  }
})

test('query match selects between same-path routes', async () => {
  const s = await startStubServer([
    { method: 'GET', path: '/x', query: { a: '1' }, body: { hit: 'a1' } },
    { method: 'GET', path: '/x', query: { a: '2' }, body: { hit: 'a2' } },
  ])
  try {
    expect(await (await fetch(`${s.url}/x?a=1`)).json()).toEqual({ hit: 'a1' })
    expect(await (await fetch(`${s.url}/x?a=2`)).json()).toEqual({ hit: 'a2' })
    expect((await fetch(`${s.url}/x?a=3`)).status).toBe(404)
  } finally {
    await s.stop()
  }
})

test('decodes encoded pathnames (e.g. instrument keys with pipes)', async () => {
  const s = await startStubServer([
    { method: 'GET', path: '/backtest/data/candles/NSE_FO|54452|24-04-2025/day', body: [{ ts: 1 }] },
  ])
  try {
    const res = await fetch(`${s.url}/backtest/data/candles/NSE_FO%7C54452%7C24-04-2025/day`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ ts: 1 }])
  } finally {
    await s.stop()
  }
})

test('honours custom status', async () => {
  const s = await startStubServer([{ method: 'GET', path: '/boom', status: 422, body: { message: 'bad' } }])
  try {
    const res = await fetch(`${s.url}/boom`)
    expect(res.status).toBe(422)
  } finally {
    await s.stop()
  }
})