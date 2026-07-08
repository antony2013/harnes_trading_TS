<script lang="ts">
	import type { ToolStep } from '$lib/stores/agentChat';
	let { step }: { step: ToolStep } = $props();
	let open = $state(false);
	const isCall = $derived(step.type === 'tool_call');
	function fmt(d: unknown): string {
		if (d == null) return '';
		if (typeof d === 'string') return d;
		try {
			return JSON.stringify(d, null, 2);
		} catch {
			return String(d);
		}
	}
</script>

<div class="ticket" data-call={isCall} data-open={open}>
	<button class="head" onclick={() => (open = !open)} aria-expanded={open}>
		<span class="mark">{isCall ? '►' : '▾'}</span>
		<span class="name">{step.name}</span>
		<span class="chip">{isCall ? 'calling' : 'done'}</span>
	</button>
	{#if open}
		<div class="inset">
			<span class="inset-label">{isCall ? 'input' : 'output'}</span>
			<pre class="inset-body">{fmt(step.data)}</pre>
		</div>
	{/if}
</div>

<style>
	.ticket {
		font-size: var(--t-xs);
		border: 1px solid var(--ink-line);
		border-radius: var(--radius-sm);
		background: var(--ink-900);
		overflow: hidden;
		max-width: 640px;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		background: none;
		border: none;
		cursor: pointer;
		padding: 0.35rem 0.55rem;
		color: var(--paper-dim);
		font-family: var(--font-mono);
		text-align: left;
	}
	.head:hover {
		background: var(--ink-800);
	}
	.mark {
		width: 0.9ch;
		color: var(--saffron);
		font-size: var(--t-2xs);
	}
	.name {
		color: var(--paper);
		font-weight: 600;
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chip {
		flex: 0 0 auto;
		font-size: var(--t-2xs);
		letter-spacing: 0.6px;
		text-transform: uppercase;
		padding: 0.1rem 0.4rem;
		border-radius: 3px;
		border: 1px solid currentColor;
	}
	.ticket[data-call='true'] .chip {
		color: var(--saffron);
		background: var(--saffron-soft);
		border-color: var(--saffron-line);
	}
	.ticket[data-call='false'] .chip {
		color: var(--up);
		background: rgba(91, 201, 122, 0.12);
		border-color: rgba(91, 201, 122, 0.4);
	}

	/* ledger-paper inset: bone ground, ink text — the printed blotter strip */
	.inset {
		border-top: 1px solid var(--ink-line);
		background: var(--paper);
		color: #2a2218;
		padding: 0.4rem 0.55rem 0.5rem;
	}
	.inset-label {
		font-family: var(--font-mono);
		font-size: 9.5px;
		letter-spacing: 0.8px;
		text-transform: uppercase;
		color: #847b6a;
		display: block;
		margin-bottom: 0.2rem;
	}
	.inset-body {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--t-xs);
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 280px;
		overflow: auto;
		font-variant-numeric: tabular-nums;
	}
</style>