<script lang="ts">
	import type { ChatMessage } from '$lib/stores/agentChat';
	import ToolStep from './ToolStep.svelte';
	let { msg }: { msg: ChatMessage } = $props();

	function fmtTs(ts: number): string {
		const d = new Date(ts);
		return d.toLocaleTimeString('en-GB', { hour12: false });
	}
</script>

<article class="msg" data-role={msg.role}>
	<div class="rail">
		<span class="ts">{fmtTs(msg.ts)}</span>
		<span class="who">{msg.role === 'user' ? 'you' : 'agent'}</span>
	</div>
	<div class="body">
		{#if msg.tools && msg.tools.length}
			<div class="tools">{#each msg.tools as t, i (i)}<ToolStep step={t} />{/each}</div>
		{/if}
		{#if msg.content}
			<div class="text">{msg.content}</div>
		{:else if msg.role === 'assistant' && (!msg.tools || msg.tools.length === 0)}
			<div class="text muted"><span class="caret">▋</span> thinking</div>
		{/if}
	</div>
</article>

<style>
	.msg {
		display: flex;
		gap: 0.85rem;
		padding: 0.7rem 0;
		border-top: 1px solid var(--ink-line-soft);
	}
	.msg:first-child {
		border-top: none;
	}
	.rail {
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.15rem;
		padding-top: 0.1rem;
		min-width: 5.2ch;
	}
	.ts {
		font-family: var(--font-mono);
		font-size: var(--t-2xs);
		color: var(--paper-mute);
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.2px;
	}
	.who {
		font-family: var(--font-display);
		font-style: italic;
		font-size: var(--t-md);
		line-height: 1;
	}
	.msg[data-role='user'] .who {
		color: var(--paper-dim);
	}
	.msg[data-role='assistant'] .who {
		color: var(--saffron);
	}
	.body {
		flex: 1 1 auto;
		min-width: 0;
		padding-top: 0.05rem;
	}
	.text {
		white-space: pre-wrap;
		word-break: break-word;
		line-height: 1.6;
		font-size: var(--t-base);
		color: var(--paper);
	}
	.text.muted {
		color: var(--paper-mute);
		font-style: italic;
		display: inline-flex;
		align-items: baseline;
		gap: 0.3rem;
	}
	.caret {
		color: var(--saffron);
		animation: blink 1.1s steps(2, start) infinite;
	}
	@keyframes blink {
		50% { opacity: 0; }
	}
	.tools {
		margin-bottom: 0.4rem;
	}

	@media (max-width: 640px) {
		.rail {
			min-width: 4.6ch;
		}
		.who {
			font-size: var(--t-sm);
		}
	}
</style>