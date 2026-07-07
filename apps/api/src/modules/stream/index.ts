import { Elysia, t, sse } from 'elysia'
import protobuf from 'protobufjs'
import { fileURLToPath } from 'node:url'
import { UpstoxClient } from '../../config/upstox'

const wsApi = new UpstoxClient.WebsocketApi()

/** Promisify an SDK callback-style call. */
function call<T>(fn: (cb: (err: any, data: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) =>
    fn((err, data) => (err ? reject(err) : resolve(data))),
  )
}

// SDK responses are class instances; Elysia only serializes plain objects.
const toPlain = <T>(v: T): T => JSON.parse(JSON.stringify(v))

function upstoxError(err: any, label: string) {
  return {
    message: `Upstox ${label} failed`,
    error: err?.response?.body ?? err?.message ?? String(err),
  }
}

// ── Protobuf schema (decoded once at module load) ─────────────────────────────
// Vendored from upstox-js-sdk examples/websocket/market_data/v3/MarketDataFeedV3.proto
const protoPath = fileURLToPath(new URL('./MarketDataFeedV3.proto', import.meta.url))
const protoRoot = await protobuf.load(protoPath)
const FeedResponse = protoRoot.lookupType(
  'com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse',
)

// ── Upstream relay state (global subscription model) ─────────────────────────
// One shared WebSocket to Upstox. Subscriptions are GLOBAL: the REST
// /stream/subscriptions endpoint (and, optionally, a WS sub message) maintains
// a single set of instrument keys + mode. Every connected WS client receives
// all globally-subscribed feeds. The upstream is opened when there is something
// to subscribe to and torn down when there are neither subscriptions nor
// connected clients.
const globalInstruments = new Set<string>()
// A "sink" is anything we can push a decoded feed payload to. WS clients wrap
// ws.send; SSE clients push to an async queue drained by their generator.
type Sink = { send: (payload: any) => void }
const clients = new Map<object, Sink>()
let upstream: WebSocket | null = null
type UpstreamState = 'idle' | 'connecting' | 'open' | 'closed'
let upstreamState: UpstreamState = 'idle'
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let currentMode = 'full'

function authorizedUrl(): Promise<string> {
  // WebsocketAuthRedirectResponse.data.authorizedRedirectUri (nested under .data)
  return call<any>((cb) => wsApi.getMarketDataFeedAuthorizeV3(cb)).then(
    (data) => data?.data?.authorizedRedirectUri ?? '',
  )
}

function sendAggregateSub() {
  if (!upstream || upstreamState !== 'open') return
  upstream.send(
    JSON.stringify({
      guid: 'harnesh-relay',
      method: 'sub',
      data: { mode: currentMode, instrumentKeys: [...globalInstruments] },
    }),
  )
}

function scheduleReconnect() {
  if (reconnectTimer || (globalInstruments.size === 0 && clients.size === 0)) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    maybeConnectUpstream()
  }, 3000)
}

function maybeConnectUpstream() {
  // Only keep the upstream alive while there is at least one subscription or
  // a consumer. With nothing subscribed there is no feed to receive.
  if (globalInstruments.size === 0 && clients.size === 0) return
  if (upstreamState === 'connecting' || upstreamState === 'open') return
  upstreamState = 'connecting'
  authorizedUrl()
    .then((url) => {
      if (!url) {
        upstreamState = 'idle'
        scheduleReconnect()
        return
      }
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      ws.addEventListener('open', () => {
        upstream = ws
        upstreamState = 'open'
        sendAggregateSub()
      })
      ws.addEventListener('message', (e: MessageEvent) => handleUpstreamMessage(e.data))
      ws.addEventListener('close', () => {
        upstream = null
        upstreamState = 'closed'
        scheduleReconnect()
      })
      ws.addEventListener('error', () => {
        // onclose will follow; nothing to do here.
      })
    })
    .catch(() => {
      upstreamState = 'idle'
      scheduleReconnect()
    })
}

