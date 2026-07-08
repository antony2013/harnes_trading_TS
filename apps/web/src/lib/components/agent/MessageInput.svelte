<script lang="ts">
	import { sendMessage, streaming } from '$lib/stores/agentChat';
	let text = $state('');
	function submit() {
		if (!text.trim() || $streaming) return;
		sendMessage(text);
		text = '';
	}
	function onkey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	}
</script>

<div class="input">
	<div class="fieldwrap">
		<textarea
			bind:value={text}
			onkeydown={onkey}
			rows={2}
			placeholder="Ask the desk…  (Enter = send, Shift+Enter = newline)"
		></textarea>
	</div>
	<button class="send" disabled={$streaming || !text.trim()} onclick={submit}>
		{$streaming ? '…' : 'Send'}
	</button>
</div>

<style>
	.input {
		display: flex;
		gap: 0.5rem;
		align-items: stretch;
		padding: 0.75rem 1rem 1rem;
		border-top: 1px solid var(--ink-line);
		max-width: 820px;
		margin: 0 auto;
		width: 100%;
	}
	.fieldwrap {
		flex: 1 1 auto;
		min-width: 0;
	}
	textarea {
		width: 100%;
		resize: none;
		padding: 0.6rem 0.7rem;
		background: var(--ink-900);
		border: 1px solid var(--ink-line);
		border-radius: var(--radius);
		color: var(--paper);
		font-family: var(--font-body);
		font-size: var(--t-base);
		line-height: 1.45;
		max-height: 160px;
	}
	textarea::placeholder {
		color: var(--paper-mute);
	}
	textarea:focus {
		outline: none;
		border-color: var(--saffron-line);
		box-shadow: 0 0 0 3px var(--saffron-soft);
	}
	.send {
		flex: 0 0 auto;
		padding: 0 1.1rem;
		border-radius: var(--radius);
		border: 1px solid var(--saffron);
		background: var(--saffron);
		color: #1a1208;
		font-family: var(--font-mono);
		font-size: var(--t-sm);
		font-weight: 600;
		letter-spacing: 0.4px;
		text-transform: uppercase;
		cursor: pointer;
		transition: background 0.12s ease, border-color 0.12s ease;
	}
	.send:hover:not(:disabled) {
		background: #f29638;
		border-color: #f29638;
	}
	.send:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	@media (max-width: 640px) {
		.input {
			padding: 0.6rem 0.6rem 0.8rem;
		}
	}
</style>