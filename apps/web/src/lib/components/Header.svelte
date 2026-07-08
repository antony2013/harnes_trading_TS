<script lang="ts">
	import { marketFeed, type IndexQuote, type FeedStatus } from '$lib/stores/marketFeed';

	const STATUS_LABEL: Record<FeedStatus, string> = {
		connecting: 'connecting',
		live: 'live',
		polling: 'poll',
		offline: 'offline'
	};

	function fmt(n: number | null, digits = 2): string {
		return n == null ? '—' : n.toLocaleString('en-IN', {
			minimumFractionDigits: digits,
			maximumFractionDigits: digits
		});
	}

	function sign(n: number | null): string {
		if (n == null) return '';
		return n > 0 ? '+' : '';
	}

	function changeClass(n: number | null): string {
		if (n == null || n === 0) return 'flat';
		return n > 0 ? 'up' : 'down';
	}
</script>

<header class="hdr">
	<a class="brand" href="/">
		<span class="brand-mark">H</span>
		<span class="brand-name">Harnesh<span class="dim">Trading</span></span>
	</a>

	<nav class="ticks">
		{#each [$marketFeed.nifty, $marketFeed.sensex] as q (q.key)}
			<div class="tick" data-up={q.change != null && q.change > 0} data-down={q.change != null && q.change < 0}>
				<span class="tick-label">{q.label}</span>
				<span class="tick-price">{fmt(q.price)}</span>
				<span class="tick-change {changeClass(q.change)}">
					{sign(q.change)}{fmt(q.change)}
					{#if q.changePct != null}
						<span class="pct">({sign(q.changePct)}{fmt(q.changePct)}%)</span>
					{/if}
				</span>
			</div>
		{/each}
	</nav>

	<nav class="links">
		<a href="/chat" class="navlink">Chat</a>
		<a href="/settings" class="navlink">Settings</a>
	</nav>

	<div class="status" data-status={$marketFeed.status} title={`Feed: ${STATUS_LABEL[$marketFeed.status]}`}>
		<span class="dot"></span>
		<span class="status-text">{STATUS_LABEL[$marketFeed.status]}</span>
	</div>
</header>

<style>
	.hdr {
		display: flex;
		align-items: center;
		gap: 1.5rem;
		padding: 0.5rem 1rem;
		background: #0b1020;
		color: #e7ecf5;
		border-bottom: 1px solid #1e2740;
		font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
		position: sticky;
		top: 0;
		z-index: 50;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		text-decoration: none;
		color: inherit;
		flex: 0 0 auto;
	}
	.brand-mark {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: 7px;
		background: linear-gradient(135deg, #4f8cff, #7a5cff);
		font-weight: 700;
		font-size: 15px;
		color: #fff;
	}
	.brand-name {
		font-weight: 700;
		letter-spacing: 0.2px;
		white-space: nowrap;
	}
	.brand-name .dim {
		color: #8a97b5;
		font-weight: 500;
		margin-left: 0.25rem;
	}

	.ticks {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1 1 auto;
		justify-content: center;
		overflow-x: auto;
	}
	.tick {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		padding: 0.3rem 0.6rem;
		border-radius: 8px;
		background: #121a33;
		border: 1px solid #1e2740;
		white-space: nowrap;
	}
	.tick-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.6px;
		color: #8a97b5;
		text-transform: uppercase;
	}
	.tick-price {
		font-size: 15px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.tick-change {
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}
	.tick-change .pct {
		color: inherit;
		opacity: 0.75;
		margin-left: 0.15rem;
	}
	.tick-change.up,
	.tick[data-up='true'] .tick-price {
		color: #22c55e;
	}
	.tick-change.down,
	.tick[data-down='true'] .tick-price {
		color: #ef4444;
	}
	.tick-change.flat {
		color: #8a97b5;
	}

	.status {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex: 0 0 auto;
		font-size: 11px;
		color: #8a97b5;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #8a97b5;
	}
	.status[data-status='live'] .dot {
		background: #22c55e;
		box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.6);
		animation: pulse 2s infinite;
	}
	.status[data-status='polling'] .dot { background: #eab308; }
	.status[data-status='connecting'] .dot { background: #3b82f6; animation: pulse 1.2s infinite; }
	.status[data-status='offline'] .dot { background: #ef4444; }

	@keyframes pulse {
		0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5); }
		70% { box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
		100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
	}

	.links { display: flex; gap: 0.4rem; flex: 0 0 auto; }
	.navlink {
		font-size: 12px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase;
		color: #8a97b5; text-decoration: none; padding: 0.3rem 0.5rem; border-radius: 6px;
	}
	.navlink:hover { color: #e7ecf5; background: #121a33; }
	@media (max-width: 640px) {
		.brand-name .dim { display: none; }
		.status-text { display: none; }
		.hdr { gap: 0.75rem; padding: 0.4rem 0.6rem; }
		.links { gap: 0.25rem; }
		.navlink { padding: 0.25rem 0.35rem; }
	}
</style>