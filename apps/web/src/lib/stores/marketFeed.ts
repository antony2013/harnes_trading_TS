import { writable, get } from 'svelte/store';

// Upstox v3 instrument keys for the two headline indices.
// Sensex key is uppercase SENSEX (verified via /instruments/search); `Sensex` returns no data.
export const NIFTY_KEY = 'NSE_INDEX|Nifty 50';
export const SENSEX_KEY = 'BSE_INDEX|SENSEX';

export type FeedStatus = 'connecting' | 'live' | 'polling' | 'offline';

export interface IndexQuote {
	key: string;
	label: string;
	price: number | null;
	change: number | null; // absolute change vs previous close
	changePct: number | null; // percent change vs previous close
	ts: number | null; // last update epoch (ms)
}

export interface MarketFeedState {
	status: FeedStatus;
	nifty: IndexQuote;
	sensex: IndexQuote;
}

const POLL_INTERVAL_MS = 3000;

function emptyQuote(key: string, label: string): IndexQuote {
	return { key, label, price: null, change: null, changePct: null, ts: null };
}

function round2(n: number): number {
	return Math.round((n + Number.EPSILON) * 100) / 100;
}

export const marketFeed = writable<MarketFeedState>({
	status: 'connecting',
	nifty: emptyQuote(NIFTY_KEY, 'NIFTY 50'),
	sensex: emptyQuote(SENSEX_KEY, 'SENSEX')
});

// ── Internal handles ──────────────────────────────────────────────────────────
let es: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

function withQuote(
	state: MarketFeedState,
	key: string,
	price: number,
	prevClose: number | null,
	ts: number
): MarketFeedState {
	const change = prevClose != null ? price - prevClose : null;
	const changePct = prevClose != null && prevClose !== 0 ? (change! / prevClose) * 100 : null;
	const patch: Partial<IndexQuote> = {
		price: round2(price),
		change: change != null ? round2(change) : null,
		changePct: changePct != null ? round2(changePct) : null,
		ts
	};
	const apply = (q: IndexQuote): IndexQuote => (q.key === key ? { ...q, ...patch } : q);
	return { ...state, nifty: apply(state.nifty), sensex: apply(state.sensex) };
}

/** Parse an SSE/WS decoded feed frame (`feeds` keyed by instrument key). */
function applyFeeds(feeds: Record<string, any> | undefined, ts: number) {
	if (!feeds) return;
	marketFeed.update((state) => {
		let next = state;
		for (const quote of [state.nifty, state.sensex]) {
			const f = feeds[quote.key];
			if (!f) continue;
			// ltp mode → feed.ltpc = { ltp, ltt, ltq, cp } (cp = previous close)
			const ltpc = f.ltpc;
			if (ltpc && typeof ltpc.ltp === 'number') {
				next = withQuote(next, quote.key, ltpc.ltp, typeof ltpc.cp === 'number' ? ltpc.cp : null, ts);
			}
		}
		return next;
	});
}

/** Parse a v3 LTP REST response. `data` is keyed by a colon-form key, so match
 *  entries by their `instrumentToken` (pipe-form, = our quote.key). Each entry
 *  has `lastPrice` + `cp` (previous close). */
function applyLtp(res: any) {
	const data = res?.data ?? res ?? {};
	const entries: any[] = Array.isArray(data) ? data : Object.values(data);
	const ts = Date.now();
	marketFeed.update((state) => {
		let next = state;
		for (const quote of [state.nifty, state.sensex]) {
			const q = entries.find((e) => e?.instrumentToken === quote.key) ?? data[quote.key];
			if (!q) continue;
			const price = typeof q.lastPrice === 'number' ? q.lastPrice : null;
			const prevClose = typeof q.cp === 'number' ? q.cp : null;
			if (price != null) next = withQuote(next, quote.key, price, prevClose, ts);
		}
		return next;
	});
}

async function subscribe(): Promise<boolean> {
	try {
		const res = await fetch('/stream/subscriptions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				method: 'sub',
				data: { mode: 'ltp', instrumentKeys: [NIFTY_KEY, SENSEX_KEY] }
			})
		});
		return res.ok;
	} catch {
		return false;
	}
}

function stopPolling() {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

async function pollOnce() {
	try {
		const res = await fetch(
			`/market-quote/v3/ltp?instrumentKey=${encodeURIComponent(NIFTY_KEY)},${encodeURIComponent(SENSEX_KEY)}`
		);
		if (!res.ok) throw new Error(`v3/ltp ${res.status}`);
		applyLtp(await res.json());
		marketFeed.update((s) => ({ ...s, status: 'polling' }));
	} catch {
		marketFeed.update((s) => ({ ...s, status: 'offline' }));
	}
}

function startPolling() {
	stopPolling();
	pollOnce();
	pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

function stopSSE() {
	if (es) {
		es.close();
		es = null;
	}
}

function startSSE() {
	stopSSE();
	es = new EventSource('/stream/market-data-sse');

	// 'open' just means the relay accepted us — not that data is flowing, so we
	// stay 'connecting' until the first feed frame arrives (handlers below).
	// Relay yields one event per upstream frame; event name = frame type.
	for (const ev of ['initial_feed', 'live_feed', 'feed']) {
		es.addEventListener(ev, (e: MessageEvent) => {
			try {
				const payload = JSON.parse(e.data);
				applyFeeds(payload.feeds, payload.currentTs ?? Date.now());
				marketFeed.update((s) => ({ ...s, status: 'live' }));
			} catch {
				/* ignore malformed frame */
			}
		});
	}

	// On persistent failure, close the stream and fall back to REST polling.
	es.addEventListener('error', () => {
		stopSSE();
		marketFeed.update((s) => ({ ...s, status: s.nifty.price != null || s.sensex.price != null ? 'polling' : 'connecting' }));
		startPolling();
	});
}

/** Start the live feed: SSE first, REST polling as fallback. Browser-only. */
export async function startMarketFeed() {
	if (started || typeof window === 'undefined') return;
	started = true;
	marketFeed.update((s) => ({ ...s, status: 'connecting' }));

	const subscribed = await subscribe();
	if (subscribed) {
		startSSE();
		// Safety net: if SSE never delivers within 6s, close the idle stream and
		// fall back to REST polling. If the relay later recovers, a reload retries SSE.
		setTimeout(() => {
			const s = get(marketFeed);
			const live =
				s.status === 'live' && (s.nifty.price != null || s.sensex.price != null);
			if (!live) {
				stopSSE();
				startPolling();
			}
		}, 6000);
	} else {
		startPolling();
	}
}

export function stopMarketFeed() {
	stopSSE();
	stopPolling();
	started = false;
}