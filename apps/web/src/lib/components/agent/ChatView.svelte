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

	const suggestions = [
		'What is the NIFTY 50 LTP?',
		'Sync 1d candles for RELIANCE',
		'Explain instrument keys'
	];
	const configured = $derived(!!$agentSettings && !!$agentSettings.model);
	const modelLabel = $derived(
		$agentSettings && $agentSettings.model ? `${$agentSettings.provider}:${$agentSettings.model}` : 'not configured'
	);
</script>

<section class="chat">
	<div class="topbar">
		<span class="model" data-ok={configured}>
			<span class="pip"></span>{modelLabel}
		</span>
		<div class="spacer"></div>
		{#if $streaming}<button class="mini" onclick={stop}>Stop</button>{/if}
		<button class="mini" disabled={$streaming || $messages.length === 0} onclick={clear}>Clear</button>
	</div>

	{#if !configured}
		<div class="banner">
			The agent isn’t configured — <a href="/settings">set up a model</a> first.
		</div>
	{/if}

	<div class="scroller" bind:this={scroller}>
		<div class="ledger">
			{#if $messages.length === 0}
				<div class="empty">
					<h2 class="empty-title">The desk is open.</h2>
					<p class="empty-sub">Ask the trading agent something — quotes, candle syncs, instrument lookups.</p>
					<div class="chips">
						{#each suggestions as s (s)}
							<button class="chip" onclick={() => (suggestion = s)}>
								<span class="chip-mark">►</span>{s}
							</button>
						{/each}
					</div>
				</div>
			{:else}
				{#each $messages as m (m.id)}<AgentMessage msg={m} />{/each}
			{/if}
		</div>
	</div>

	<MessageInput />
</section>

<style>
	.chat {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.topbar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.45rem 1rem;
		border-bottom: 1px solid var(--ink-line);
		font-family: var(--font-mono);
	}
	.model {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		font-size: var(--t-xs);
		color: var(--paper-dim);
		font-variant-numeric: tabular-nums;
	}
	.model .pip {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--paper-mute);
	}
	.model[data-ok='true'] {
		color: var(--paper);
	}
	.model[data-ok='true'] .pip {
		background: var(--up);
		box-shadow: 0 0 0 0 rgba(91, 201, 122, 0.55);
		animation: live-pip 2s infinite;
	}
	@keyframes live-pip {
		0% { box-shadow: 0 0 0 0 rgba(91, 201, 122, 0.5); }
		70% { box-shadow: 0 0 0 4px rgba(91, 201, 122, 0); }
		100% { box-shadow: 0 0 0 0 rgba(91, 201, 122, 0); }
	}
	.spacer {
		flex: 1 1 auto;
	}
	.mini {
		background: var(--ink-800);
		border: 1px solid var(--ink-line);
		color: var(--paper-dim);
		border-radius: var(--radius-sm);
		padding: 0.25rem 0.6rem;
		font-family: inherit;
		font-size: var(--t-xs);
		cursor: pointer;
		letter-spacing: 0.4px;
	}
	.mini:hover:not(:disabled) {
		color: var(--paper);
		border-color: var(--saffron-line);
	}
	.mini:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.banner {
		background: var(--saffron-soft);
		color: var(--saffron);
		padding: 0.5rem 1rem;
		font-size: var(--t-sm);
		border-bottom: 1px solid var(--saffron-line);
	}
	.banner a {
		color: var(--saffron);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.scroller {
		flex: 1 1 auto;
		overflow-y: auto;
		min-height: 0;
	}
	.ledger {
		max-width: 820px;
		margin: 0 auto;
		padding: 0.5rem 1rem 2rem;
	}

	.empty {
		text-align: center;
		padding: 4rem 1rem 2rem;
	}
	.empty-title {
		font-family: var(--font-display);
		font-style: italic;
		font-weight: 400;
		font-size: var(--t-3xl);
		line-height: 1.05;
		margin: 0 0 0.6rem;
		color: var(--paper);
	}
	.empty-sub {
		font-size: var(--t-sm);
		color: var(--paper-dim);
		margin: 0 0 1.75rem;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		justify-content: center;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		background: var(--ink-900);
		border: 1px solid var(--ink-line);
		color: var(--paper);
		border-radius: var(--radius-sm);
		padding: 0.4rem 0.7rem;
		font-size: var(--t-xs);
		font-family: var(--font-mono);
		cursor: pointer;
	}
	.chip:hover {
		border-color: var(--saffron-line);
		background: var(--ink-800);
	}
	.chip-mark {
		color: var(--saffron);
		font-size: var(--t-2xs);
	}

	@media (max-width: 640px) {
		.ledger {
			padding: 0.5rem 0.6rem 2rem;
		}
		.empty-title {
			font-size: var(--t-2xl);
		}
	}
</style>