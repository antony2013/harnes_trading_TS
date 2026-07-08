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
	:global(html, body) {
		margin: 0;
		padding: 0;
		background: #0b1020;
		color: #e7ecf5;
		font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
	}
	.app-main {
		min-height: calc(100vh - 49px);
	}
</style>