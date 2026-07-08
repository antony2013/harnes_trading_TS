<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import Header from '$lib/components/Header.svelte';
	import { startMarketFeed, stopMarketFeed } from '$lib/stores/marketFeed';

	let { children } = $props();

	onMount(() => {
		startMarketFeed();
	});
	onDestroy(() => {
		stopMarketFeed();
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<Header />

<main class="app-main">
	{@render children()}
</main>

<style>
	:global(:root) {
		/* ── Palette: warm graphite + burnt saffron ─────────────────────── */
		--ink-950: #14110f; /* base — warm graphite (after-hours desk) */
		--ink-900: #1c1815; /* panel */
		--ink-800: #262019; /* raised card */
		--ink-700: #322a20; /* hover surface */
		--ink-line: #332b22; /* warm hairline */
		--ink-line-soft: #2a231b;

		--paper: #ede6d8; /* ledger-bone text */
		--paper-dim: #b8ae9a; /* secondary text */
		--paper-mute: #847b6a; /* tertiary / disabled text */

		--saffron: #e8821e; /* the one accent — agent voice / send / active */
		--saffron-soft: rgba(232, 130, 30, 0.14);
		--saffron-line: rgba(232, 130, 30, 0.4);

		--up: #5bc97a; /* market up — signal only */
		--down: #f8546a; /* market down — signal only */

		/* ── Type ──────────────────────────────────────────────────────── */
		--font-display: 'Instrument Serif', ui-serif, Georgia, 'Times New Roman', serif;
		--font-body: 'General Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
		--font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;

		/* type scale */
		--t-2xs: 11px;
		--t-xs: 12px;
		--t-sm: 13px;
		--t-base: 14px;
		--t-md: 15px;
		--t-lg: 18px;
		--t-xl: 22px;
		--t-2xl: 30px;
		--t-3xl: 40px;

		--radius: 8px;
		--radius-sm: 5px;
	}

	:global(html, body) {
		margin: 0;
		padding: 0;
		height: 100%;
		background: var(--ink-950);
		color: var(--paper);
		font-family: var(--font-body);
		font-size: var(--t-base);
		line-height: 1.5;
		-webkit-font-smoothing: antialiased;
		text-rendering: optimizeLegibility;
	}

	/* App shell: fixed header + flexing main. The sveltekit body wrapper is
		 display:contents, so Header + main become direct children of body. */
	:global(body) {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
	}

	:global(::selection) {
		background: var(--saffron-soft);
		color: var(--paper);
	}

	:global(*:focus-visible) {
		outline: 2px solid var(--saffron);
		outline-offset: 2px;
		border-radius: 2px;
	}

	@media (prefers-reduced-motion: reduce) {
		:global(*),
		:global(*::before),
		:global(*::after) {
			animation-duration: 0.001ms !important;
			animation-iteration-count: 1 !important;
			transition-duration: 0.001ms !important;
		}
	}

	.app-main {
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
	}
</style>