function maybeCloseUpstream() {
  if (globalInstruments.size > 0 || clients.size > 0) return
  upstream?.close()
  upstream = null
  upstreamState = 'idle'
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function handleUpstreamMessage(data: unknown) {
  if (!(data instanceof ArrayBuffer)) return
  let json: any
  try {
    json = JSON.parse(JSON.stringify(FeedResponse.decode(new Uint8Array(data))))
  } catch {
    return // ignore malformed frames
  }
  const feeds = json?.feeds ?? {}
  const marketInfo = json?.marketInfo
  const payload: any = { type: json.type, currentTs: json.currentTs }
  if (marketInfo !== undefined) payload.marketInfo = marketInfo // global market status → all clients
  if (Object.keys(feeds).length) payload.feeds = feeds // upstream only sends globally-subscribed keys
  if (payload.marketInfo === undefined && !payload.feeds) return
  for (const sink of clients.values()) sink.send(payload)
}

// ── SSE async queue ──────────────────────────────────────────────────────────
// Lets an async generator await the next payload pushed by handleUpstreamMessage.
function makeQueue() {
  const buf: any[] = []
  let wait: ((v: any) => void) | null = null
  let closed = false
  return {
    push(m: any) {
      if (closed) return
      if (wait) {
        wait(m)
        wait = null
      } else buf.push(m)
    },
    next(): Promise<any> {
      if (buf.length) return Promise.resolve(buf.shift())
      if (closed) return Promise.resolve(null)
      return new Promise((res) => {
        wait = res
      })
    },
    close() {
      closed = true
      if (wait) {
        wait(null)
        wait = null
      }
    },
  }
}

// ── Module ────────────────────────────────────────────────────────────────────
export const stream = new Elysia({ name: 'stream' })
  // ── GET /stream/market-data-feed/authorize  (v3, no Api-Version header)
  .get(
    '/stream/market-data-feed/authorize',
    async ({ status }) => {
      try {
        return toPlain(await call((cb) => wsApi.getMarketDataFeedAuthorizeV3(cb)))
      } catch (err: any) {
        return status(502, upstoxError(err, 'getMarketDataFeedAuthorizeV3'))
      }
    },
    {
      detail: {
        summary: 'Authorize market-data feed (v3)',
        description:
          'Returns the authorized wss redirect URI for Upstox market-data feed v3. Use this only if connecting directly to Upstox; the /stream/market-data WS relay below connects upstream for you.',
        tags: ['Stream — Authorize'],
      },
    },
  )
  // ── GET /stream/portfolio-stream-feed/authorize  (v2, Api-Version header)
  .get(
    '/stream/portfolio-stream-feed/authorize',
    async ({ headers, status }) => {
      try {
        return toPlain(
          await call((cb) => wsApi.getPortfolioStreamFeedAuthorize(headers['api-version'], cb)),
        )
      } catch (err: any) {
        return status(502, upstoxError(err, 'getPortfolioStreamFeedAuthorize'))
      }
    },
    {
      headers: t.Object({ 'api-version': t.String({ minLength: 1 }) }),
      detail: {
        summary: 'Authorize portfolio stream feed (v2)',
        description: 'Send `Api-Version` (e.g. 2.0) via the `api-version` header.',
        tags: ['Stream — Authorize'],
      },
    },
  )
  // ── POST /stream/subscriptions  (global sub/unsub over REST)
  .post(
    '/stream/subscriptions',
    ({ body }) => {
      if (body.method === 'sub') {
        for (const k of body.data.instrumentKeys) globalInstruments.add(k)
        if (body.data.mode) currentMode = body.data.mode
      } else {
        for (const k of body.data.instrumentKeys) globalInstruments.delete(k)
      }
      if (globalInstruments.size > 0) maybeConnectUpstream()
      sendAggregateSub()
      maybeCloseUpstream()
      return { subscribed: [...globalInstruments], mode: currentMode }
    },
    {
      body: t.Object({
        method: t.Union([t.Literal('sub'), t.Literal('unsub')]),
        data: t.Object({
          // mode: ltp | full | option_greeks | full_d30. Shared across all clients (last sub wins; default 'full').
          mode: t.Optional(t.String({ minLength: 1 })),
          instrumentKeys: t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
        }),
      }),
      detail: {
        summary: 'Subscribe / unsubscribe instruments (global)',
        description:
          'Adds (method=sub) or removes (method=unsub) instrument keys from the shared upstream subscription. Every connected WS client at /stream/market-data receives all globally-subscribed feeds. `mode` is shared (last sub wins; default "full"): ltp | full | option_greeks | full_d30.',
        tags: ['Stream'],
      },
    },
  )
  // ── GET /stream/subscriptions  (current global subscription state)
  .get(
    '/stream/subscriptions',
    () => ({ subscribed: [...globalInstruments], mode: currentMode, clients: clients.size }),
    { detail: { summary: 'Current global subscriptions', tags: ['Stream'] } },
  )
  // ── GET /stream/market-data-sse  (SSE relay — same feed, over HTTP/EventSource)
  .get(
    '/stream/market-data-sse',
    async function* ({ set }) {
      set.headers['Cache-Control'] = 'no-cache'
      set.headers['Connection'] = 'keep-alive'
      const q = makeQueue()
      const sink: Sink = { send: (p) => q.push(p) }
      clients.set(sink, sink)
      maybeConnectUpstream()
      try {
        // First yield with sse() so Elysia sets text/event-stream headers.
        yield sse({ event: 'open', data: { subscribed: [...globalInstruments], mode: currentMode } })
        while (true) {
          const payload = await q.next()
          if (payload === null) break
          yield sse({ event: payload.type ?? 'feed', data: payload })
        }
      } finally {
        clients.delete(sink)
        maybeCloseUpstream()
      }
    },
    {
      detail: {
        summary: 'Market-data SSE relay',
        description:
          'Server-Sent Events alternative to the WS relay. Subscribe via POST /stream/subscriptions, then open this with an EventSource. Emits an `open` event, then one event per upstream frame (event name = frame type, e.g. `market_info` | live feed type) with the decoded JSON payload as `data`. NOTE: hidden from Swagger — SSE is a stream and cannot be executed via "Try it out"; test with `curl -N` or EventSource.',
        tags: ['Stream'],
        hide: true,
      },
    },
  )
  // ── WS /stream/market-data  (relay: clients ↔ this server ↔ Upstox v3 feed)
  //   Clients are passive receivers — they get every globally-subscribed feed.
  //   A WS sub/unsub message also works and mutates the same global set.
  .ws('/stream/market-data', {
    open(ws) {
      clients.set(ws, { send: (p) => ws.send(typeof p === 'string' ? p : JSON.stringify(p)) })
      maybeConnectUpstream()
    },
    body: t.Object({
      guid: t.Optional(t.String()),
      method: t.Union([t.Literal('sub'), t.Literal('unsub')]),
      data: t.Object({
        mode: t.Optional(t.String({ minLength: 1 })),
        instrumentKeys: t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
      }),
    }),
    message(ws, body) {
      if (body.method === 'sub') {
        for (const k of body.data.instrumentKeys) globalInstruments.add(k)
        if (body.data.mode) currentMode = body.data.mode
      } else {
        for (const k of body.data.instrumentKeys) globalInstruments.delete(k)
      }
      if (globalInstruments.size > 0) maybeConnectUpstream()
      sendAggregateSub()
      maybeCloseUpstream()
    },
    close(ws) {
      clients.delete(ws)
      maybeCloseUpstream()
    },
    detail: {
      summary: 'Market-data WS relay (passive)',
      description:
        'Connect to receive every globally-subscribed feed as JSON: { type, currentTs, marketInfo?, feeds: { <instrumentKey>: {...} } }. Manage subscriptions via POST /stream/subscriptions (or send a sub/unsub message here — same global set). Mode is shared (last sub wins; default "full"): ltp | full | option_greeks | full_d30. NOTE: hidden from Swagger — WS cannot be executed via "Try it out"; test with `wscat` or a WS client.',
      tags: ['Stream'],
      hide: true,
    },
  })