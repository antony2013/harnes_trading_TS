<script lang="ts">
	import type { ChatMessage } from '$lib/stores/agentChat';
	import ToolStep from './ToolStep.svelte';
	import ShellStep from './ShellStep.svelte';
	import { marked } from 'marked';

	let { msg }: { msg: ChatMessage } = $props();

	function fmtTs(ts: number): string {
		const d = new Date(ts);
		return d.toLocaleTimeString('en-GB', { hour12: false });
	}

	const htmlContent = $derived(msg.content ? (marked.parse(msg.content) as string) : '');
</script>

<article class="msg" data-role={msg.role}>
	<div class="rail">
		<span class="ts">{fmtTs(msg.ts)}</span>
		<span class="who">{msg.role === 'user' ? 'you' : 'agent'}</span>
	</div>
	<div class="body">
		{#if msg.tools && msg.tools.length}
			<div class="tools">{#each msg.tools as t, i (i)}{#if t.name === 'shell'}<ShellStep step={t} />{:else}<ToolStep step={t} />{/if}{/each}</div>
		{/if}
		{#if msg.content}
			<div class="text">{@html htmlContent}</div>
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
	/* User input: right-aligned highlighted bubble. Agent output stays left. */
	.msg[data-role='user'] .body {
		display: flex;
		justify-content: flex-end;
	}
	.msg[data-role='user'] .text {
		background: var(--ink-800);
		border: 1px solid var(--saffron-line);
		border-radius: var(--radius-sm);
		padding: 0.5rem 0.85rem;
		max-width: min(75%, 52ch);
		margin-left: auto;
	}
	.body {
		flex: 1 1 auto;
		min-width: 0;
		padding-top: 0.05rem;
	}
	.text {
		word-break: break-word;
		line-height: 1.6;
		font-size: var(--t-base);
		color: var(--paper);
	}
	.text :global(table) {
		width: 100%;
		border-collapse: collapse;
		margin: 0.8rem 0;
		font-size: var(--t-sm);
	}
	.text :global(th), .text :global(td) {
		padding: 0.4rem 0.6rem;
		text-align: left;
		border-bottom: 1px solid var(--ink-line);
	}
	.text :global(th) {
		font-weight: 600;
		color: var(--paper-dim);
		background: var(--ink-900);
	}
	.text :global(tr:hover) {
		background: rgba(255, 255, 255, 0.03);
	}
	.text :global(p) {
		margin: 0.4rem 0 0.8rem 0;
	}
	.text :global(p:last-child) {
		margin-bottom: 0;
	}
	.text :global(ul), .text :global(ol) {
		padding-left: 1.25rem;
		margin: 0.5rem 0;
	}
	.text :global(li) {
		margin-bottom: 0.25rem;
	}
	.text :global(pre) {
		background: var(--ink-900);
		border: 1px solid var(--ink-line);
		border-radius: var(--radius-sm);
		padding: 0.75rem;
		overflow-x: auto;
		margin: 0.5rem 0;
	}
	.text :global(code) {
		font-family: var(--font-mono);
		font-size: 0.9em;
		color: var(--paper-dim);
	}
	.text :global(p code), .text :global(li code) {
		background: var(--ink-900);
		border: 1px solid var(--ink-line);
		border-radius: 3px;
		padding: 0.1rem 0.3rem;
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