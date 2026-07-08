<script lang="ts">
	import { messages, streaming, stop, clear, sendMessage } from '$lib/stores/agentChat';
	import { agentSettings } from '$lib/stores/agentSettings';
	import AgentMessage from './AgentMessage.svelte';
	import MessageInput from './MessageInput.svelte';

	let scroller: HTMLDivElement | null = null;
	let suggestion = $state('');

	$effect(() => {
		// re-run when messages or the last content length change -> snap to bottom
		const m = $messages;
		const lastLen = m.length ? m[m.length - 1].content.length : 0;
		void m; void lastLen;
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	});

	$effect(() => {
		if (suggestion) {
			sendMessage(suggestion);
			suggestion = '';
		}
	});

	const suggestions = ['What is the NIFTY 50 LTP?', 'Sync 1d candles for RELIANCE', 'Explain instrument keys'];
	const configured = $derived(!!$agentSettings && !!$agentSettings.model);
	const modelLabel = $derived($agentSettings ? `${$agentSettings.provider}:${$agentSettings.model}` : 'not configured');
</script>

<section class="chat">
	<div class="topbar">
		<span class="model" data-ok={configured}>● {modelLabel}</span>
		<div class="spacer"></div>
		{#if $streaming}<button class="mini" onclick={stop}>Stop</button>{/if}
		<button class="mini" disabled={$streaming || $messages.length === 0} onclick={clear}>Clear</button>
	</div>

	{#if !configured}
		<div class="banner">Agent not configured — <a href="/settings">set up a model</a> first.</div>
	{/if}

	<div class="scroller" bind:this={scroller}>
		{#if $messages.length === 0}
			<div class="empty">
				<p>Ask the trading agent something.</p>
				<div class="chips">
					{#each suggestions as s (s)}<button class="chip" onclick={() => (suggestion = s)}>{s}</button>{/each}
				</div>
			</div>
		{:else}
			{#each $messages as m (m.id)}<AgentMessage msg={m} />{/each}
		{/if}
	</div>

	<MessageInput />
</section>

<style>
	.chat { display: flex; flex-direction: column; height: calc(100vh - 49px); }
	.topbar { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.75rem; border-bottom: 1px solid #1e2740; }
	.model { font-size: 12px; color: #8a97b5; font-variant-numeric: tabular-nums; }
	.model[data-ok='true'] { color: #22c55e; }
	.spacer { flex: 1 1 auto; }
	.mini { background: #121a33; border: 1px solid #1e2740; color: #c7d0e6; border-radius: 6px; padding: 0.25rem 0.6rem; font-size: 12px; cursor: pointer; }
	.mini:disabled { opacity: 0.5; cursor: not-allowed; }
	.banner { background: rgba(234,179,8,0.12); color: #eab308; padding: 0.5rem 0.75rem; font-size: 13px; }
	.banner a { color: #eab308; }
	.scroller { flex: 1 1 auto; overflow-y: auto; padding: 0 0.75rem; }
	.empty { text-align: center; color: #6b7896; padding: 3rem 1rem; }
	.chips { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: center; margin-top: 1rem; }
	.chip { background: #121a33; border: 1px solid #1e2740; color: #c7d0e6; border-radius: 999px; padding: 0.35rem 0.7rem; font-size: 12px; cursor: pointer; }
</style>