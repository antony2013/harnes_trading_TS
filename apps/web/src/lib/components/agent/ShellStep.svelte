<script lang="ts">
	import type { ToolStep } from '$lib/stores/agentChat';
	import { parseShellResult } from './shellParse';

	let { step }: { step: ToolStep } = $props();
	const isCall = $derived(step.type === 'tool_call');
	const command = $derived(
		isCall ? (typeof step.data === 'object' && step.data && 'command' in (step.data as any) ? String((step.data as any).command) : '') : ''
	);
	const parsed = $derived(!isCall && typeof step.data === 'string' ? parseShellResult(step.data) : null);
	let open = $state(false);

	const exitOk = $derived(parsed?.exit === 0);
	const copied = $state(false);
	async function copyCmd() {
		try {
			await navigator.clipboard.writeText(command);
		} catch {}
	}
</script>

<div class="ticket" data-call={isCall} data-open={open}>
	<button class="head" onclick={() => (open = !open)} aria-expanded={open}>
		<span class="mark">{isCall ? '►' : '▾'}</span>
		<span class="name">shell</span>
		{#if isCall}
			<span class="chip run">running</span>
		{:else if parsed?.error}
			<span class="chip err">error</span>
		{:else if parsed && parsed.exit !== null}
			<span class="chip" data-ok={exitOk}>exit {parsed.exit}</span>
		{:else}
			<span class="chip done">done</span>
		{/if}
	</button>
	{#if open}
		<div class="inset">
			{#if isCall}
				<div class="cmdline">
					<span class="prompt">$</span>
					<code class="cmd">{command}</code>
					<button class="copy" onclick={copyCmd}>copy</button>
				</div>
			{:else if parsed}
				{#if parsed.error}
					<pre class="out err">{parsed.error}</pre>
				{:else}
					{#if parsed.warning}
						<div class="warn">⚠ {parsed.warning}</div>
					{/if}
					<pre class="out">{parsed.output}</pre>
				{/if}
			{/if}
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
	.head:hover { background: var(--ink-800); }
	.mark { width: 0.9ch; color: var(--saffron); font-size: var(--t-2xs); }
	.name { color: var(--paper); font-weight: 600; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.chip {
		flex: 0 0 auto;
		font-size: var(--t-2xs);
		letter-spacing: 0.6px;
		text-transform: uppercase;
		padding: 0.1rem 0.4rem;
		border-radius: 3px;
		border: 1px solid currentColor;
	}
	.chip.run { color: var(--saffron); background: var(--saffron-soft); border-color: var(--saffron-line); }
	.chip.done { color: var(--up); border-color: rgba(91, 201, 122, 0.4); }
	.chip.err { color: var(--down); border-color: rgba(248, 84, 106, 0.5); }
	.chip[data-ok='true'] { color: var(--up); border-color: rgba(91, 201, 122, 0.4); }
	.chip[data-ok='false'] { color: var(--down); border-color: rgba(248, 84, 106, 0.5); }
	.inset {
		border-top: 1px solid var(--ink-line);
		background: #110d08;
		color: var(--paper);
		padding: 0.5rem 0.6rem;
	}
	.cmdline {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-family: var(--font-mono);
	}
	.prompt { color: var(--saffron); }
	.cmd { color: var(--paper); white-space: pre-wrap; word-break: break-word; flex: 1 1 auto; }
	.copy {
		flex: 0 0 auto;
		background: none;
		border: 1px solid var(--ink-line);
		border-radius: 3px;
		color: var(--paper-dim);
		font-family: var(--font-mono);
		font-size: var(--t-2xs);
		padding: 0.1rem 0.35rem;
		cursor: pointer;
	}
	.out {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--t-xs);
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 280px;
		overflow: auto;
		color: var(--paper);
	}
	.out.err { color: var(--down); }
	.warn {
		font-family: var(--font-mono);
		font-size: var(--t-2xs);
		color: var(--saffron);
		margin-bottom: 0.3rem;
	}
</style>