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

<div class="step" data-call={isCall}>
	<button class="head" onclick={() => (open = !open)}>
		<span class="mark">{isCall ? '▸' : '▾'}</span>
		<span class="kind">{isCall ? 'tool_call' : 'tool_result'}</span>
		<span class="name">{step.name}</span>
	</button>
	{#if open}<pre class="body">{fmt(step.data)}</pre>{/if}
</div>

<style>
	.step { font-size: 12px; margin: 0.25rem 0; }
	.head {
		display: flex; align-items: center; gap: 0.4rem; background: none; border: none;
		cursor: pointer; padding: 0.15rem 0; color: #8a97b5; font-family: inherit;
	}
	.mark { width: 0.8ch; }
	.kind { color: #6b7896; text-transform: uppercase; letter-spacing: 0.5px; }
	.name { color: #c7d0e6; font-weight: 600; }
	.step[data-call='true'] .name { color: #4f8cff; }
	.step[data-call='false'] .name { color: #22c55e; }
	.body {
		margin: 0.3rem 0 0.5rem; padding: 0.5rem; background: #0b1020; border: 1px solid #1e2740;
		border-radius: 6px; color: #b8c2d6; white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto;
	}
</style>