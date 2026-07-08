<script lang="ts">
	import type { ChatMessage } from '$lib/stores/agentChat';
	import ToolStep from './ToolStep.svelte';
	let { msg }: { msg: ChatMessage } = $props();
</script>

<div class="msg" data-role={msg.role}>
	<div class="who">{msg.role === 'user' ? 'you' : 'agent'}</div>
	<div class="body">
		{#if msg.tools && msg.tools.length}
			<div class="tools">{#each msg.tools as t, i (i)}<ToolStep step={t} />{/each}</div>
		{/if}
		{#if msg.content}
			<div class="text">{msg.content}</div>
		{:else if msg.role === 'assistant' && (!msg.tools || msg.tools.length === 0)}
			<div class="text muted">thinking…</div>
		{/if}
	</div>
</div>

<style>
	.msg { display: flex; gap: 0.75rem; padding: 0.6rem 0; }
	.who {
		flex: 0 0 3ch; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
		color: #6b7896; padding-top: 0.15rem;
	}
	.msg[data-role='user'] .who { color: #8a97b5; }
	.msg[data-role='assistant'] .who { color: #4f8cff; }
	.body { flex: 1 1 auto; min-width: 0; }
	.text { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
	.text.muted { color: #6b7896; font-style: italic; }
	.tools { margin-bottom: 0.25rem; }
</style>