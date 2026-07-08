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
	<textarea bind:value={text} onkeydown={onkey} rows="2" placeholder="Ask the trading agent…  (Enter = send, Shift+Enter = newline)"></textarea>
	<button class="send" disabled={$streaming || !text.trim()} onclick={submit}>{$streaming ? '…' : 'Send'}</button>
</div>

<style>
	.input { display: flex; gap: 0.5rem; align-items: flex-end; padding: 0.75rem; border-top: 1px solid #1e2740; }
	textarea {
		flex: 1 1 auto; resize: none; padding: 0.6rem; background: #121a33; border: 1px solid #1e2740;
		border-radius: 8px; color: #e7ecf5; font: inherit; font-size: 14px; line-height: 1.4; max-height: 160px;
	}
	.send {
		padding: 0.6rem 1rem; border-radius: 8px; border: none;
		background: linear-gradient(135deg, #4f8cff, #7a5cff); color: #fff; font-size: 14px; cursor: pointer;
	}
	.send:disabled { opacity: 0.5; cursor: not-allowed; }
</style>