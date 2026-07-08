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
		<span class="brand-name">Harnesh<span class="dot">·</span><span class="dim">Trading</span></span>
	</a>

	<nav class="ticks" aria-label="Live index quotes">
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
		gap: 1.25rem;
		padding: 0.55rem 1rem;
		background: var(--ink-950);
		color: var(--paper);
		border-bottom: 1px solid var(--ink-line);
		position: sticky;
		top: 0;
		z-index: 50;
	}

	.brand {
		display: flex;
		align-items: baseline;
		text-decoration: none;
		color: inherit;
		flex: 0 0 auto;
	}
	.brand-name {
		font-family: var(--font-display);
		font-size: var(--t-lg);
		font-style: italic;
		letter-spacing: 0.2px;
		white-space: nowrap;
		line-height: 1;
	}
	.brand-name .dot {
		color: var(--saffron);
		margin: 0 0.05rem;
		font-style: normal;
	}
	.brand-name .dim {
		color: var(--paper-dim);
	}

	.ticks {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1 1 auto;
		justify-content: center;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.ticks::-webkit-scrollbar { display: none; }
	.tick {
		display: flex;
		align-items: baseline;
		gap: 0.45rem;
		padding: 0.3rem 0.6rem;
		border-radius: var(--radius-sm);
		background: var(--ink-900);
		border: 1px solid var(--ink-line);
		white-space: nowrap;
		font-family: var(--font-mono);
	}
	.tick-label {
		font-size: var(--t-2xs);
		font-weight: 600;
		letter-spacing: 0.8px;
		color: var(--saffron);
		text-transform: uppercase;
	}
	.tick-price {
		font-size: var(--t-md);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--paper);
	}
	.tick-change {
		font-size: var(--t-xs);
		font-variant-numeric: tabular-nums;
	}
	.tick-change .pct {
		color: inherit;
		opacity: 0.7;
		margin-left: 0.15rem;
	}
	.tick-change.up,
	.tick[data-up='true'] .tick-price {
		color: var(--up);
	}
	.tick-change.down,
	.tick[data-down='true'] .tick-price {
		color: var(--down);
	}
	.tick-change.flat {
		color: var(--paper-mute);
	}

	.status {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex: 0 0 auto;
		font-family: var(--font-mono);
		font-size: var(--t-2xs);
		color: var(--paper-dim);
		text-transform: uppercase;
		letter-spacing: 0.6px;
	}
	.status .dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--paper-mute);
	}
	.status[data-status='live'] .dot {
		background: var(--up);
		box-shadow: 0 0 0 0 rgba(91, 201, 122, 0.6);
		animation: pulse 2s infinite;
	}
	.status[data-status='polling'] .dot { background: var(--saffron); }
	.status[data-status='connecting'] .dot { background: var(--saffron); animation: pulse 1.2s infinite; }
	.status[data-status='offline'] .dot { background: var(--down); }

	@keyframes pulse {
		0% { box-shadow: 0 0 0 0 rgba(91, 201, 122, 0.5); }
		70% { box-shadow: 0 0 0 5px rgba(91, 201, 122, 0); }
		100% { box-shadow: 0 0 0 0 rgba(91, 201, 122, 0); }
	}

	.links {
		display: flex;
		gap: 0.35rem;
		flex: 0 0 auto;
		font-family: var(--font-mono);
	}
	.navlink {
		font-size: var(--t-2xs);
		font-weight: 500;
		letter-spacing: 0.6px;
		text-transform: uppercase;
		color: var(--paper-dim);
		text-decoration: none;
		padding: 0.3rem 0.55rem;
		border-radius: var(--radius-sm);
		border: 1px solid transparent;
	}
	.navlink:hover {
		color: var(--paper);
		background: var(--ink-800);
		border-color: var(--ink-line);
	}

	@media (max-width: 720px) {
		.brand-name .dim { display: none; }
		.brand-name .dot { display: none; }
		.status-text { display: none; }
		.hdr { gap: 0.6rem; padding: 0.45rem 0.6rem; }
		.links { gap: 0.2rem; }
		.navlink { padding: 0.25rem 0.4rem; }
	}
</style>